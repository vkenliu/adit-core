import fs from "node:fs";
import path from "node:path";
import { connect } from "node:net";
import {
  ADIT_CLOUD_CODEX_HOOK_TRUST_BLOCK,
  buildCodexHookStatesForEntries,
  claudeCodeAdapter,
  codexAdapter,
  installCodexHookTrustConfig,
  resolveAditHookBinary,
} from "@varveai/adit-hooks/adapters";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;

const HOOK_POST_SCRIPT = [
  "try{",
  "const u=new URL(process.argv[1]);",
  "const m=u.protocol==='https:'?require('https'):require('http');",
  "let d='';",
  "let done=false;",
  "const finish=()=>{if(done)return;done=true;process.exit(0)};",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data',c=>{d+=c});",
  "process.stdin.on('end',()=>{try{",
  "const r=m.request(u,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(d)},timeout:3000},res=>{res.resume();res.on('end',finish)});",
  "r.on('timeout',()=>{r.destroy();finish()});",
  "r.on('error',finish);",
  "r.end(d)",
  "}catch{finish()}});",
  "setTimeout(finish,3500).unref();",
  "}catch{process.exit(0)}",
].join("");

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

interface CodexHookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface InstalledHooks {
  settingsPath: string;
  cleanup: () => void;
}

export async function ensurePersistentCodexHooksInstalled(opts: {
  cwd: string;
  aditHookBinary?: string;
}): Promise<boolean> {
  const validation = await codexAdapter.validateInstallation(opts.cwd);
  if (validation.valid) return false;

  await codexAdapter.installHooks(
    opts.cwd,
    opts.aditHookBinary ?? resolveAditHookBinary(),
  );
  return true;
}

export async function ensurePersistentClaudeHooksInstalled(opts: {
  cwd: string;
  aditHookBinary?: string;
}): Promise<boolean> {
  const validation = await claudeCodeAdapter.validateInstallation(opts.cwd);
  if (validation.valid) return false;

  await claudeCodeAdapter.installHooks(
    opts.cwd,
    opts.aditHookBinary ?? resolveAditHookBinary(),
  );
  return true;
}

export async function cleanupStaleClaudeCloudSettings(opts: {
  cwd: string;
  maxAgeMs?: number;
  portProbeTimeoutMs?: number;
  isPortActive?: (port: number) => Promise<boolean>;
}): Promise<string[]> {
  const claudeDir = path.join(opts.cwd, ".claude");
  if (!fs.existsSync(claudeDir)) return [];

  const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = Date.now();
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(claudeDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/^adit-cloud-.+\.settings\.local\.json$/u.test(entry.name)) {
      continue;
    }

    const settingsPath = path.join(claudeDir, entry.name);
    const shouldRemove = await shouldRemoveClaudeCloudSettings({
      settingsPath,
      maxAgeMs,
      now,
      portProbeTimeoutMs: opts.portProbeTimeoutMs,
      isPortActive: opts.isPortActive,
    });
    if (!shouldRemove) continue;

    try {
      fs.unlinkSync(settingsPath);
      removed.push(settingsPath);
    } catch {}
  }

  return removed;
}

