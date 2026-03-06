/**
 * OpenCode platform adapter.
 *
 * Maps OpenCode's plugin hook events to ADIT's internal model.
 * Handles installation by generating a plugin file in .opencode/plugins/.
 *
 * OpenCode uses a plugin system (not config-based hooks like Claude Code).
 * Plugins are JS/TS modules placed in .opencode/plugins/ that export
 * hook functions. The generated plugin listens for OpenCode events and
 * spawns `adit-hook` via child process to keep ADIT fail-open.
 *
 * OpenCode stores session data in SQLite (not a single transcript JSONL
 * like Claude Code), so transcript upload is not applicable here.
 * All hook events are synced to the ADIT server directly.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
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

const PLUGIN_FILENAME = "adit.js";

const HOOK_MAPPINGS: HookMapping[] = [
  { platformEvent: "chat.message", aditHandler: "prompt-submit" },
  // OpenCode has no "stop" hook key; session.idle fires when the assistant
  // finishes a response turn and is the correct trigger for checkpoints.
  // session.idle also triggers a forced cloud sync so data is flushed before
  // the user exits (since /exit does not reliably fire a session-end event).
  { platformEvent: "session.idle", aditHandler: "stop" },
  { platformEvent: "session.created", aditHandler: "session-start" },
  { platformEvent: "session.deleted", aditHandler: "session-end" },
  // /exit does not fire session.deleted; command.executed is intercepted
  // synchronously in the plugin to flush cloud sync before process exit.
  { platformEvent: "command.executed", aditHandler: "session-end" },
  { platformEvent: "message.part.updated", aditHandler: "notification" },
  { platformEvent: "session.diff", aditHandler: "notification" },
  { platformEvent: "todo.updated", aditHandler: "task-completed" },
];

/** Map OpenCode hook/event types to ADIT hook types */
const EVENT_TO_ADIT: Record<string, AditHookType> = {
  "chat.message": "prompt-submit",
  "session.idle": "stop",
  "session-start": "session-start",
  "session-end": "session-end",
  "session.created": "session-start",
  "session.deleted": "session-end",
  "session.error": "session-end",
  "notification": "notification",
  "task-completed": "task-completed",
};

/** Check if a file is an ADIT-generated plugin */
function isAditPlugin(content: string): boolean {
  return content.includes("@adit/auto-generated") || content.includes("adit-hook");
}

/**
 * Generate the OpenCode plugin file content.
 *
 * The plugin listens for OpenCode events and spawns `adit-hook` as a child
 * process, piping event data as JSON to stdin. This keeps ADIT fully
 * isolated — errors never crash OpenCode.
 *
 * Hooked events:
 * - chat.message (user)       → prompt-submit (prompt from parts[].text)
 * - session.idle              → stop (checkpoint + forced cloud sync; AI finished)
 * - session.created/deleted   → session-start/session-end
 * - session.error             → session-end
 * - command.executed          → session-end (exit/quit/q only, synchronous)
 * - message.part.updated      → notification (tool results, step finishes)
 * - session.diff              → notification (file-level diffs)
 * - todo.updated              → task-completed (AI task tracking)
 *
 * Note: OpenCode's Plugin API has no "stop" hook key. The equivalent is the
 * "session.idle" event, which fires when the assistant finishes a response.
 * UserMessage has no content field; the user prompt lives in the parts array
 * (TextPart items with type === "text"). Session has no model field — model
 * info comes from the chat.message input arg instead.
 *
 * Note: /exit (/quit, /q) does NOT fire session.deleted — OpenCode just
 * terminates the process. We intercept command.executed (which fires for all
 * slash commands) and use spawnSync to block until the session-end hook (and
 * cloud sync) completes before the process exits. The active session ID is
 * tracked via session.created/deleted.
 */
