/**
 * Cursor IDE platform adapter.
 *
 * Maps Cursor's hook events to ADIT's internal model.
 * Handles installation into .cursor/hooks.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
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

/**
 * Read the tail of a file (last N bytes) and split into lines.
 * Returns lines in original order (oldest first).
 */
function readTailLines(filePath: string, maxLines: number = 512): string[] {
  const CHUNK = 4096;
  const stat = statSync(filePath);
  const fileSize = stat.size;
  if (fileSize === 0) return [];

  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let lineCount = 0;

    // Read backwards from end of file
    let position = fileSize;
    while (position > 0 && lineCount < maxLines) {
      const readSize = Math.min(CHUNK, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, position);
      chunks.unshift(buf);
      bytesRead += readSize;
      lineCount += buf.toString("utf8").split("\n").length - 1;
    }

    const content = Buffer.concat(chunks).toString("utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    // Keep only the last maxLines
    return lines.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

/**
 * Extract the last assistant message text from a Cursor transcript JSONL file.
 *
 * Cursor's stop event does not include the assistant's response text — only
 * `status` and `transcript_path`. The actual response is in the JSONL transcript.
 *
 * Reads the tail of the file for efficiency, then scans backwards for the
 * last `role: "assistant"` entry with text content.
 */
export function extractLastAssistantMessage(transcriptPath: string): string | undefined {
  try {
    if (!existsSync(transcriptPath)) return undefined;

    const findAssistantText = (lines: string[]): string | undefined => {
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as {
            role?: string;
            message?: { content?: Array<{ type?: string; text?: string }> };
          };
          if (entry.role !== "assistant") continue;

          const content = entry.message?.content;
          if (!Array.isArray(content)) continue;

          const texts = content
            .filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .filter((t) => t.trim().length > 0);

          if (texts.length > 0) return texts.join("\n");
        } catch {
          // Skip malformed lines
        }
      }
      return undefined;
    };

    // Fast path: parse a large tail window first.
    const tailLines = readTailLines(transcriptPath, 512);
    const fromTail = findAssistantText(tailLines);
    if (fromTail) return fromTail;

    // Fallback: if tail window misses due to very noisy tool events,
    // scan the full transcript to guarantee best-effort extraction.
    const fullContent = readFileSync(transcriptPath, "utf-8");
    const fullLines = fullContent.split("\n").filter((l) => l.trim().length > 0);
    return findAssistantText(fullLines);
  } catch {
    return undefined;
  }
}

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "beforeSubmitPrompt", aditHandler: "prompt-submit" },
  { platformEvent: "stop", aditHandler: "stop" },
  { platformEvent: "sessionStart", aditHandler: "session-start" },
  { platformEvent: "sessionEnd", aditHandler: "session-end" },
  { platformEvent: "afterAgentResponse", aditHandler: "notification" },
];

/** Map Cursor platform events to ADIT hook types (derived from HOOK_MAPPINGS) */
const PLATFORM_TO_ADIT: Record<string, AditHookType> = Object.fromEntries(
  HOOK_MAPPINGS.map((m) => [m.platformEvent, m.aditHandler]),
) as Record<string, AditHookType>;

/** Check if a command string is an ADIT hook */
function isAditHookCommand(command: string): boolean {
  return command.includes("adit-hook") || command.includes("hooks/dist/index.js");
}