export function installClaudeHooks(opts: {
  cwd: string;
  endpoint: string;
  marker: string;
  settingsPath?: string;
}): InstalledHooks {
  const claudeDir = path.join(opts.cwd, ".claude");
  const baseSettingsPath = path.join(claudeDir, "settings.local.json");
  const settingsPath = opts.settingsPath ?? baseSettingsPath;
  const managedSettingsFile = settingsPath !== baseSettingsPath;
  const command = buildCloudHookCommand(opts.endpoint, opts.marker);

  const dirExisted = fs.existsSync(claudeDir);
  const fileExisted = fs.existsSync(settingsPath);
  fs.mkdirSync(claudeDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  const sourceSettingsPath = managedSettingsFile ? baseSettingsPath : settingsPath;
  if (fs.existsSync(sourceSettingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourceSettingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const hooks = (existing.hooks ??= {}) as Record<string, unknown>;
  for (const eventName of EVENTS) {
    const arr = Array.isArray(hooks[eventName])
      ? hooks[eventName] as Array<Record<string, unknown>>
      : [];
    const filtered = arr.filter((entry) => {
      const inner = entry.hooks;
      return !(
        Array.isArray(inner) &&
        inner.some((hook: HookCommand) =>
          typeof hook?.command === "string" &&
          hook.command.includes(opts.marker)
        )
      );
    });
    filtered.push({ hooks: [{ type: "command", command, timeout: 5000 }] });
    hooks[eventName] = filtered;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");

  return {
    settingsPath,
    cleanup: () => {
      if (managedSettingsFile) {
        try {
          fs.unlinkSync(settingsPath);
        } catch {}
        return;
      }

      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        if (parsed?.hooks && typeof parsed.hooks === "object") {
          for (const eventName of Object.keys(parsed.hooks)) {
            if (!Array.isArray(parsed.hooks[eventName])) continue;
            parsed.hooks[eventName] = parsed.hooks[eventName].filter(
              (entry: Record<string, unknown>) => {
                const inner = entry.hooks;
                return !(
                  Array.isArray(inner) &&
                  inner.some((hook: HookCommand) =>
                    typeof hook?.command === "string" &&
                    hook.command.includes(opts.marker)
                  )
                );
              },
            );
            if (parsed.hooks[eventName].length === 0) {
              delete parsed.hooks[eventName];
            }
          }
          if (Object.keys(parsed.hooks).length === 0) delete parsed.hooks;
        }

        if (Object.keys(parsed).length === 0 && !fileExisted) {
          try {
            fs.unlinkSync(settingsPath);
          } catch {}
          if (!dirExisted) {
            try {
              fs.rmdirSync(claudeDir);
            } catch {}
          }
          return;
        }

        fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
      } catch {
        // Leave user settings untouched on parse or filesystem failures.
      }
    },
  };
}

async function shouldRemoveClaudeCloudSettings(opts: {
  settingsPath: string;
  maxAgeMs: number;
  now: number;
  portProbeTimeoutMs?: number;
  isPortActive?: (port: number) => Promise<boolean>;
}): Promise<boolean> {
  const port = readClaudeCloudHookPort(opts.settingsPath);
  if (port !== null) {
    try {
      const isActive = opts.isPortActive
        ? await opts.isPortActive(port)
        : await isLocalPortListening(port, opts.portProbeTimeoutMs ?? 150);
      return !isActive;
    } catch {
      return false;
    }
  }

  try {
    const stat = fs.statSync(opts.settingsPath);
    return opts.now - stat.mtimeMs > opts.maxAgeMs;
  } catch {
    return false;
  }
}

function readClaudeCloudHookPort(settingsPath: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }

  const root = asObject(parsed);
  if (!root) return null;
  const hooks = asObject(root.hooks);
  if (!hooks) return null;
  for (const eventHooks of Object.values(hooks)) {
    if (!Array.isArray(eventHooks)) continue;
    for (const entry of eventHooks) {
      const entryObject = asObject(entry);
      if (!entryObject) continue;
      const hookEntries = entryObject.hooks;
      if (!Array.isArray(hookEntries)) continue;
      for (const hook of hookEntries) {
        const hookObject = asObject(hook);
        if (!hookObject) continue;
        const command = hookObject.command;
        if (typeof command !== "string") continue;
        const match = command.match(/https?:\/\/127\.0\.0\.1:(\d+)\/hook\?from=adit-cloud-cli-\d+\b/u);
        if (!match?.[1]) continue;
        const port = Number.parseInt(match[1], 10);
        if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
      }
    }
  }

  return null;
}

function isLocalPortListening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (active: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
}

export function installCodexHooks(opts: {
  cwd: string;
  endpoint: string;
  marker: string;
  codexHome?: string;
}): InstalledHooks {
  const codexDir = path.join(opts.cwd, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const configPath = path.join(codexDir, "config.toml");
  const command = buildCloudHookCommand(opts.endpoint, opts.marker);
  const dirExisted = fs.existsSync(codexDir);
  const fileExisted = fs.existsSync(hooksPath);
  const originalContent = fileExisted ? readFile(hooksPath) : null;
  const configFileExisted = fs.existsSync(configPath);
  const originalConfigContent = configFileExisted ? readFile(configPath) : null;
  fs.mkdirSync(codexDir, { recursive: true });

  const existing = parseObject(originalContent) ?? {};
  const hooks = asObject(existing.hooks) ?? {};
  existing.hooks = hooks;

  setCodexHook(hooks, "SessionStart", {
    matcher: "startup|resume",
    hooks: [{ type: "command", command, timeout: 30 }],
  }, opts.marker);
  setCodexHook(hooks, "UserPromptSubmit", {
    hooks: [{ type: "command", command, timeout: 30 }],
  }, opts.marker);
  setCodexHook(hooks, "Stop", {
    hooks: [{ type: "command", command, timeout: 30 }],
  }, opts.marker);
  setCodexHook(hooks, "PostToolUse", {
    hooks: [{ type: "command", command, timeout: 30 }],
  }, opts.marker);

  const hookStates = buildCodexHookStatesForEntries({
    hooksPath,
    hooks,
    matchesEntry: (entry) => codexEntryHasMarker(entry, opts.marker),
  });
  const userConfigCleanup = installCodexHookTrustConfig({
    codexHome: opts.codexHome,
    blockName: ADIT_CLOUD_CODEX_HOOK_TRUST_BLOCK,
    marker: opts.marker,
    states: hookStates,
  });

  fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + "\n");
  const installedConfigContent = enableCodexHooksFeature(readFile(configPath) ?? "");
  fs.writeFileSync(configPath, installedConfigContent);
  const installedConfigMtimeMs = readFileMtimeMs(configPath);

  return {
    settingsPath: hooksPath,
    cleanup: () => {
      let hookConfigChangedByOthers = false;
      try {
        const current = parseObject(readFile(hooksPath));
        if (!current) {
          restoreCodexHooks({ hooksPath, codexDir, dirExisted, fileExisted, originalContent });
        } else {
          const currentHooks = asObject(current.hooks);
          if (currentHooks) {
            for (const eventName of Object.keys(currentHooks)) {
              if (!Array.isArray(currentHooks[eventName])) continue;
              currentHooks[eventName] = (currentHooks[eventName] as unknown[]).filter(
                (entry) => !codexEntryHasMarker(entry, opts.marker),
              );
              if ((currentHooks[eventName] as unknown[]).length === 0) {
                delete currentHooks[eventName];
              }
            }
            if (Object.keys(currentHooks).length === 0) delete current.hooks;
          }
          hookConfigChangedByOthers = !sameJsonObject(
            stripCloudCodexHookEntries(parseObject(originalContent) ?? {}),
            stripCloudCodexHookEntries(current),
          );

          if (Object.keys(current).length === 0 && !fileExisted) {
            try {
              fs.unlinkSync(hooksPath);
            } catch {}
            if (!dirExisted) {
              try {
                fs.rmdirSync(codexDir);
              } catch {}
            }
          } else {
            fs.writeFileSync(hooksPath, JSON.stringify(current, null, 2) + "\n");
          }
        }
      } catch {
        restoreCodexHooks({ hooksPath, codexDir, dirExisted, fileExisted, originalContent });
      } finally {
        userConfigCleanup();
        cleanupCodexConfig({
          configPath,
          codexDir,
          dirExisted,
          configFileExisted,
          originalConfigContent,
          installedConfigContent,
          installedConfigMtimeMs,
          hookConfigChangedByOthers,
        });
      }
    },
  };
}

function setCodexHook(
  hooks: Record<string, unknown>,
  eventName: string,
  entry: CodexHookEntry,
  marker: string,
): void {
  const existing = Array.isArray(hooks[eventName]) ? hooks[eventName] as unknown[] : [];
  hooks[eventName] = [
    ...existing.filter((item) => !codexEntryHasMarker(item, marker)),
    entry,
  ];
}

function buildCloudHookCommand(endpoint: string, marker: string): string {
  return [
    "node",
    "-e",
    quoteHookCommandArg(HOOK_POST_SCRIPT),
    quoteHookCommandArg(`${endpoint}?${marker}`),
  ].join(" ");
}

function quoteHookCommandArg(value: string): string {
  if (value.includes("\"")) {
    throw new Error("Hook command arguments cannot contain double quotes");
  }
  return `"${value}"`;
}

function codexEntryHasMarker(entry: unknown, marker: string): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) =>
    hook &&
    typeof hook === "object" &&
    !Array.isArray(hook) &&
    typeof (hook as HookCommand).command === "string" &&
    ((hook as HookCommand).command?.includes(marker) ||
      (hook as HookCommand).command?.includes("from=adit-cloud-codex-"))
  );
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return null;
  }
}

