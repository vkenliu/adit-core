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
import type { Platform } from "@varveai/adit-core";
import type {
  PlatformAdapter,
  HookMapping,
  NormalizedHookInput,
  PlatformHookConfig,
  ValidationResult,
  AditHookType,
} from "./types.js";

const PLUGIN_FILENAME = "adit.js";

/** Slash command installed into .opencode/commands/ */
const ADIT_COMMAND = {
  filename: "adit.md",
  content: `---
description: ADIT — manage cloud project linking and development intents
---

**Requested action:** \`$ARGUMENTS\`

## Routing

Parse the requested action above and follow the **first matching rule**:

1. Action is \`link\` (with optional flags) → call the \`adit_link\` tool. Map flags: \`--force\` → \`force: true\`, \`--skip-docs\` → \`skipDocs: true\`, \`--skip-commits\` → \`skipCommits: true\`, \`--dry-run\` → \`dryRun: true\`.
2. Action is \`intent\` (with optional flags) → call the \`adit_intent\` tool. Map flags: \`--id <value>\` → \`id: "<value>"\`, \`--state <value>\` → \`state: "<value>"\`.
3. No action, empty arguments, or unrecognized action → display the **Help** section below as your response. Do not call any tools.

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

/** Generate custom tool file content for .opencode/tools/adit.ts */
function generateToolsContent(): string {
  // Built as string concatenation to avoid backtick escaping issues
  // (the Bun.$ tagged template must contain literal backticks in output).
  const lines = [
    "/**",
    " * ADIT custom tools for OpenCode.",
    " *",
    " * Provides adit_link and adit_intent tools that the LLM can call",
    " * to interact with adit-cloud project linking and intent management.",
    " *",
    " * @varveai/adit-auto-generated — reinstall with: adit plugin install opencode",
    " */",
    "",
    'import { tool } from "@opencode-ai/plugin";',
    "",
    "export const link = tool({",
    "  description:",
    '    "Link the current project to adit-cloud. Uploads git metadata (branches, commits) and project documents for intent planning.",',
    "  args: {",
    '    force: tool.schema.boolean().optional().describe("Clear cache and re-link everything from scratch"),',
    '    skipDocs: tool.schema.boolean().optional().describe("Only upload git metadata, skip document upload"),',
    '    skipCommits: tool.schema.boolean().optional().describe("Skip commit history upload"),',
    '    dryRun: tool.schema.boolean().optional().describe("Preview what would be uploaded without actually uploading"),',
    "  },",
    "  async execute(args, context) {",
    '    const flags: string[] = ["--json"];',
    '    if (args.force) flags.push("--force");',
    '    if (args.skipDocs) flags.push("--skip-docs");',
    '    if (args.skipCommits) flags.push("--skip-commits");',
    '    if (args.dryRun) flags.push("--dry-run");',
    "",
    '    const cmd = ["npx", "adit", "cloud", "link", ...flags];',
    "    const result = await Bun.$`${cmd}`.cwd(context.directory).nothrow().quiet();",
    "    const stdout = result.stdout.toString().trim();",
    "    const stderr = result.stderr.toString().trim();",
    "",
    "    if (result.exitCode !== 0) {",
    '      return "Link failed: " + (stderr || stdout || "Unknown error");',
    "    }",
    "",
    "    try {",
    "      const data = JSON.parse(stdout);",
    '      const q = data.qualified ? "qualified" : "not qualified";',
    "      const lines = [",
    '        "**Project linked successfully!**",',
    '        "",',
    '        "| Field | Value |",',
    '        "|---|---|",',
    '        "| Project | " + data.projectName + " |",',
    '        "| Server | " + data.serverUrl + " |",',
    '        "| Branches | " + data.branchCount + " |",',
    '        "| Commits | " + data.commitCount + " |",',
    '        "| Documents | " + data.documentCount + " (" + q + ") |",',
    "      ];",
    '      if (data.score !== null) lines.push("| Quality | " + (data.score * 100).toFixed(0) + "% |");',
    "      if (data.stepTimings && data.stepTimings.length > 0) {",
    '        lines.push("");',
    '        lines.push("**Step timings:**");',
    '        lines.push("");',
    '        lines.push("| Step | Duration |");',
    '        lines.push("|---|---|");',
    "        for (const s of data.stepTimings) {",
    '          const secs = (s.durationMs / 1000).toFixed(2);',
    '          lines.push("| " + s.step + " | " + secs + "s |");',
    "        }",
    "        if (data.totalDurationMs !== undefined) {",
    '          const total = (data.totalDurationMs / 1000).toFixed(2);',
    '          lines.push("| **Total** | **" + total + "s** |");',
    "        }",
    "      }",
    '      return lines.join("\\n");',
    "    } catch {",
    "      return stdout;",
    "    }",
    "  },",
    "});",
    "",
    "export const intent = tool({",
    "  description:",
    '    "Show intents (development plans) and tasks from the connected adit-cloud project.",',
    "  args: {",
    '    id: tool.schema.string().optional().describe("Intent ID to show detailed view with all tasks"),',
    '    state: tool.schema.string().optional().describe("Filter intents by state (e.g. capture, execution, shipped)"),',
    "  },",
    "  async execute(args, context) {",
    '    const flags: string[] = ["--json"];',
    '    if (args.id) flags.push("--id", args.id);',
    '    if (args.state) flags.push("--state", args.state);',
    "",
    '    const cmd = ["npx", "adit", "cloud", "intent", ...flags];',
    "    const result = await Bun.$`${cmd}`.cwd(context.directory).nothrow().quiet();",
    "    const stdout = result.stdout.toString().trim();",
    "    const stderr = result.stderr.toString().trim();",
    "",
    "    if (result.exitCode !== 0) {",
    '      return "Intent query failed: " + (stderr || stdout || "Unknown error");',
    "    }",
    "",
    "    try {",
    "      const data = JSON.parse(stdout);",
    "",
    "      // Single intent detail",
    "      if (data.intent) {",
    "        const i = data.intent;",
    "        const progress = i.taskCount > 0",
    '          ? i.completedTaskCount + "/" + i.taskCount + " tasks completed"',
    '          : "no tasks";',
    "        const lines = [",
    '          "### " + i.title,',
    '          "",',
    '          "| Field | Value |",',
    '          "|---|---|",',
    '          "| State | " + i.state + " |",',
    '          "| Goal | " + i.businessGoal + " |",',
    '          "| Progress | " + progress + " |",',
    "        ];",
    '        if (i.linkedBranches && i.linkedBranches.length > 0) {',
    '          lines.push("| Branches | " + i.linkedBranches.join(", ") + " |");',
    "        }",
    "        if (i.tasks && i.tasks.length > 0) {",
    '          lines.push("");',
    '          lines.push("#### Tasks");',
    '          lines.push("");',
    '          lines.push("| Phase | Task | Status |");',
    '          lines.push("|---|---|---|");',
    "          for (const t of i.tasks) {",
    '            const phase = t.phaseTitle || "Phase " + t.phase;',
    '            lines.push("| " + phase + " | " + t.title + (t.description ? " — " + t.description : "") + " | " + t.approvalStatus + " |");',
    "          }",
    "        }",
    '        if (i.acceptanceMd) {',
    '          lines.push("");',
    '          lines.push("#### Acceptance Criteria");',
    '          lines.push("");',
    '          lines.push(i.acceptanceMd);',
    "        }",
    '        return lines.join("\\n");',
    "      }",
    "",
    "      // Intent list",
    "      if (data.intents) {",
    "        if (data.intents.length === 0) {",
    '          return "No intents found for this project. Create intents on adit-cloud first.";',
    "        }",
    '        const lines = ["**" + data.intents.length + " intent(s):**", ""];',
    '        lines.push("| ID | State | Intent | Progress | Goal |");',
    '        lines.push("|---|---|---|---|---|");',
    "        for (const i of data.intents) {",
    "          const progress = i.taskCount > 0",
    '            ? i.completedTaskCount + "/" + i.taskCount',
    '            : "—";',
    '          const branches = i.linkedBranches && i.linkedBranches.length > 0',
    '            ? " (" + i.linkedBranches.join(", ") + ")"',
    '            : "";',
    '          lines.push("| " + i.id + " | " + i.state + " | " + i.title + branches + " | " + progress + " | " + i.businessGoal + " |");',
    "        }",
    '        lines.push("");',
    '        lines.push("Use `/adit intent --id <id>` to see details for a specific intent.");',
    '        return lines.join("\\n");',
    "      }",
    "",
    '      return JSON.stringify(data, null, 2);',
    "    } catch {",
    "      return stdout;",
    "    }",
    "  },",
    "});",
    "",
  ];
  return lines.join("\n");
}

const ADIT_TOOLS = {
  filename: "adit.ts",
};

/** Filenames of old command files to clean up during install */
const LEGACY_COMMAND_FILES = ["adit-link.md", "adit-intent.md"];

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
  return content.includes("@varveai/adit-auto-generated") || content.includes("adit-hook");
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
 * terminates the process. We use two layers of defense:
 * 1. command.executed: fires for slash commands, uses spawnSync to block until
 *    the session-end hook (and cloud sync) completes before the process exits.
 * 2. process.on('exit'): safety net that fires session-end synchronously if
 *    command.executed never fired (e.g. OpenCode calls process.exit() directly).
 *    Also handles SIGINT (Ctrl+C) and SIGTERM by flushing then re-raising.
 * The active session ID is tracked via session.created/deleted, and a
 * sessionEndFired flag prevents duplicate session-end calls.
 */
function generatePluginContent(aditBinaryPath: string): string {
  // Split the binary path into command + args for spawning.
  // e.g. 'node "/path/to/index.js"' → ["node", "/path/to/index.js"]
  const parts = aditBinaryPath.match(/"[^"]*"|\S+/g) ?? [aditBinaryPath];
  const cmd = parts[0];
  const baseArgs = parts.slice(1).map((p) => p.replace(/^"|"$/g, ""));

  return `// @varveai/adit-auto-generated — ADIT plugin for OpenCode
// Do not edit manually. Reinstall with: adit plugin install opencode
//
// This plugin listens for OpenCode events and forwards them to ADIT's
// hook dispatcher via child process. All errors are swallowed (fail-open).

const { spawn, spawnSync } = require("child_process");
const { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } = require("fs");
const path = require("path");

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

// ---------------------------------------------------------------------------
// Transcript collection — fetch messages from OpenCode's local HTTP API
// and write them as JSONL so the existing transcript upload pipeline can
// handle them identically to Claude Code transcripts.
// ---------------------------------------------------------------------------

/**
 * Fetch session messages via the SDK client and append new ones to a JSONL file.
 * Returns the absolute path to the JSONL file, or null if nothing was written.
 *
 * Each line is a JSON object:
 *   { role, messageID, parentID?, model?, agent?, parts: [...], tokens?, cost?, time }
 *
 * The function is incremental: it reads a small metadata sidecar
 * (.meta.json) to track how many messages were written on the previous
 * call and only appends new ones.
 */
/**
 * Export session messages via "opencode export <sessionID>" CLI command
 * and write them as JSONL for the transcript upload pipeline.
 *
 * OpenCode TUI does not expose an HTTP API — the SDK client's baseUrl
 * defaults to localhost:4096 which is only used by "opencode serve".
 * The "opencode export" command reads directly from OpenCode's SQLite
 * database, so it works regardless of whether a server is running.
 *
 * The function is incremental: a .meta.json sidecar tracks how many
 * messages were written previously, and only new messages are appended.
 */
function fetchTranscript(cwd, sessionID) {
  try {
    if (process.env.ADIT_DEBUG) {
      process.stderr.write("[adit-transcript] exporting session " + sessionID + "\\n");
    }

    var exportResult = spawnSync("opencode", ["export", sessionID], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
      env: { ...process.env },
    });

    if (exportResult.status !== 0 || !exportResult.stdout) {
      if (process.env.ADIT_DEBUG) {
        var errOut = exportResult.stderr ? exportResult.stderr.toString().trim() : "";
        process.stderr.write("[adit-transcript] export failed (exit " + exportResult.status + "): " + errOut.substring(0, 500) + "\\n");
      }
      return null;
    }

    var rawOutput = exportResult.stdout.toString().trim();
    if (!rawOutput) {
      if (process.env.ADIT_DEBUG) {
        process.stderr.write("[adit-transcript] export returned empty output\\n");
      }
      return null;
    }

    var exportData;
    try {
      exportData = JSON.parse(rawOutput);
    } catch (parseErr) {
      if (process.env.ADIT_DEBUG) {
        process.stderr.write("[adit-transcript] JSON parse error: " + parseErr.message + "\\n");
        process.stderr.write("[adit-transcript] raw output (first 300 chars): " + rawOutput.substring(0, 300) + "\\n");
      }
      return null;
    }

    if (process.env.ADIT_DEBUG) {
      var topKeys = Array.isArray(exportData) ? "[array:" + exportData.length + "]" : Object.keys(exportData).join(",");
      process.stderr.write("[adit-transcript] export data shape: " + topKeys + "\\n");
    }

    // The export format may vary — handle multiple shapes:
    // 1. Array of messages directly
    // 2. Object with .messages array
    // 3. Object with .data array
    var messages = [];
    if (Array.isArray(exportData)) {
      messages = exportData;
    } else if (exportData.messages && Array.isArray(exportData.messages)) {
      messages = exportData.messages;
    } else if (exportData.data && Array.isArray(exportData.data)) {
      messages = exportData.data;
    }

    if (messages.length === 0) {
      if (process.env.ADIT_DEBUG) {
        process.stderr.write("[adit-transcript] no messages found in export\\n");
      }
      return null;
    }

    if (process.env.ADIT_DEBUG) {
      process.stderr.write("[adit-transcript] found " + messages.length + " messages\\n");
      // Log shape of first message to understand the format
      var firstMsg = messages[0];
      var firstKeys = firstMsg ? Object.keys(firstMsg).join(",") : "empty";
      process.stderr.write("[adit-transcript] first message keys: " + firstKeys + "\\n");
    }

    // Ensure transcript directory exists
    var transcriptDir = path.join(cwd, ".adit", "transcripts");
    mkdirSync(transcriptDir, { recursive: true });

    var filePath = path.join(transcriptDir, "opencode-" + sessionID + ".jsonl");
    var metaPath = filePath + ".meta.json";

    // Read previous write count from sidecar
    var prevCount = 0;
    if (existsSync(metaPath)) {
      try {
        var meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        prevCount = meta.messageCount || 0;
      } catch (e) { /* ignore corrupt meta */ }
    }

    // Only append new messages
    if (messages.length <= prevCount) {
      if (process.env.ADIT_DEBUG) {
        process.stderr.write("[adit-transcript] no new messages (prev: " + prevCount + ", current: " + messages.length + ")\\n");
      }
      return filePath;
    }

    var newMessages = messages.slice(prevCount);
    var lines = [];
    for (var i = 0; i < newMessages.length; i++) {
      var msg = newMessages[i];

      // Normalize: the export may use { info, parts } or flat { role, ... }
      var info = msg.info || msg;
      var parts = msg.parts || [];

      var normalizedParts = parts.map(function(p) {
        if (p.type === "text") return { type: "text", text: p.text || p.content };
        if (p.type === "tool") return { type: "tool", tool: p.tool, callID: p.callID, state: p.state };
        if (p.type === "reasoning") return { type: "reasoning", text: p.text };
        if (p.type === "step-start") return { type: "step-start" };
        if (p.type === "step-finish") return { type: "step-finish", cost: p.cost, tokens: p.tokens };
        return { type: p.type || "unknown" };
      });

      var entry = {
        role: info.role,
        messageID: info.id || info.messageID,
        sessionID: info.sessionID || sessionID,
        time: info.time || info.createdAt,
        parts: normalizedParts,
      };

      if (info.role === "assistant") {
        if (info.modelID) entry.modelID = info.modelID;
        if (info.providerID) entry.providerID = info.providerID;
        if (info.tokens) entry.tokens = info.tokens;
        if (info.cost) entry.cost = info.cost;
        if (info.finishReason) entry.finishReason = info.finishReason;
      }

      if (info.role === "user") {
        if (info.model) entry.model = info.model;
        if (info.agent) entry.agent = info.agent;
      }

      lines.push(JSON.stringify(entry));
    }

    // Append new lines to the JSONL file
    var NL = String.fromCharCode(10);
    var appendData = lines.join(NL) + NL;
    appendFileSync(filePath, appendData);

    // Update sidecar with total count
    writeFileSync(metaPath, JSON.stringify({ messageCount: messages.length }));

    if (process.env.ADIT_DEBUG) {
      process.stderr.write("[adit-transcript] wrote " + newMessages.length + " new messages to " + filePath + "\\n");
    }
    return filePath;
  } catch (e) {
    // fail-open — transcript export is best-effort
    if (process.env.ADIT_DEBUG) {
      process.stderr.write("[adit-transcript] error: " + (e && e.message ? e.message : String(e)) + "\\n");
    }
    return null;
  }
}

