/**
 * Claude Code platform adapter.
 *
 * Maps Claude Code's hook events to ADIT's internal model.
 * Handles installation into .claude/settings.local.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
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

/** Map Claude Code platform events to ADIT hook types (derived from HOOK_MAPPINGS) */
const PLATFORM_TO_ADIT: Record<string, AditHookType> = Object.fromEntries(
  HOOK_MAPPINGS.map((m) => [m.platformEvent, m.aditHandler]),
) as Record<string, AditHookType>;

/** Slash command installed into .claude/commands/ */
const ADIT_COMMAND = {
  filename: "adit.md",
  content: `---
name: adit
description: ADIT — manage cloud project linking and development intents
---

**Requested action:** \`$ARGUMENTS\`

## Routing

Parse the requested action above and follow the **first matching rule**:

1. Action is \`link\` (with optional flags) → run \`npx adit cloud link\` with the appropriate flags mapped from the arguments: \`--force\`, \`--skip-docs\`, \`--skip-commits\`, \`--dry-run\`.
2. Action is \`intent\` (with optional flags) → run \`npx adit cloud intent\` with the appropriate flags mapped from the arguments: \`--id <value>\`, \`--state <value>\`. Add \`--json\` for structured output.
3. No action, empty arguments, or unrecognized action → display the **Help** section below as your response. Do not run any commands.

---

## Help

Display the following when no valid action is provided:

### ADIT Cloud

ADIT tracks your AI-assisted development sessions, links project context to the cloud, and helps you manage development intents (plans).

**Usage:** \`/adit <action> [options]\`

#### \`link\` — Sync project to adit-cloud

Uploads git metadata (branches, commits) and project documents for intent planning.

| Option | Description |
|---|---|
| \`--force\` | Clear cache and re-link from scratch |
| \`--skip-docs\` | Only upload git metadata, skip documents |
| \`--skip-commits\` | Skip commit history upload |
| \`--dry-run\` | Preview what would be uploaded |

#### \`intent\` — View development intents

Shows intents (development plans) and tasks from the connected adit-cloud project.

| Option | Description |
|---|---|
| \`--id <id>\` | Show a specific intent by ID |
| \`--state <state>\` | Filter by state (e.g. \`capture\`, \`execution\`, \`shipped\`) |

#### Examples

- \`/adit link\` — link the project with defaults
- \`/adit link --force --skip-docs\` — re-link, git metadata only
- \`/adit intent\` — list all intents
- \`/adit intent --state execution\` — show active intents

> **Tip:** Not logged in? Run \`npx adit cloud login\` in your terminal first.
`,
};

/** Filenames of old command files to clean up during install */
const LEGACY_COMMAND_FILES = ["adit-link.md", "adit-intent.md"];

/**
 * Detect system-injected prompts that Claude Code sends through UserPromptSubmit
 * (e.g. background task completion callbacks wrapped in <task-notification> XML).
 */
function isSystemInjectedPrompt(prompt: unknown): boolean {
  if (typeof prompt !== "string") return false;
  return prompt.trimStart().startsWith("<task-notification>");
}

