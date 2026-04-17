/**
 * Google Gemini CLI platform adapter.
 *
 * Maps Gemini CLI's hook events to ADIT's internal model.
 * Handles installation into .gemini/settings.json.
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

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "SessionStart", aditHandler: "session-start" },
  { platformEvent: "BeforeAgent", aditHandler: "prompt-submit" },
  { platformEvent: "AfterAgent", aditHandler: "stop" },
  { platformEvent: "SessionEnd", aditHandler: "session-end" },
  { platformEvent: "AfterTool", aditHandler: "notification" },
  { platformEvent: "Notification", aditHandler: "notification" },
];

/** Map Gemini CLI platform events to ADIT hook types (derived from HOOK_MAPPINGS) */
const PLATFORM_TO_ADIT: Record<string, AditHookType> = Object.fromEntries(
  HOOK_MAPPINGS.map((m) => [m.platformEvent, m.aditHandler]),
) as Record<string, AditHookType>;

/** Check if a command string is an ADIT hook (matches both npx and resolved-path formats) */
function isAditHookCommand(command: string): boolean {
  return command.includes("adit-hook") || command.includes("hooks/dist/index.js");
}

export const geminiAdapter: PlatformAdapter = {
  platform: "gemini" as Platform,
  displayName: "Gemini CLI",
  hookMappings: HOOK_MAPPINGS,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const aditHookType = PLATFORM_TO_ADIT[hookType] ?? (hookType as AditHookType);
    const cwd = (raw.cwd as string) ?? process.cwd();

    return {
      cwd,
      hookType: aditHookType,
      platformCli: "gemini",
      platformSessionId: raw.session_id as string | undefined,
      transcriptPath: raw.transcript_path as string | undefined,
      // Prompt
      prompt: raw.prompt as string | undefined,
      // Tool use
      toolName: raw.tool_name as string | undefined,
      toolInput: raw.tool_input as Record<string, unknown> | undefined,
      toolOutput: raw.tool_response as Record<string, unknown> | undefined,
      // Stop
      stopReason: raw.stop_reason as string | undefined,
      lastAssistantMessage: raw.prompt_response as string | undefined,
      stopHookActive: raw.stop_hook_active as boolean | undefined,
      // Notification
      notificationMessage: raw.message as string | undefined,
      notificationTitle: raw.title as string | undefined,
      notificationType: raw.notification_type as string | undefined,
      // Session lifecycle
      sessionSource: raw.source as string | undefined,
      sessionEndReason: raw.reason as string | undefined,
      // Common metadata
      permissionMode: raw.permission_mode as string | undefined,
      model: raw.model as string | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string): PlatformHookConfig {
    const makeHookEntry = (command: string) => [
      { hooks: [{ type: "command", command: `CLAUDE_CODE= GEMINI=1 ${command}`, timeout: 5000 }] },
    ];

    return {
      configPath: ".gemini/settings.json",
      content: {
        hooks: {
          SessionStart: makeHookEntry(`${aditBinaryPath} session-start`),
          BeforeAgent: makeHookEntry(`${aditBinaryPath} prompt-submit`),
          AfterAgent: makeHookEntry(`${aditBinaryPath} stop`),
          SessionEnd: makeHookEntry(`${aditBinaryPath} session-end`),
          AfterTool: makeHookEntry(`${aditBinaryPath} notification`),
          Notification: makeHookEntry(`${aditBinaryPath} notification`),
        },
      },
    };
  },

  async validateInstallation(projectRoot: string): Promise<ValidationResult> {
    const checks = [];

    // Check .gemini directory exists
    const geminiDir = join(projectRoot, ".gemini");
    const geminiDirExists = existsSync(geminiDir);
    checks.push({
      name: ".gemini directory",
      ok: geminiDirExists,
      detail: geminiDirExists ? geminiDir : "Not found",
    });

    // Check settings file for hook configuration
    const settingsPath = join(projectRoot, ".gemini", "settings.json");

    let hooksFound = false;
    let hooksDetail = "No hook configuration found";
    const requiredHooks = HOOK_MAPPINGS.map((m) => m.platformEvent);
    const missingHooks: string[] = [];

    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (!settings.hooks) {
          hooksDetail = "No hooks section in settings.json";
        } else {
          for (const hookName of requiredHooks) {
            const entries = settings.hooks[hookName];
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
            ? `All hooks registered in ${settingsPath}`
            : `Missing hooks: ${missingHooks.join(", ")}`;
        }
      } catch {
        hooksDetail = `Failed to parse ${settingsPath}`;
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
    const geminiDir = join(projectRoot, ".gemini");
    if (!existsSync(geminiDir)) {
      mkdirSync(geminiDir, { recursive: true });
    }

    const settingsPath = join(geminiDir, "settings.json");
    let settings: Record<string, unknown> = {};

    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        // Start fresh if settings are invalid
      }
    }

    const hookConfig = this.generateHookConfig(aditBinaryPath);
    const existingHooks = (settings.hooks as Record<string, unknown[]>) ?? {};
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

    settings.hooks = mergedHooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  },

  getResumeCommand(_projectRoot: string): string | null {
    return "gemini";
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    const settingsPath = join(projectRoot, ".gemini", "settings.json");
    if (!existsSync(settingsPath)) return;

    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!settings.hooks) return;

      // Remove ADIT hook entries
      for (const hookName of Object.keys(settings.hooks)) {
        const entries = settings.hooks[hookName];
        if (!Array.isArray(entries)) continue;

        settings.hooks[hookName] = entries.filter(
          (entry: { command?: string; hooks?: Array<{ command?: string }> }) => {
            if (typeof entry.command === "string" && isAditHookCommand(entry.command)) return false;
            if (Array.isArray(entry.hooks)) {
              return !entry.hooks.some((h) => typeof h.command === "string" && isAditHookCommand(h.command));
            }
            return true;
          },
        );

        // Clean up empty arrays
        if (settings.hooks[hookName].length === 0) {
          delete settings.hooks[hookName];
        }
      }

      // Clean up empty hooks object
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    } catch {
      // Ignore parse errors
    }
  },
};