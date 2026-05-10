import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionEnd",
] as const;

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
  const command = `curl -sS --fail --max-time 3 -X POST -H 'content-type: application/json' --data-binary @- '${opts.endpoint}?${opts.marker}' >/dev/null || true`;

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

export function installCodexHooks(opts: {
  cwd: string;
  endpoint: string;
  marker: string;
  codexHome?: string;
}): InstalledHooks {
  const codexDir = path.join(opts.cwd, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const configPath = path.join(codexDir, "config.toml");
  const command = `curl -sS --fail --max-time 3 -X POST -H 'content-type: application/json' --data-binary @- '${opts.endpoint}?${opts.marker}' >/dev/null || true`;
  const hookStates = buildCodexHookStates({
    hooksPath,
    command,
  });
  const userConfigCleanup = installCodexHookTrustConfig({
    codexHome: opts.codexHome,
    marker: opts.marker,
    states: hookStates,
  });

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

  fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + "\n");
  fs.writeFileSync(configPath, enableCodexHooksFeature(originalConfigContent ?? ""));

  return {
    settingsPath: hooksPath,
    cleanup: () => {
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
        restoreCodexConfig({
          configPath,
          codexDir,
          dirExisted,
          configFileExisted,
          originalConfigContent,
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

interface CodexHookState {
  key: string;
  trustedHash: string;
}

function buildCodexHookStates(input: {
  hooksPath: string;
  command: string;
}): CodexHookState[] {
  const hooksPath = path.resolve(input.hooksPath);
  const definitions = [
    { eventName: "PostToolUse", keyLabel: "post_tool_use" },
    { eventName: "SessionStart", keyLabel: "session_start", matcher: "startup|resume" },
    { eventName: "UserPromptSubmit", keyLabel: "user_prompt_submit" },
    { eventName: "Stop", keyLabel: "stop" },
  ];

  return definitions.map((definition) => {
    const key = `${hooksPath}:${definition.keyLabel}:0:0`;
    const trustedHash = codexHookTrustedHash({
      eventName: definition.keyLabel,
      matcher: definition.matcher,
      command: input.command,
      timeout: 30,
    });
    return { key, trustedHash };
  });
}

function installCodexHookTrustConfig(input: {
  codexHome?: string;
  marker: string;
  states: CodexHookState[];
}): () => void {
  const codexHome = input.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const dirExisted = fs.existsSync(codexHome);
  const fileExisted = fs.existsSync(configPath);
  const originalContent = fileExisted ? readFile(configPath) : null;

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    const current = readFile(configPath) ?? "";
    fs.writeFileSync(
      configPath,
      appendCodexHookTrustBlock(current, input.marker, input.states),
    );
  } catch {
    return () => {};
  }

  return () => {
    try {
      const current = readFile(configPath);
      if (current === null) return;
      const cleaned = stripAditCodexHookTrustBlocks(current, {
        marker: input.marker,
      }).replace(/\s+$/u, "");
      if (!fileExisted && !cleaned) {
        try {
          fs.unlinkSync(configPath);
        } catch {}
        if (!dirExisted) {
          try {
            fs.rmdirSync(codexHome);
          } catch {}
        }
        return;
      }
      fs.writeFileSync(configPath, `${cleaned}\n`);
    } catch {
      if (fileExisted && originalContent !== null) {
        try {
          fs.writeFileSync(configPath, originalContent);
        } catch {}
      }
    }
  };
}

function appendCodexHookTrustBlock(
  text: string,
  marker: string,
  states: CodexHookState[],
): string {
  const cleaned = stripAditCodexHookTrustBlocks(text, {
    marker,
    keys: states.map((state) => state.key),
  }).replace(/\s+$/u, "");
  const block = [
    `# >>> adit-cloud-codex ${marker}`,
    ...states.flatMap((state) => [
      `[hooks.state.${JSON.stringify(state.key)}]`,
      "enabled = true",
      `trusted_hash = ${JSON.stringify(state.trustedHash)}`,
      "",
    ]),
    `# <<< adit-cloud-codex ${marker}`,
  ].join("\n").replace(/\n+$/u, "");
  return `${cleaned ? `${cleaned}\n\n` : ""}${block}\n`;
}

function stripAditCodexHookTrustBlocks(
  text: string,
  opts?: { marker?: string; keys?: string[] },
): string {
  const lines = text.split(/\r?\n/u);
  const kept: string[] = [];
  const keys = opts?.keys ?? [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!/^\s*# >>> adit-cloud-codex\b/u.test(line)) {
      kept.push(line);
      continue;
    }

    const block = [line];
    while (index + 1 < lines.length) {
      index++;
      const blockLine = lines[index] ?? "";
      block.push(blockLine);
      if (/^\s*# <<< adit-cloud-codex\b/u.test(blockLine)) break;
    }

    const blockText = block.join("\n");
    const matchesMarker = opts?.marker ? block[0]?.includes(opts.marker) : false;
    const matchesKey = keys.some((key) => blockText.includes(JSON.stringify(key)));
    const stripBlock = matchesMarker || matchesKey || (!opts?.marker && keys.length === 0);
    if (stripBlock) {
      continue;
    }
    kept.push(...block);
  }
  return kept.join("\n");
}

function codexHookTrustedHash(input: {
  eventName: string;
  matcher?: string;
  command: string;
  timeout: number;
}): string {
  const identity: Record<string, unknown> = {
    event_name: input.eventName,
    hooks: [{
      async: false,
      command: input.command,
      timeout: input.timeout,
      type: "command",
    }],
  };
  if (input.matcher) identity.matcher = input.matcher;
  const canonical = JSON.stringify(canonicalJson(identity));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
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

function restoreCodexConfig(opts: {
  configPath: string;
  codexDir: string;
  dirExisted: boolean;
  configFileExisted: boolean;
  originalConfigContent: string | null;
}): void {
  if (opts.configFileExisted && opts.originalConfigContent !== null) {
    try {
      fs.writeFileSync(opts.configPath, opts.originalConfigContent);
    } catch {}
    return;
  }

  try {
    fs.unlinkSync(opts.configPath);
  } catch {}
  if (!opts.dirExisted) {
    try {
      fs.rmdirSync(opts.codexDir);
    } catch {}
  }
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