export const cursorAdapter: PlatformAdapter = {
  platform: "cursor" as Platform,
  displayName: "Cursor",
  hookMappings: HOOK_MAPPINGS,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const aditHookType = PLATFORM_TO_ADIT[hookType] ?? (hookType as AditHookType);

    // Cursor sends workspace_roots as array; fall back to CURSOR_PROJECT_DIR env
    const workspaceRoots = raw.workspace_roots as string[] | undefined;
    const cwd = (workspaceRoots?.[0] as string)
      ?? process.env.CURSOR_PROJECT_DIR
      ?? process.cwd();

    // Cursor sends conversation_id for most events, session_id for session lifecycle
    const platformSessionId = (raw.conversation_id as string)
      ?? (raw.session_id as string)
      ?? undefined;

    // transcript_path or env var CURSOR_TRANSCRIPT_PATH
    const transcriptPath = (raw.transcript_path as string)
      ?? process.env.CURSOR_TRANSCRIPT_PATH
      ?? undefined;

    return {
      cwd,
      hookType: aditHookType,
      platformCli: "cursor",
      platformSessionId,
      transcriptPath,
      // Prompt (from beforeSubmitPrompt)
      prompt: raw.prompt as string | undefined,
      // Model (common field)
      model: raw.model as string | undefined,
      // Stop (from stop event — Cursor sends status, not stop_reason;
      // assistant message must be read from transcript JSONL)
      stopReason: raw.status as string | undefined,
      lastAssistantMessage: aditHookType === "stop" && transcriptPath
        ? extractLastAssistantMessage(transcriptPath)
        : undefined,
      // Notification (from afterAgentResponse)
      notificationMessage: raw.message as string | undefined,
      notificationType: raw.notification_type as string | undefined,
      // Session lifecycle
      sessionSource: raw.composer_mode as string | undefined,
      sessionEndReason: raw.reason as string | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string): PlatformHookConfig {
    // Cursor uses flat format: { command, type, timeout }
    // Timeout is in SECONDS (not milliseconds like Claude Code)
    const makeHookEntry = (command: string) => [
      { command: `CURSOR=1 ${command}`, type: "command", timeout: 10 },
    ];

    return {
      configPath: ".cursor/hooks.json",
      content: {
        hooks: {
          beforeSubmitPrompt: makeHookEntry(`${aditBinaryPath} prompt-submit`),
          stop: makeHookEntry(`${aditBinaryPath} stop`),
          sessionStart: makeHookEntry(`${aditBinaryPath} session-start`),
          sessionEnd: makeHookEntry(`${aditBinaryPath} session-end`),
          afterAgentResponse: makeHookEntry(`${aditBinaryPath} notification`),
        },
      },
    };
  },

  async validateInstallation(projectRoot: string): Promise<ValidationResult> {
    const checks = [];

    // Check .cursor directory exists
    const cursorDir = join(projectRoot, ".cursor");
    const cursorDirExists = existsSync(cursorDir);
    checks.push({
      name: ".cursor directory",
      ok: cursorDirExists,
      detail: cursorDirExists ? cursorDir : "Not found",
    });

    // Check hooks file for hook configuration
    const hooksPath = join(projectRoot, ".cursor", "hooks.json");
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
    const cursorDir = join(projectRoot, ".cursor");
    if (!existsSync(cursorDir)) {
      mkdirSync(cursorDir, { recursive: true });
    }

    const hooksPath = join(cursorDir, "hooks.json");
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

    // Clean up legacy Claude Code format entries (from previous ADIT versions
    // that used Claude Code event names: UserPromptSubmit, Stop, etc.)
    const legacyEventKeys = ["UserPromptSubmit", "Stop", "SessionStart", "SessionEnd", "Notification"];
    for (const legacyKey of legacyEventKeys) {
      if (Array.isArray(existingHooks[legacyKey])) {
        existingHooks[legacyKey] = existingHooks[legacyKey].filter(
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
        if (existingHooks[legacyKey].length === 0) {
          delete existingHooks[legacyKey];
        }
      }
    }

    const newHooks = hookConfig.content.hooks as Record<string, unknown[]>;

    // Merge hook entries per event key: preserve other tools' hooks,
    // remove stale ADIT entries, then append new ADIT entries.
    const mergedHooks = { ...existingHooks } as Record<string, unknown[]>;
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
    return null;
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    const hooksPath = join(projectRoot, ".cursor", "hooks.json");
    if (!existsSync(hooksPath)) return;

    try {
      const hooksConfig = JSON.parse(readFileSync(hooksPath, "utf-8"));
      if (!hooksConfig.hooks) return;

      // Also clean up legacy Claude Code format event keys
      const allEventKeys = [...Object.keys(hooksConfig.hooks), "UserPromptSubmit", "Stop", "SessionStart", "SessionEnd", "Notification"];

      // Remove ADIT hook entries
      for (const hookName of allEventKeys) {
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