function enableTomlBooleanFeature(text: string, key: string): string {
  const lines = text ? text.replace(/\s+$/u, "").split(/\r?\n/u) : [];
  const featureHeaderIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/u.test(line));
  if (featureHeaderIndex < 0) {
    if (lines.length > 0) lines.push("");
    lines.push("[features]", `${key} = true`);
    return `${lines.join("\n")}\n`;
  }

  let insertIndex = lines.length;
  for (let index = featureHeaderIndex + 1; index < lines.length; index++) {
    if (/^\s*\[[^\]]+\]\s*$/u.test(lines[index] ?? "")) {
      insertIndex = index;
      break;
    }
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u").test(lines[index] ?? "")) {
      lines[index] = `${key} = true`;
      return `${lines.join("\n")}\n`;
    }
  }

  lines.splice(insertIndex, 0, `${key} = true`);
  return `${lines.join("\n")}\n`;
}

function enableCodexHooksFeature(text: string): string {
  const cleaned = text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*codex_hooks\s*=/u.test(line))
    .join("\n")
    .replace(/\s+$/u, "");
  return enableTomlBooleanFeature(cleaned, "hooks");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalJson(record[key])]),
  );
}

function cleanupCodexConfig(opts: {
  configPath: string;
  codexDir: string;
  dirExisted: boolean;
  configFileExisted: boolean;
  originalConfigContent: string | null;
  installedConfigContent: string;
  installedConfigMtimeMs: number | null;
  hookConfigChangedByOthers: boolean;
}): void {
  const current = readFile(opts.configPath);
  if (current === null || current !== opts.installedConfigContent) {
    return;
  }
  const currentMtimeMs = readFileMtimeMs(opts.configPath);
  if (
    opts.installedConfigMtimeMs !== null &&
    currentMtimeMs !== null &&
    currentMtimeMs !== opts.installedConfigMtimeMs
  ) {
    return;
  }
  if (opts.hookConfigChangedByOthers) {
    return;
  }

  if (opts.configFileExisted && opts.originalConfigContent !== null) {
    try {
      fs.writeFileSync(opts.configPath, opts.originalConfigContent);
    } catch {}
    return;
  }

  if (!opts.configFileExisted && isOnlyCodexHooksFeatureConfig(current)) {
    try {
      fs.unlinkSync(opts.configPath);
    } catch {}
  }
  if (!opts.dirExisted) {
    try {
      fs.rmdirSync(opts.codexDir);
    } catch {}
  }
}