function generatePluginContent(aditBinaryPath: string): string {
  // Split the binary path into command + args for spawning.
  // e.g. 'node "/path/to/index.js"' → ["node", "/path/to/index.js"]
  const parts = aditBinaryPath.match(/"[^"]*"|\S+/g) ?? [aditBinaryPath];
  const cmd = parts[0];
  const baseArgs = parts.slice(1).map((p) => p.replace(/^"|"$/g, ""));

  return `// @adit/auto-generated — ADIT plugin for OpenCode
// Do not edit manually. Reinstall with: adit plugin install opencode
//
// This plugin listens for OpenCode events and forwards them to ADIT's
// hook dispatcher via child process. All errors are swallowed (fail-open).

const { spawn, spawnSync } = require("child_process");

const ADIT_CMD = ${JSON.stringify(cmd)};
const ADIT_BASE_ARGS = ${JSON.stringify(baseArgs)};

function spawnAditHook(hookType, data) {
  try {
    const child = spawn(ADIT_CMD, [...ADIT_BASE_ARGS, hookType], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
      env: { ...process.env, OPENCODE: "1" },
      timeout: 10000,
    });
    child.stdin.write(JSON.stringify(data));
    child.stdin.end();
    child.unref();
    child.on("error", () => {});
  } catch (e) {
    // fail-open
  }
}

// Synchronous variant used on /exit — we must block until ADIT finishes
// because the process is about to terminate and a detached child would be
// orphaned before it completes the cloud sync.
function spawnAditHookSync(hookType, data) {
  try {
    spawnSync(ADIT_CMD, [...ADIT_BASE_ARGS, hookType], {
      input: JSON.stringify(data),
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, OPENCODE: "1" },
      timeout: 10000,
    });
  } catch (e) {
    // fail-open
  }
}

exports.AditPlugin = async (ctx) => {
  const cwd = ctx.directory || ctx.worktree || process.cwd();

  // Track the active session ID so we can fire session-end on /exit.
  // OpenCode does not fire session.deleted when the user types /exit —
  // it just terminates the process. We intercept command.executed to
  // detect exit commands and block until the sync finishes.
  let activeSessionId = undefined;

  return {
    // Capture user prompts.
    // input contains sessionID and model info; output.parts is the array of
    // message parts — collect text parts to reconstruct the prompt string.
    // UserMessage has no content field; the text lives in TextPart items.
    "chat.message": async (input, output) => {
      try {
        const parts = output.parts || [];
        const prompt = parts
          .filter(function(p) { return p.type === "text"; })
          .map(function(p) { return p.text || ""; })
          .join("\\n")
          .trim();
        spawnAditHook("prompt-submit", {
          cwd,
          prompt: prompt,
          session_id: input.sessionID,
          model: input.model ? (input.model.providerID + "/" + input.model.modelID) : undefined,
        });
      } catch (e) {
        // fail-open
      }
    },

    // Capture session lifecycle + rich metadata via event bus.
    // Note: there is no "stop" hook key in the OpenCode Plugin API.
    // The equivalent is the "session.idle" event fired when the assistant
    // finishes a response turn.
    event: async ({ event }) => {
      try {
        const props = event.properties || {};

        switch (event.type) {
          // --- Assistant finished responding (replaces missing "stop" hook) ---
          case "session.idle": {
            spawnAditHook("stop", {
              cwd,
              session_id: props.sessionID,
              stop_reason: "completed",
            });
            break;
          }

          // --- Session lifecycle ---
          case "session.created": {
            const info = props.info || {};
            activeSessionId = info.id;
            spawnAditHook("session-start", {
              cwd,
              session_id: info.id,
              source: "startup",
            });
            break;
          }
          case "session.deleted": {
            const info = props.info || {};
            if (activeSessionId === info.id) activeSessionId = undefined;
            spawnAditHook("session-end", {
              cwd,
              session_id: info.id,
              reason: "deleted",
            });
            break;
          }
          case "session.error": {
            // sessionID is optional in session.error — fall back to activeSessionId
            const errorSessionId = props.sessionID || activeSessionId;
            if (activeSessionId && activeSessionId === errorSessionId) activeSessionId = undefined;
            if (!errorSessionId) break;
            spawnAditHook("session-end", {
              cwd,
              session_id: errorSessionId,
              reason: "error",
              error: props.error,
            });
            break;
          }

          // --- Message parts (tool results, step finishes) ---
          case "message.part.updated": {
            const part = props.part;
            if (!part) break;

            // Tool completion — captures tool name, input, output, timing
            if (part.type === "tool" && part.state && part.state.status === "completed") {
              spawnAditHook("notification", {
                cwd,
                session_id: part.sessionID,
                notification_type: "tool_result",
                title: part.state.title || part.tool,
                message: "Tool " + part.tool + ": " + (part.state.title || "completed"),
                tool_name: part.tool,
                tool_input: part.state.input,
                tool_output: part.state.output,
                tool_time: part.state.time,
                tool_metadata: part.state.metadata,
              });
            }

            // Tool error
            if (part.type === "tool" && part.state && part.state.status === "error") {
              spawnAditHook("notification", {
                cwd,
                session_id: part.sessionID,
                notification_type: "tool_error",
                title: part.tool + " error",
                message: "Tool " + part.tool + " failed: " + (part.state.error || "unknown"),
                tool_name: part.tool,
                tool_input: part.state.input,
                error: part.state.error,
              });
            }

            break;
          }

          // --- AI task tracking ---
          case "todo.updated": {
            const todos = props.todos;
            if (!Array.isArray(todos)) break;
            for (let i = 0; i < todos.length; i++) {
              const todo = todos[i];
              if (todo.status === "completed") {
                spawnAditHook("task-completed", {
                  cwd,
                  session_id: props.sessionID,
                  task_id: todo.id,
                  task_subject: todo.content,
                  task_description: "Priority: " + (todo.priority || "medium"),
                });
              }
            }
            break;
          }

          // --- /exit, /quit, /q interception ---
          // session.deleted does NOT fire on /exit — OpenCode just terminates.
          // command.executed fires for ALL slash commands with { name, sessionID }.
          // We must use spawnSync here so the cloud sync finishes before exit.
          case "command.executed": {
            const cmdName = (props.name || "").toLowerCase();
            const isExit = cmdName === "exit" || cmdName === "quit" || cmdName === "q";
            if (!isExit) break;
            const exitSessionId = props.sessionID || activeSessionId;
            if (!exitSessionId) break;
            activeSessionId = undefined;
            spawnAditHookSync("session-end", {
              cwd,
              session_id: exitSessionId,
              reason: "exit",
            });
            break;
          }
        }
      } catch (e) {
        // fail-open
      }
    },
  };
};
`;
}

