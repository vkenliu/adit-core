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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "@varveai/adit-core";
import type {
  PlatformAdapter,
  HookMapping,
  NormalizedHookInput,
  PlatformHookConfig,
  ValidationResult,
  AditHookType,
} from "./types.js";
import { buildAditHookCommand, isAditHookCommand } from "./command.js";
import {
  ADIT_CODEX_HOOK_TRUST_BLOCK,
  buildCodexHookStatesForEntries,
  codexHookTrustMarkerForPath,
  findUntrustedCodexHookStates,
  removeCodexHookTrustConfig,
  resolveCodexHookTrustConfigPath,
  upsertCodexHookTrustConfig,
} from "./codex-trust.js";

/** Timeout for Codex hooks — in SECONDS (not ms like Claude Code) */
const HOOK_TIMEOUT = 30;

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "SessionStart", aditHandler: "session-start", matcher: "startup|resume" },
  { platformEvent: "UserPromptSubmit", aditHandler: "prompt-submit" },
  { platformEvent: "Stop", aditHandler: "stop" },
  { platformEvent: "PostToolUse", aditHandler: "notification", matcher: "Bash" },
];

/** Map Codex CLI platform events to ADIT hook types (derived from HOOK_MAPPINGS) */
const PLATFORM_TO_ADIT: Record<string, AditHookType> = Object.fromEntries(
  HOOK_MAPPINGS.map((m) => [m.platformEvent, m.aditHandler]),
) as Record<string, AditHookType>;

function readStringField(
  raw: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function readObjectField(
  raw: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
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
      toolName: readStringField(raw, "tool_name", "toolName", "tool", "name"),
      toolInput: readObjectField(raw, "tool_input", "toolInput", "input"),
      toolOutput: readObjectField(
        raw,
        "tool_response",
        "toolResponse",
        "tool_output",
        "toolOutput",
        "output",
      ),
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
    const makeHookEntry = (hookType: AditHookType) => [
      {
        hooks: [{
          type: "command",
          command: buildAditHookCommand(aditBinaryPath, "codex", hookType),
          timeout: HOOK_TIMEOUT,
        }],
      },
    ];
    const makeMatcherEntry = (matcher: string, hookType: AditHookType) => [
      {
        matcher,
        hooks: [{
          type: "command",
          command: buildAditHookCommand(aditBinaryPath, "codex", hookType),
          timeout: HOOK_TIMEOUT,
        }],
      },
    ];

    return {
      configPath: ".codex/hooks.json",
      content: {
        hooks: {
          SessionStart: makeMatcherEntry("startup|resume", "session-start"),
          UserPromptSubmit: makeHookEntry("prompt-submit"),
          Stop: makeHookEntry("stop"),
          PostToolUse: makeMatcherEntry("Bash", "notification"),
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

    const trustConfigPath = resolveCodexHookTrustConfigPath();
    const trustConfig = readTextFile(trustConfigPath);
    const hookStates = hooksFound
      ? buildCodexHookStatesForEntries({
        hooksPath,
        hooks: readHooksForTrust(hooksPath),
        matchesEntry: (entry) => entryContainsAditHook(entry),
      })
      : [];
    const untrustedStates = findUntrustedCodexHookStates(trustConfig, hookStates);
    checks.push({
      name: "Codex hook trust",
      ok: hooksFound && hookStates.length > 0 && untrustedStates.length === 0,
      detail: !hooksFound
        ? "No ADIT Codex hooks found to trust"
        : untrustedStates.length === 0
          ? `All ADIT hooks trusted in ${trustConfigPath}`
          : `${untrustedStates.length} hook(s) need review in Codex. Run 'adit plugin install codex' or open /hooks.`,
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

    const hookStates = buildCodexHookStatesForEntries({
      hooksPath,
      hooks: mergedHooks,
      matchesEntry: (entry) => entryContainsAditHook(entry),
    });
    upsertCodexHookTrustConfig({
      blockName: ADIT_CODEX_HOOK_TRUST_BLOCK,
      marker: codexHookTrustMarkerForPath(hooksPath),
      states: hookStates,
    });
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
      removeCodexHookTrustConfig({
        blockName: ADIT_CODEX_HOOK_TRUST_BLOCK,
        marker: codexHookTrustMarkerForPath(hooksPath),
      });
    } catch {
      // Ignore parse errors
    }
  },
};

function readHooksForTrust(hooksPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8")) as unknown;
    const hooks = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).hooks
      : null;
    return hooks && typeof hooks === "object" && !Array.isArray(hooks)
      ? hooks as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function entryContainsAditHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const raw = entry as { command?: string; hooks?: Array<{ command?: string }> };
  if (typeof raw.command === "string" && isAditHookCommand(raw.command)) return true;
  return Array.isArray(raw.hooks) &&
    raw.hooks.some((hook) => typeof hook.command === "string" && isAditHookCommand(hook.command));
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
