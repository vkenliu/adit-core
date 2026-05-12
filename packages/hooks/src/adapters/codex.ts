/**
 * OpenAI Codex platform adapter.
 *
 * Maps Codex's hook events to ADIT's internal model.
 * Supports all Codex clients: CLI, desktop App, and IDE Extension.
 * All clients share the same hooks.json format and event schema.
 * Handles installation into .codex/hooks.json.
 *
 * Key differences from Claude Code:
 * - Timeout is in **seconds** (not milliseconds)
 * - SessionStart uses matcher "startup|resume"
 * - PostToolUse uses matcher "Bash"
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Platform } from "@varveai/adit-core";
import type {
  PlatformAdapter,
  HookMapping,
  NormalizedHookInput,
  PlatformHookConfig,
  ValidationResult,
  AditHookType,
} from "./types.js";

/** Timeout for Codex hooks — in SECONDS (not ms like Claude Code) */
const HOOK_TIMEOUT = 30;

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "SessionStart", aditHandler: "session-start", matcher: "startup|resume" },
  { platformEvent: "UserPromptSubmit", aditHandler: "prompt-submit" },
  { platformEvent: "Stop", aditHandler: "stop" },
  { platformEvent: "PostToolUse", aditHandler: "notification", matcher: "Bash" },
];

const CODEX_HOOK_KEY_LABELS: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
  PostToolUse: "post_tool_use",
};

/** Map Codex CLI platform events to ADIT hook types (derived from HOOK_MAPPINGS) */
const PLATFORM_TO_ADIT: Record<string, AditHookType> = Object.fromEntries(
  HOOK_MAPPINGS.map((m) => [m.platformEvent, m.aditHandler]),
) as Record<string, AditHookType>;

/** Check if a command string is an ADIT hook (matches both npx and resolved-path formats) */
function isAditHookCommand(command: string): boolean {
  return command.includes("adit-hook") || command.includes("hooks/dist/index.js");
}