export const opencodeAdapter: PlatformAdapter = {
  platform: "opencode" as Platform,
  displayName: "OpenCode",
  hookMappings: HOOK_MAPPINGS,

  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput {
    const aditHookType = EVENT_TO_ADIT[hookType] ?? (hookType as AditHookType);
    const cwd = (raw.cwd as string) ?? process.cwd();

    return {
      cwd,
      hookType: aditHookType,
      platformCli: "opencode",
      platformSessionId: raw.session_id as string | undefined,
      // Prompt
      prompt: raw.prompt as string | undefined,
      // Stop
      stopReason: raw.stop_reason as string | undefined,
      lastAssistantMessage: raw.last_assistant_message as string | undefined,
      // Session lifecycle
      sessionSource: raw.source as string | undefined,
      sessionEndReason: raw.reason as string | undefined,
      model: raw.model as string | undefined,
      // Notification (tool_result, tool_error, session_diff)
      notificationMessage: raw.message as string | undefined,
      notificationTitle: raw.title as string | undefined,
      notificationType: raw.notification_type as string | undefined,
      // Tool (from tool_result notifications)
      toolName: raw.tool_name as string | undefined,
      toolInput: raw.tool_input as Record<string, unknown> | undefined,
      toolOutput: raw.tool_output as Record<string, unknown> | undefined,
      // Task (from todo.updated)
      taskId: raw.task_id as string | undefined,
      taskSubject: raw.task_subject as string | undefined,
      taskDescription: raw.task_description as string | undefined,
      rawPlatformData: raw,
    };
  },

  generateHookConfig(aditBinaryPath: string): PlatformHookConfig {
    return {
      configPath: `.opencode/plugins/${PLUGIN_FILENAME}`,
      content: {
        plugin: generatePluginContent(aditBinaryPath),
      },
    };
  },

  async validateInstallation(projectRoot: string): Promise<ValidationResult> {
    const checks = [];

    // Check .opencode/plugins directory
    const pluginsDir = join(projectRoot, ".opencode", "plugins");
    const pluginsDirExists = existsSync(pluginsDir);
    checks.push({
      name: ".opencode/plugins directory",
      ok: pluginsDirExists,
      detail: pluginsDirExists ? pluginsDir : "Not found",
    });

    // Check ADIT plugin file exists and is valid
    const pluginPath = join(pluginsDir, PLUGIN_FILENAME);
    let pluginOk = false;
    let pluginDetail = "ADIT plugin not found";

    if (existsSync(pluginPath)) {
      try {
        const content = readFileSync(pluginPath, "utf-8");
        if (isAditPlugin(content)) {
          pluginOk = true;
          pluginDetail = `ADIT plugin installed at ${pluginPath}`;
        } else {
          pluginDetail = `${pluginPath} exists but is not an ADIT plugin`;
        }
      } catch {
        pluginDetail = `Failed to read ${pluginPath}`;
      }
    }

    checks.push({
      name: "ADIT plugin",
      ok: pluginOk,
      detail: pluginDetail,
    });

    return {
      valid: checks.every((c) => c.ok),
      checks,
    };
  },

  async installHooks(projectRoot: string, aditBinaryPath: string): Promise<void> {
    const pluginsDir = join(projectRoot, ".opencode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });

    const pluginPath = join(pluginsDir, PLUGIN_FILENAME);
    const content = generatePluginContent(aditBinaryPath);
    writeFileSync(pluginPath, content);
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    const pluginPath = join(projectRoot, ".opencode", "plugins", PLUGIN_FILENAME);
    if (!existsSync(pluginPath)) return;

    try {
      const content = readFileSync(pluginPath, "utf-8");
      // Only remove if it's an ADIT-generated plugin
      if (isAditPlugin(content)) {
        unlinkSync(pluginPath);
      }
    } catch {
      // Ignore errors
    }
  },
};
