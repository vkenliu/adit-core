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
    } catch {
      // Ignore parse errors
    }
  },
};