export const claudeCodeAdapter: PlatformAdapter = {
  platform: "claude-code" as Platform,
  displayName: "Claude Code",
  hookMappings: HOOK_MAPPINGS,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    let aditHookType = PLATFORM_TO_ADIT[hookType] ?? (hookType as AditHookType);
    const cwd = (raw.cwd as string) ?? process.cwd();

    // Claude Code sends <task-notification> XML blocks through UserPromptSubmit
    // when background tasks complete. Reclassify these as notification events
    // so they don't pollute the user prompt timeline.
    const isReclassifiedNotification =
      aditHookType === "prompt-submit" && isSystemInjectedPrompt(raw.prompt);
    if (isReclassifiedNotification) {
      aditHookType = "notification";
    }

    return {
      cwd,
      hookType: aditHookType,
      platformCli: "claude-code",
      platformSessionId: raw.session_id as string | undefined,
      transcriptPath: raw.transcript_path as string | undefined,
      // Prompt
      prompt: isReclassifiedNotification ? undefined : (raw.prompt as string | undefined),
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
      notificationMessage: isReclassifiedNotification
        ? (raw.prompt as string)
        : (raw.message as string | undefined),
      notificationTitle: isReclassifiedNotification
        ? "task-notification"
        : (raw.title as string | undefined),
      notificationType: isReclassifiedNotification
        ? "task-notification"
        : (raw.notification_type as string | undefined),
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
    const makeHookEntry = (hookType: AditHookType) => [
      {
        hooks: [{
          type: "command",
          command: buildAditHookCommand(aditBinaryPath, "claude", hookType),
          timeout: 10000,
        }],
      },
    ];

    return {
      configPath: ".claude/settings.local.json",
      content: {
        hooks: {
          UserPromptSubmit: makeHookEntry("prompt-submit"),
          Stop: makeHookEntry("stop"),
          SessionStart: makeHookEntry("session-start"),
          SessionEnd: makeHookEntry("session-end"),
          TaskCompleted: makeHookEntry("task-completed"),
          Notification: makeHookEntry("notification"),
          SubagentStart: makeHookEntry("subagent-start"),
          SubagentStop: makeHookEntry("subagent-stop"),
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

    // Check slash command file
    const cmdPath = join(projectRoot, ".claude", "commands", ADIT_COMMAND.filename);
    const cmdExists = existsSync(cmdPath);
    checks.push({
      name: "Command /adit",
      ok: cmdExists,
      detail: cmdExists ? cmdPath : "Not found",
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

    // Install slash command
    const commandsDir = join(claudeDir, "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, ADIT_COMMAND.filename), ADIT_COMMAND.content);

    // Clean up legacy command files from previous versions
    for (const legacy of LEGACY_COMMAND_FILES) {
      try { unlinkSync(join(commandsDir, legacy)); } catch { /* best-effort */ }
    }
  },

  getResumeCommand(_projectRoot: string): string | null {
    return "claude --continue";
  },

  async hasHooks(projectRoot: string): Promise<boolean> {
    if (configHasAditHooks(join(projectRoot, ".claude", "settings.local.json"))) return true;
    if (configHasAditHooks(join(projectRoot, ".claude", "settings.json"))) return true;
    if (existsSync(join(projectRoot, ".claude", "commands", ADIT_COMMAND.filename))) return true;
    return LEGACY_COMMAND_FILES.some((legacy) =>
      existsSync(join(projectRoot, ".claude", "commands", legacy)),
    );
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    removeAditHooksFromConfig(join(projectRoot, ".claude", "settings.local.json"));
    removeAditHooksFromConfig(join(projectRoot, ".claude", "settings.json"));

    // Remove slash command
    const commandsDir = join(projectRoot, ".claude", "commands");
    try { unlinkSync(join(commandsDir, ADIT_COMMAND.filename)); } catch { /* best-effort */ }

    // Clean up legacy command files
    for (const legacy of LEGACY_COMMAND_FILES) {
      try { unlinkSync(join(commandsDir, legacy)); } catch { /* best-effort */ }
    }
  },
};

function configHasAditHooks(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { hooks?: unknown };
    if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
      return false;
    }
    return Object.values(settings.hooks).some((entries) =>
      Array.isArray(entries) && entries.some(entryContainsAditHook),
    );
  } catch {
    return false;
  }
}

function removeAditHooksFromConfig(settingsPath: string): void {
  if (!existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { hooks?: Record<string, unknown> };
    if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
      return;
    }

    for (const hookName of Object.keys(settings.hooks)) {
      const entries = settings.hooks[hookName];
      if (!Array.isArray(entries)) continue;

      const filtered = entries.filter((entry) => !entryContainsAditHook(entry));
      if (filtered.length === 0) {
        delete settings.hooks[hookName];
      } else {
        settings.hooks[hookName] = filtered;
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // Ignore parse errors
  }
}

function entryContainsAditHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const raw = entry as { command?: string; hooks?: Array<{ command?: string }> };
  if (typeof raw.command === "string" && isAditHookCommand(raw.command)) return true;
  return Array.isArray(raw.hooks) &&
    raw.hooks.some((hook) => typeof hook.command === "string" && isAditHookCommand(hook.command));
}