exports.AditPlugin = async (ctx) => {
  const cwd = ctx.directory || ctx.worktree || process.cwd();
  const client = ctx.client;

  // Track the active session ID so we can fire session-end on /exit.
  // OpenCode does not fire session.deleted when the user types /exit —
  // it just terminates the process. We intercept command.executed to
  // detect exit commands and block until the sync finishes.
  let activeSessionId = undefined;
  let sessionEndFired = false;

  // Safety net: fire session-end synchronously on process exit.
  // OpenCode may not emit command.executed for /exit — it might call
  // process.exit() directly. Node's 'exit' event fires synchronously
  // and spawnSync works inside it, ensuring cloud sync completes
  // before the process terminates.
  function flushOnExit() {
    if (sessionEndFired || !activeSessionId) return;
    sessionEndFired = true;
    spawnAditHookSync("session-end", {
      cwd,
      session_id: activeSessionId,
      reason: "exit",
    });
    activeSessionId = undefined;
  }
  process.on("exit", flushOnExit);
  // SIGINT (Ctrl+C) and SIGTERM need to re-raise after flushing so the
  // process actually terminates with the expected exit code / signal.
  function handleSignal(signal) {
    flushOnExit();
    process.removeListener(signal, handleSignal);
    process.kill(process.pid, signal);
  }
  process.on("SIGINT", handleSignal.bind(null, "SIGINT"));
  process.on("SIGTERM", handleSignal.bind(null, "SIGTERM"));

  const hooks = {
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

        // Skip slash commands — they are not real user prompts.
        // OpenCode fires chat.message for everything including /adit, /help, etc.
        if (!prompt || prompt.startsWith("/")) return;

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
            // Use activeSessionId (captured from session.created with the
            // proper "ses..." format) rather than props.sessionID which may
            // use a different internal format.
            var idleSessionId = activeSessionId || props.sessionID;

            // Export transcript via "opencode export" CLI and write JSONL.
            var transcriptPath = null;
            if (idleSessionId) {
              try {
                transcriptPath = fetchTranscript(cwd, idleSessionId);
              } catch (e) { /* fail-open */ }
            }

            spawnAditHook("stop", {
              cwd,
              session_id: idleSessionId,
              stop_reason: "completed",
              transcript_path: transcriptPath,
            });
            break;
          }

          // --- Session lifecycle ---
          case "session.created": {
            const info = props.info || {};
            activeSessionId = info.id;
            sessionEndFired = false;
            spawnAditHook("session-start", {
              cwd,
              session_id: info.id,
              source: "startup",
            });
            break;
          }
          case "session.deleted": {
            const info = props.info || {};
            if (activeSessionId === info.id) {
              activeSessionId = undefined;
              sessionEndFired = true;
            }
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
            if (activeSessionId && activeSessionId === errorSessionId) {
              activeSessionId = undefined;
              sessionEndFired = true;
            }
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

            // Record the full todo list state as a notification so the
            // complete task plan (pending, in_progress, completed) is
            // captured and synced to the server.
            spawnAditHook("notification", {
              cwd,
              session_id: props.sessionID,
              notification_type: "todo_updated",
              title: "Todo list updated (" + todos.length + " items)",
              message: JSON.stringify(todos),
            });

            // Also emit individual task-completed events for completed
            // todos (backward compatibility + semantic milestone tracking).
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
            sessionEndFired = true;
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

  return hooks;
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
      // Transcript (JSONL written by plugin from OpenCode API)
      transcriptPath: raw.transcript_path as string | undefined,
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

    // Check slash command file
    const cmdPath = join(projectRoot, ".opencode", "commands", ADIT_COMMAND.filename);
    const cmdExists = existsSync(cmdPath);
    checks.push({
      name: "Command /adit",
      ok: cmdExists,
      detail: cmdExists ? cmdPath : "Not found",
    });

    // Check custom tools file
    const toolPath = join(projectRoot, ".opencode", "tools", ADIT_TOOLS.filename);
    const toolExists = existsSync(toolPath);
    checks.push({
      name: "Custom tools (adit_link, adit_intent)",
      ok: toolExists,
      detail: toolExists ? toolPath : "Not found",
    });

    return {
      valid: checks.every((c) => c.ok),
      checks,
    };
  },

  async installHooks(projectRoot: string, aditBinaryPath: string): Promise<void> {
    // Install the event-hook plugin
    const pluginsDir = join(projectRoot, ".opencode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });

    const pluginPath = join(pluginsDir, PLUGIN_FILENAME);
    const content = generatePluginContent(aditBinaryPath);
    writeFileSync(pluginPath, content);

    // Install slash command
    const commandsDir = join(projectRoot, ".opencode", "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, ADIT_COMMAND.filename), ADIT_COMMAND.content);

    // Install custom tools
    const toolsDir = join(projectRoot, ".opencode", "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(toolsDir, ADIT_TOOLS.filename), generateToolsContent());

    // Clean up legacy command files from previous versions
    for (const legacy of LEGACY_COMMAND_FILES) {
      try { unlinkSync(join(commandsDir, legacy)); } catch { /* best-effort */ }
    }
  },

  getResumeCommand(_projectRoot: string): string | null {
    return "opencode";
  },

  async uninstallHooks(projectRoot: string): Promise<void> {
    // Remove the event-hook plugin
    const pluginPath = join(projectRoot, ".opencode", "plugins", PLUGIN_FILENAME);
    if (existsSync(pluginPath)) {
      try {
        const content = readFileSync(pluginPath, "utf-8");
        if (isAditPlugin(content)) {
          unlinkSync(pluginPath);
        }
      } catch { /* best-effort */ }
    }

    // Remove slash command
    const commandsDir = join(projectRoot, ".opencode", "commands");
    try { unlinkSync(join(commandsDir, ADIT_COMMAND.filename)); } catch { /* best-effort */ }

    // Remove custom tools
    try { unlinkSync(join(projectRoot, ".opencode", "tools", ADIT_TOOLS.filename)); } catch { /* best-effort */ }

    // Clean up legacy command files
    for (const legacy of LEGACY_COMMAND_FILES) {
      try { unlinkSync(join(commandsDir, legacy)); } catch { /* best-effort */ }
    }
  },
};
