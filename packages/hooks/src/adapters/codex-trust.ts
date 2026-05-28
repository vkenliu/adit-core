import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ADIT_CODEX_HOOK_TRUST_BLOCK = "adit-codex-hooks";
export const ADIT_CLOUD_CODEX_HOOK_TRUST_BLOCK = "adit-cloud-codex";

export interface CodexHookState {
  key: string;
  trustedHash: string;
}

interface CodexHookDefinition {
  eventName: string;
  keyLabel: string;
  matcher?: string;
}

const CODEX_HOOK_DEFINITIONS: CodexHookDefinition[] = [
  { eventName: "PostToolUse", keyLabel: "post_tool_use" },
  { eventName: "SessionStart", keyLabel: "session_start", matcher: "startup|resume" },
  { eventName: "UserPromptSubmit", keyLabel: "user_prompt_submit" },
  { eventName: "Stop", keyLabel: "stop" },
];

export function codexHookTrustMarkerForPath(hooksPath: string): string {
  const digest = createHash("sha256").update(resolve(hooksPath)).digest("hex").slice(0, 16);
  return `project=${digest}`;
}

export function resolveCodexHookTrustConfigPath(codexHome?: string): string {
  return join(codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

export function buildCodexHookStatesForEntries(input: {
  hooksPath: string;
  hooks: Record<string, unknown>;
  matchesEntry: (entry: unknown) => boolean;
}): CodexHookState[] {
  const hooksPath = resolve(input.hooksPath);
  return CODEX_HOOK_DEFINITIONS.flatMap((definition) => {
    const entries = input.hooks[definition.eventName];
    if (!Array.isArray(entries)) return [];

    const states: CodexHookState[] = [];
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = asObject(entries[entryIndex]);
      if (!entry || !input.matchesEntry(entry)) continue;
      const hookEntries = entry.hooks;
      if (!Array.isArray(hookEntries)) continue;
      for (let hookIndex = 0; hookIndex < hookEntries.length; hookIndex++) {
        const hook = asObject(hookEntries[hookIndex]);
        if (!hook || typeof hook.command !== "string") continue;
        states.push({
          key: `${hooksPath}:${definition.keyLabel}:${entryIndex}:${hookIndex}`,
          trustedHash: codexHookTrustedHash({
            eventName: definition.keyLabel,
            matcher: typeof entry.matcher === "string" ? entry.matcher : definition.matcher,
            command: hook.command,
            timeout: typeof hook.timeout === "number" ? hook.timeout : 30,
          }),
        });
      }
    }
    return states;
  });
}

export function upsertCodexHookTrustConfig(input: {
  codexHome?: string;
  blockName: string;
  marker: string;
  states: CodexHookState[];
}): void {
  const configPath = resolveCodexHookTrustConfigPath(input.codexHome);
  mkdirSync(dirname(configPath), { recursive: true });
  const current = readFile(configPath) ?? "";
  writeFileSync(
    configPath,
    appendCodexHookTrustBlock(current, input.marker, input.states, input.blockName),
  );
}

export function removeCodexHookTrustConfig(input: {
  codexHome?: string;
  blockName: string;
  marker?: string;
  states?: CodexHookState[];
}): void {
  const configPath = resolveCodexHookTrustConfigPath(input.codexHome);
  const current = readFile(configPath);
  if (current === null) return;
  const states = input.states ?? [];
  const cleaned = stripCodexHookTrustBlocks(current, {
    blockName: input.blockName,
    marker: input.marker,
    keys: states.map((state) => state.key),
    trustedHashes: states.map((state) => state.trustedHash),
  }).replace(/\s+$/u, "");
  writeFileSync(configPath, cleaned ? `${cleaned}\n` : "");
}

export function installCodexHookTrustConfig(input: {
  codexHome?: string;
  blockName: string;
  marker: string;
  states: CodexHookState[];
}): () => void {
  const codexHome = input.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const configPath = join(codexHome, "config.toml");
  const dirExisted = existsSync(codexHome);
  const fileExisted = existsSync(configPath);
  const originalContent = fileExisted ? readFile(configPath) : null;

  try {
    upsertCodexHookTrustConfig(input);
  } catch {
    return () => {};
  }

  return () => {
    try {
      const current = readFile(configPath);
      if (current === null) return;
      const cleaned = stripCodexHookTrustBlocks(current, {
        blockName: input.blockName,
        marker: input.marker,
      }).replace(/\s+$/u, "");
      if (!fileExisted && !cleaned) {
        try {
          unlinkSync(configPath);
        } catch {}
        if (!dirExisted) {
          try {
            rmdirSync(codexHome);
          } catch {}
        }
        return;
      }
      writeFileSync(configPath, `${cleaned}\n`);
    } catch {
      if (fileExisted && originalContent !== null) {
        try {
          writeFileSync(configPath, originalContent);
        } catch {}
      }
    }
  };
}

export function findUntrustedCodexHookStates(
  configText: string | null,
  states: CodexHookState[],
): CodexHookState[] {
  if (!configText) return states;
  const trusted = readTrustedHookStates(configText);
  return states.filter((state) => {
    const entry = trusted.get(state.key);
    return !entry || entry.enabled !== true || entry.trustedHash !== state.trustedHash;
  });
}

export function appendCodexHookTrustBlock(
  text: string,
  marker: string,
  states: CodexHookState[],
  blockName: string,
): string {
  const cleaned = stripCodexHookTrustBlocks(text, {
    blockName,
    marker,
    keys: states.map((state) => state.key),
    trustedHashes: states.map((state) => state.trustedHash),
  }).replace(/\s+$/u, "");
  const block = [
    `# >>> ${blockName} ${marker}`,
    ...states.flatMap((state) => [
      `[hooks.state.${JSON.stringify(state.key)}]`,
      "enabled = true",
      `trusted_hash = ${JSON.stringify(state.trustedHash)}`,
      "",
    ]),
    `# <<< ${blockName} ${marker}`,
  ].join("\n").replace(/\n+$/u, "");
  return `${cleaned ? `${cleaned}\n\n` : ""}${block}\n`;
}

export function stripCodexHookTrustBlocks(
  text: string,
  opts?: { blockName?: string; marker?: string; keys?: string[]; trustedHashes?: string[] },
): string {
  const lines = text.split(/\r?\n/u);
  const kept: string[] = [];
  const blockName = opts?.blockName ?? ADIT_CODEX_HOOK_TRUST_BLOCK;
  const startPattern = new RegExp(`^\\s*# >>> ${escapeRegExp(blockName)}\\b`, "u");
  const endPattern = new RegExp(`^\\s*# <<< ${escapeRegExp(blockName)}\\b`, "u");
  const keys = opts?.keys ?? [];
  const trustedHashes = opts?.trustedHashes ?? [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!startPattern.test(line)) {
      const stateKey = parseHookStateTableKey(line);
      if (stateKey !== null) {
        const block = [line];
        while (index + 1 < lines.length) {
          const nextLine = lines[index + 1] ?? "";
          if (
            /^\s*\[[^\]]+\]\s*$/u.test(nextLine) ||
            startPattern.test(nextLine) ||
            endPattern.test(nextLine)
          ) {
            break;
          }
          index++;
          const blockLine = lines[index] ?? "";
          block.push(blockLine);
        }
        const blockText = block.join("\n");
        const matchesKey = keys.includes(stateKey);
        const matchesTrustedHash = trustedHashes.some((hash) =>
          blockText.includes(`trusted_hash = ${JSON.stringify(hash)}`),
        );
        if (matchesKey || matchesTrustedHash) {
          continue;
        }
        kept.push(...block);
        continue;
      }
      if (opts?.marker && endPattern.test(line) && line.includes(opts.marker)) {
        continue;
      }
      kept.push(line);
      continue;
    }

    const block = [line];
    while (index + 1 < lines.length) {
      index++;
      const blockLine = lines[index] ?? "";
      block.push(blockLine);
      if (endPattern.test(blockLine)) break;
    }

    const blockText = block.join("\n");
    const matchesMarker = opts?.marker ? block.some((blockLine) => blockLine.includes(opts.marker ?? "")) : false;
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

function readTrustedHookStates(text: string): Map<string, { enabled?: boolean; trustedHash?: string }> {
  const states = new Map<string, { enabled?: boolean; trustedHash?: string }>();
  let currentKey: string | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const nextKey = parseHookStateTableKey(line);
    if (nextKey !== null) {
      currentKey = nextKey;
      states.set(currentKey, {});
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*$/u.test(line)) {
      currentKey = null;
      continue;
    }
    if (!currentKey) continue;
    const current = states.get(currentKey);
    if (!current) continue;
    if (/^\s*enabled\s*=\s*true\s*(?:#.*)?$/u.test(line)) {
      current.enabled = true;
      continue;
    }
    if (/^\s*enabled\s*=\s*false\s*(?:#.*)?$/u.test(line)) {
      current.enabled = false;
      continue;
    }
    const hashMatch = line.match(/^\s*trusted_hash\s*=\s*("(?:\\.|[^"\\])*")/u);
    if (hashMatch?.[1]) {
      try {
        const parsed = JSON.parse(hashMatch[1]);
        if (typeof parsed === "string") current.trustedHash = parsed;
      } catch {}
    }
  }
  return states;
}

function parseHookStateTableKey(line: string): string | null {
  const match = line.match(/^\s*\[hooks\.state\.("(?:\\.|[^"\\])*")\]\s*$/u);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
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

function readFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
