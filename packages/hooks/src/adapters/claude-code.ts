/**
 * Claude Code platform adapter.
 *
 * Maps Claude Code's hook events to ADIT's internal model.
 * Handles installation into .claude/settings.local.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "@adit/core";
import type {
  PlatformAdapter,
  HookMapping,
  NormalizedHookInput,
  PlatformHookConfig,
  ValidationResult,
  AditHookType,
} from "./types.js";

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "UserPromptSubmit", aditHandler: "prompt-submit" },
  { platformEvent: "Stop", aditHandler: "stop" },
  { platformEvent: "SessionStart", aditHandler: "session-start" },
  { platformEvent: "SessionEnd", aditHandler: "session-end" },
  { platformEvent: "TaskCompleted", aditHandler: "task-completed" },
  { platformEvent: "Notification", aditHandler: "notification" },
  { platformEvent: "SubagentStart", aditHandler: "subagent-start" },
  { platformEvent: "SubagentStop", aditHandler: "subagent-stop" },
];

/** Map Claude Code platform events to ADIT hook types */
const PLATFORM_TO_ADIT: Record<string, AditHookType> = {
  UserPromptSubmit: "prompt-submit",
  Stop: "stop",
  SessionStart: "session-start",
  SessionEnd: "session-end",
  TaskCompleted: "task-completed",
  Notification: "notification",
  SubagentStart: "subagent-start",
  SubagentStop: "subagent-stop",
};

export const claudeCodeAdapter: PlatformAdapter = {
  platform: "claude-code" as Platform,
  displayName: "Claude Code",
  hookMappings: HOOK_MAPPINGS,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const aditHookType = PLATFORM_TO_ADIT[hookType] ?? (hookType as AditHookType);
    const cwd = (raw.cwd as string) ?? process.cwd();

    return {
      cwd,
      hookType: aditHookType,
      platformCli: "claude-code",
      platformSessionId: raw.session_id as string | undefined,
      transcriptPath: raw.transcript_path as string | undefined,
      // Prompt
      prompt: raw.prompt as string | undefined,
      // Tool use fields (available from SubagentStop, etc.)
      toolName: raw.tool_name as string | undefined,
      toolInput: raw.tool_input as Record<string, unknown> | undefined,
      toolOutput: raw.tool_output as Record<string, unknown> | undefined,
      // Stop
      stopReason: raw.stop_reason as string | undefined,
      lastAssistantMessage: raw.last_assistant_message as string | undefined,
      stopHookActive: raw.stop_hook_active as boolean | undefined,
      // Task completed
      taskId: raw.task_id as string | undefined,
      taskSubject: raw.task_subject as string | undefined,
      taskDescription: raw.task_description as string | undefined,
      teammateName: raw.teammate_name as string | undefined,
      teamName: raw.team_name as string | undefined,
      // Notification
      notificationMessage: raw.message as string | undefined,
      notificationTitle: raw.title as string | undefined,
      notificationType: raw.notification_type as string | undefined,
      // Subagent
      agentId: raw.agent_id as string | undefined,
      agentType: raw.agent_type as string | undefined,
      agentTranscriptPath: raw.agent_transcript_path as string | undefined,
      // Common metadata (present in all events)
      permissionMode: raw.permission_mode as string | undefined,
      model: raw.model as string | undefined,
      // Session lifecycle
      sessionSource: raw.source as string | undefined,
      sessionEndReason: raw.reason as string | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string): PlatformHookConfig {
    const makeHookEntry = (command: string) => [
      { hooks: [{ type: "command", command, async: true }] },
    ];

    return {
      configPath: ".claude/settings.local.json",
      content: {
        hooks: {
          UserPromptSubmit: makeHookEntry(`${aditBinaryPath} prompt-submit`),
          Stop: makeHookEntry(`${aditBinaryPath} stop`),
          SessionStart: makeHookEntry(`${aditBinaryPath} session-start`),
          SessionEnd: makeHookEntry(`${aditBinaryPath} session-end`),
          TaskCompleted: makeHookEntry(`${aditBinaryPath} task-completed`),
          Notification: makeHookEntry(`${aditBinaryPath} notification`),
          SubagentStart: makeHookEntry(`${aditBinaryPath} subagent-start`),
          SubagentStop: makeHookEntry(`${aditBinaryPath} subagent-stop`),
        },
      },
    };
  },

  async validateInstallation(projectRoot: string): Promise<ValidationResult> {
    const checks = [];

    // Check .claude directory exists
    const claudeDir = join(projectRoot, ".claude");
    const claudeDirExists = existsSync(claudeDir);
    checks.push({
      name: ".claude directory",
      ok: claudeDirExists,
      detail: claudeDirExists ? claudeDir : "Not found",
    });

    // Check settings file for hook configuration
    const settingsFiles = [
      join(projectRoot, ".claude", "settings.local.json"),
      join(projectRoot, ".claude", "settings.json"),
    ];

    let hooksFound = false;
    let hooksDetail = "No hook configuration found";
    const requiredHooks = HOOK_MAPPINGS.map((m) => m.platformEvent);
    const missingHooks: string[] = [];

    for (const settingsPath of settingsFiles) {
      if (!existsSync(settingsPath)) continue;
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (!settings.hooks) continue;

        for (const hookName of requiredHooks) {
          const entries = settings.hooks[hookName];
          if (!Array.isArray(entries)) {
            missingHooks.push(hookName);
            continue;
          }
          const hasAdit = entries.some(
            (entry: { command?: string; hooks?: Array<{ command?: string }> }) => {
              if (typeof entry.command === "string" && entry.command.includes("adit-hook")) return true;
              if (Array.isArray(entry.hooks)) {
                return entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("adit-hook"));
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
        break;
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
    const claudeDir = join(projectRoot, ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const settingsPath = join(claudeDir, "settings.local.json");
    let settings: Record<string, unknown> = {};

    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        // Start fresh if settings are invalid
      }
    }

    const hookConfig = this.generateHookConfig(aditBinaryPath);
    settings.hooks = {
      ...((settings.hooks as Record<string, unknown>) ?? {}),
      ...(hookConfig.content.hooks as Record<string, unknown>),
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    const settingsPath = join(projectRoot, ".claude", "settings.local.json");
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
            if (typeof entry.command === "string" && entry.command.includes("adit-hook")) return false;
            if (Array.isArray(entry.hooks)) {
              return !entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("adit-hook"));
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