export const codexAdapter: PlatformAdapter = {
  platform: "codex" as Platform,
  displayName: "Codex",
  hookMappings: HOOK_MAPPINGS,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const aditHookType = PLATFORM_TO_ADIT[hookType] ?? (hookType as AditHookType);
    const cwd = (raw.cwd as string) ?? process.cwd();

    return {
      cwd,
      hookType: aditHookType,
      platformCli: "codex",
      platformSessionId: raw.session_id as string | undefined,
      transcriptPath: raw.transcript_path as string | undefined,
      // Prompt
      prompt: raw.prompt as string | undefined,
      // Stop
      stopReason: raw.stop_reason as string | undefined,
      lastAssistantMessage: raw.last_assistant_message as string | undefined,
      stopHookActive: raw.stop_hook_active as boolean | undefined,
      // Tool use (from PostToolUse)
      toolName: raw.tool_name as string | undefined,
      toolInput: raw.tool_input as Record<string, unknown> | undefined,
      toolOutput: raw.tool_response as Record<string, unknown> | undefined,
      // Session lifecycle
      sessionSource: raw.source as string | undefined,
      sessionEndReason: raw.reason as string | undefined,
      // Common metadata (present in all events)
      permissionMode: raw.permission_mode as string | undefined,
      model: raw.model as string | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string): PlatformHookConfig {
    const makeHookEntry = (command: string) => [
      { hooks: [{ type: "command", command: `CODEX=1 ${command}`, timeout: HOOK_TIMEOUT }] },
    ];
    const makeMatcherEntry = (matcher: string, command: string) => [
      { matcher, hooks: [{ type: "command", command: `CODEX=1 ${command}`, timeout: HOOK_TIMEOUT }] },
    ];

    return {
      configPath: ".codex/hooks.json",
      content: {
        hooks: {
          SessionStart: makeMatcherEntry("startup|resume", `${aditBinaryPath} session-start`),
          UserPromptSubmit: makeHookEntry(`${aditBinaryPath} prompt-submit`),
          Stop: makeHookEntry(`${aditBinaryPath} stop`),
          PostToolUse: makeMatcherEntry("Bash", `${aditBinaryPath} notification`),
        },
      },
    };
  },

  async validateInstallation(projectRoot: string): Promise<ValidationResult> {
    const checks = [];

    // Check .codex directory exists
    const codexDir = join(projectRoot, ".codex");
    const codexDirExists = existsSync(codexDir);
    checks.push({
      name: ".codex directory",
      ok: codexDirExists,
      detail: codexDirExists ? codexDir : "Not found",
    });

    // Check hooks file for hook configuration
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    let hooksFound = false;
    let hooksDetail = "No hook configuration found";
    const requiredHooks = HOOK_MAPPINGS.map((m) => m.platformEvent);
    const missingHooks: string[] = [];

    if (existsSync(hooksPath)) {
      try {
        const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
        if (!hooksConfig.hooks) {
          hooksDetail = "No hooks section found in hooks.json";
        } else {
          for (const hookName of requiredHooks) {
            const entries = hooksConfig.hooks[hookName];
            if (!Array.isArray(entries)) {
              missingHooks.push(hookName);
              continue;
            }
            const hasAdit = entries.some(
              (entry: { command?: string; hooks?: Array<{ command?: string }> }) => {
                if (typeof entry.command === "string" && isAditHookCommand(entry.command)) return true;
                if (Array.isArray(entry.hooks)) {
                  return entry.hooks.some((h) => typeof h.command === "string" && isAditHookCommand(h.command));
                }
                return false;
              },
            );
            if (!hasAdit) missingHooks.push(hookName);
          }

          hooksFound = missingHooks.length === 0;
          hooksDetail = hooksFound
            ? `All hooks registered in ${hooksPath}`
            : `Missing hooks: ${missingHooks.join(", ")}`;
        }
      } catch {
        hooksDetail = `Failed to parse ${hooksPath}`;
      }
    }

    checks.push({
      name: "Hook configuration",
      ok: hooksFound,
      detail: hooksDetail,
    });

    const configPath = join(projectRoot, ".codex", "config.toml");
    const projectConfig = readTextFile(configPath);
    const featureEnabled = projectConfig !== null && hasTomlBooleanFeature(projectConfig, "hooks");
    checks.push({
      name: "Codex hooks feature",
      ok: featureEnabled,
      detail: featureEnabled ? `Enabled in ${configPath}` : "Missing [features] hooks = true",
    });

    let trustOk = false;
    let trustDetail = "No trusted ADIT hook commands found";
    if (existsSync(hooksPath)) {
      try {
        const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
        const states = buildCodexHookStates(hooksPath, hooksConfig.hooks as Record<string, unknown[]>);
        const userConfigPath = getCodexUserConfigPath();
        const userConfig = readTextFile(userConfigPath);
        const missingStates = userConfig === null
          ? states.map((state) => state.key)
          : states.filter((state) => !hasTrustedHookState(userConfig, state)).map((state) => state.key);
        trustOk = states.length > 0 && missingStates.length === 0;
        trustDetail = trustOk
          ? `Trusted in ${userConfigPath}`
          : `Missing trusted hook state${missingStates.length > 1 ? "s" : ""} in ${userConfigPath}`;
      } catch {
        trustDetail = "Failed to validate Codex trusted hook state";
      }
    }
    checks.push({
      name: "Codex hook trust",
      ok: trustOk,
      detail: trustDetail,
    });

    return {
      valid: checks.every((c) => c.ok),
      checks,
    };
  },

  async installHooks(projectRoot: string, aditBinaryPath: string): Promise<void> {
    const codexDir = join(projectRoot, ".codex");
    if (!existsSync(codexDir)) {
      mkdirSync(codexDir, { recursive: true });
    }

    const hooksPath = join(codexDir, "hooks.json");
    let hooksConfig: Record<string, unknown> = {};

    if (existsSync(hooksPath)) {
      try {
        hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
      } catch {
        // Start fresh if hooks are invalid
      }
    }

    const hookConfig = this.generateHookConfig(aditBinaryPath);
    const existingHooks = (hooksConfig.hooks as Record<string, unknown[]>) ?? {};
    const newHooks = hookConfig.content.hooks as Record<string, unknown[]>;

    // Merge hook entries per event key: preserve other tools' hooks,
    // remove stale ADIT entries, then append new ADIT entries.
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };
    for (const [eventKey, aditEntries] of Object.entries(newHooks)) {
      const existing = Array.isArray(mergedHooks[eventKey]) ? mergedHooks[eventKey] : [];

      // Remove stale ADIT entries (same logic as uninstallHooks)
      const nonAditEntries = existing.filter(
        (raw) => {
          const entry = raw as { command?: string; hooks?: Array<{ command?: string }> };
          if (typeof entry.command === "string" && isAditHookCommand(entry.command)) return false;
          if (Array.isArray(entry.hooks)) {
            return !entry.hooks.some(
              (h) => typeof h.command === "string" && isAditHookCommand(h.command),
            );
          }
          return true;
        },
      );

      // Append new ADIT entries after other tools' hooks
      mergedHooks[eventKey] = [...nonAditEntries, ...aditEntries];
    }

    hooksConfig.hooks = mergedHooks;
    writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");

    const configPath = join(codexDir, "config.toml");
    writeFileSync(configPath, enableCodexHooksFeature(readTextFile(configPath) ?? ""));
    installCodexHookTrustConfig(hooksPath, mergedHooks);
  },

  getResumeCommand(_projectRoot: string): string | null {
    return "codex --continue";
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    if (!existsSync(hooksPath)) return;

    try {
      const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
      if (!hooksConfig.hooks) return;

      // Remove ADIT hook entries
      for (const hookName of Object.keys(hooksConfig.hooks)) {
        const entries = hooksConfig.hooks[hookName];
        if (!Array.isArray(entries)) continue;

        hooksConfig.hooks[hookName] = entries.filter(
          (entry: { command?: string; hooks?: Array<{ command?: string }> }) => {
            if (typeof entry.command === "string" && isAditHookCommand(entry.command)) return false;
            if (Array.isArray(entry.hooks)) {
              return !entry.hooks.some((h) => typeof h.command === "string" && isAditHookCommand(h.command));
            }
            return true;
          },
        );

        // Clean up empty arrays
        if (hooksConfig.hooks[hookName].length === 0) {
          delete hooksConfig.hooks[hookName];
        }
      }

      // Clean up empty hooks object
      if (Object.keys(hooksConfig.hooks).length === 0) {
        delete hooksConfig.hooks;
      }

      writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2) + "\n");
      uninstallCodexHookTrustConfig(hooksPath);
    } catch {
      // Ignore parse errors
    }
  },
};