function isOnlyCodexHooksFeatureConfig(text: string): boolean {
  const normalized = text.replace(/\s+$/u, "");
  return normalized === "[features]\nhooks = true";
}

function stripCloudCodexHookEntries(input: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...input };
  const hooks = asObject(next.hooks);
  if (!hooks) return next;

  const nextHooks: Record<string, unknown> = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      nextHooks[eventName] = entries;
      continue;
    }
    const filtered = entries.filter((entry) => !codexEntryHasMarker(entry, "from=adit-cloud-codex-"));
    if (filtered.length > 0) {
      nextHooks[eventName] = filtered;
    }
  }

  if (Object.keys(nextHooks).length > 0) {
    next.hooks = nextHooks;
  } else {
    delete next.hooks;
  }
  return next;
}

function sameJsonObject(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function restoreCodexHooks(input: {
  hooksPath: string;
  codexDir: string;
  dirExisted: boolean;
  fileExisted: boolean;
  originalContent: string | null;
}): void {
  try {
    if (input.fileExisted && input.originalContent !== null) {
      fs.writeFileSync(input.hooksPath, input.originalContent);
      return;
    }
    try {
      fs.unlinkSync(input.hooksPath);
    } catch {}
    if (!input.dirExisted) {
      try {
        fs.rmdirSync(input.codexDir);
      } catch {}
    }
  } catch {
    // Hook cleanup must never make the main relay crash on shutdown.
  }
}