interface CodexHookState {
  key: string;
  trustedHash: string;
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
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

function hasTomlBooleanFeature(text: string, key: string): boolean {
  const lines = text.split(/\r?\n/u);
  let inFeatures = false;
  for (const line of lines) {
    if (/^\s*\[features\]\s*$/u.test(line)) {
      inFeatures = true;
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*$/u.test(line)) {
      inFeatures = false;
      continue;
    }
    if (inFeatures && new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*true\\s*(?:#.*)?$`, "u").test(line)) {
      return true;
    }
  }
  return false;
}

function buildCodexHookStates(hooksPath: string, hooks: Record<string, unknown[]> | undefined): CodexHookState[] {
  if (!hooks || typeof hooks !== "object") return [];
  const absoluteHooksPath = resolve(hooksPath);
  const states: CodexHookState[] = [];

  for (const mapping of HOOK_MAPPINGS) {
    const entries = hooks[mapping.platformEvent];
    if (!Array.isArray(entries)) continue;
    const keyLabel = CODEX_HOOK_KEY_LABELS[mapping.platformEvent];
    if (!keyLabel) continue;

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const entryRecord = entry as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(entryRecord.hooks)) continue;

      for (let hookIndex = 0; hookIndex < entryRecord.hooks.length; hookIndex++) {
        const hook = entryRecord.hooks[hookIndex];
        if (!hook || typeof hook !== "object" || Array.isArray(hook)) continue;
        const hookRecord = hook as { command?: unknown; timeout?: unknown };
        if (typeof hookRecord.command !== "string" || !isAditHookCommand(hookRecord.command)) continue;
        const timeout = typeof hookRecord.timeout === "number" ? hookRecord.timeout : HOOK_TIMEOUT;
        const matcher = typeof entryRecord.matcher === "string" ? entryRecord.matcher : undefined;
        states.push({
          key: `${absoluteHooksPath}:${keyLabel}:${entryIndex}:${hookIndex}`,
          trustedHash: codexHookTrustedHash({
            eventName: keyLabel,
            matcher,
            command: hookRecord.command,
            timeout,
          }),
        });
      }
    }
  }

  return states;
}

function getCodexUserConfigPath(): string {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

function installCodexHookTrustConfig(
  hooksPath: string,
  hooks: Record<string, unknown[]>,
): void {
  const states = buildCodexHookStates(hooksPath, hooks);
  if (states.length === 0) return;

  const configPath = getCodexUserConfigPath();
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    const current = readTextFile(configPath) ?? "";
    writeFileSync(configPath, appendCodexHookTrustBlock(current, codexTrustMarker(hooksPath), states));
  } catch {
    // Fail-open: hooks can still prompt for trust if the user config cannot be updated.
  }
}

function uninstallCodexHookTrustConfig(hooksPath: string): void {
  const configPath = getCodexUserConfigPath();
  try {
    const current = readTextFile(configPath);
    if (current === null) return;
    writeFileSync(
      configPath,
      `${stripAditCodexHookTrustBlocks(current, { marker: codexTrustMarker(hooksPath) }).replace(/\s+$/u, "")}\n`,
    );
  } catch {
    // Fail-open.
  }
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
    `# >>> adit-codex-hooks ${marker}`,
    ...states.flatMap((state) => [
      `[hooks.state.${JSON.stringify(state.key)}]`,
      "enabled = true",
      `trusted_hash = ${JSON.stringify(state.trustedHash)}`,
      "",
    ]),
    `# <<< adit-codex-hooks ${marker}`,
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
    if (!/^\s*# >>> adit-codex-hooks\b/u.test(line)) {
      kept.push(line);
      continue;
    }

    const block = [line];
    while (index + 1 < lines.length) {
      index++;
      const blockLine = lines[index] ?? "";
      block.push(blockLine);
      if (/^\s*# <<< adit-codex-hooks\b/u.test(blockLine)) break;
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

function hasTrustedHookState(text: string, state: CodexHookState): boolean {
  const escapedKey = escapeRegExp(JSON.stringify(state.key));
  const blockPattern = new RegExp(
    `\\[hooks\\.state\\.${escapedKey}\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)`,
    "u",
  );
  const match = text.match(blockPattern);
  if (!match) return false;
  const block = match[1] ?? "";
  return /^\s*enabled\s*=\s*true\s*$/mu.test(block)
    && new RegExp(`^\\s*trusted_hash\\s*=\\s*${escapeRegExp(JSON.stringify(state.trustedHash))}\\s*$`, "mu").test(block);
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

function codexTrustMarker(hooksPath: string): string {
  return createHash("sha256").update(resolve(hooksPath)).digest("hex").slice(0, 16);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
