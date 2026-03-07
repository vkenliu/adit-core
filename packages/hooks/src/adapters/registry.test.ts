import { describe, it, expect } from "vitest";
import { getAdapter, listAdapters, detectPlatform, registerAdapter } from "./registry.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { opencodeAdapter } from "./opencode.js";
import type { PlatformAdapter } from "./types.js";

describe("Adapter Registry", () => {
  it("returns the Claude Code adapter", () => {
    const adapter = getAdapter("claude-code");
    expect(adapter).toBeDefined();
    expect(adapter.platform).toBe("claude-code");
    expect(adapter.displayName).toBe("Claude Code");
  });

  it("throws for unknown platform", () => {
    expect(() => getAdapter("unknown-platform" as never)).toThrow(
      /No adapter registered/,
    );
  });

  it("lists all registered adapters including stubs", () => {
    const adapters = listAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(5);
    expect(adapters.find((a) => a.platform === "claude-code")).toBeDefined();
    expect(adapters.find((a) => a.platform === "cursor")).toBeDefined();
    expect(adapters.find((a) => a.platform === "copilot")).toBeDefined();
    expect(adapters.find((a) => a.platform === "opencode")).toBeDefined();
    expect(adapters.find((a) => a.platform === "codex")).toBeDefined();
  });

  it("detects platform from environment", () => {
    // Default should be claude-code
    const platform = detectPlatform();
    expect(["claude-code", "cursor", "copilot", "opencode", "codex", "other"]).toContain(platform);
  });

  it("returns the OpenCode adapter (fully implemented)", () => {
    const opencode = getAdapter("opencode");
    expect(opencode.displayName).toBe("OpenCode");
    expect(opencode.hookMappings.length).toBeGreaterThan(0);
  });

  it("returns stub adapters for unimplemented platforms", () => {
    const cursor = getAdapter("cursor");
    expect(cursor.displayName).toBe("Cursor");
    expect(cursor.hookMappings).toHaveLength(0);

    const codex = getAdapter("codex");
    expect(codex.displayName).toBe("Codex");
  });

  it("stub adapters report not implemented in validation", async () => {
    const cursor = getAdapter("cursor");
    const result = await cursor.validateInstallation("/test");
    expect(result.valid).toBe(false);
    expect(result.checks[0].detail).toContain("not yet implemented");
  });

  it("allows registering custom adapters", () => {
    const mockAdapter: PlatformAdapter = {
      platform: "other",
      displayName: "Test Platform",
      hookMappings: [],
      parseInput: () => ({ cwd: "/", hookType: "stop" }),
      generateHookConfig: () => ({ configPath: "test", content: {} }),
      validateInstallation: async () => ({ valid: true, checks: [] }),
      installHooks: async () => {},
      uninstallHooks: async () => {},
    };

    registerAdapter(mockAdapter);
    const adapter = getAdapter("other");
    expect(adapter.displayName).toBe("Test Platform");
  });
});

describe("Claude Code Adapter", () => {
  it("has correct hook mappings", () => {
    expect(claudeCodeAdapter.hookMappings).toHaveLength(8);

    const mappings = claudeCodeAdapter.hookMappings.map((m) => m.platformEvent);
    expect(mappings).toContain("UserPromptSubmit");
    expect(mappings).toContain("Stop");
    expect(mappings).toContain("SessionStart");
    expect(mappings).toContain("SessionEnd");
    expect(mappings).toContain("TaskCompleted");
    expect(mappings).toContain("Notification");
    expect(mappings).toContain("SubagentStart");
    expect(mappings).toContain("SubagentStop");
    expect(mappings).not.toContain("PostToolUse");
  });

  it("parseInput normalizes prompt-submit", () => {
    const input = claudeCodeAdapter.parseInput(
      { cwd: "/project", prompt: "hello world" },
      "UserPromptSubmit",
    );
    expect(input.hookType).toBe("prompt-submit");
    expect(input.prompt).toBe("hello world");
    expect(input.cwd).toBe("/project");
  });

  it("parseInput normalizes stop", () => {
    const input = claudeCodeAdapter.parseInput(
      { cwd: "/project", stop_reason: "end_turn" },
      "Stop",
    );
    expect(input.hookType).toBe("stop");
    expect(input.stopReason).toBe("end_turn");
  });

  it("parseInput normalizes session-start", () => {
    const input = claudeCodeAdapter.parseInput(
      { cwd: "/project" },
      "SessionStart",
    );
    expect(input.hookType).toBe("session-start");
  });

  it("parseInput normalizes task-completed with task fields", () => {
    const input = claudeCodeAdapter.parseInput(
      {
        cwd: "/project",
        task_id: "task-001",
        task_subject: "Implement auth",
        task_description: "Add login endpoint",
        teammate_name: "implementer",
        team_name: "my-team",
      },
      "TaskCompleted",
    );
    expect(input.hookType).toBe("task-completed");
    expect(input.taskId).toBe("task-001");
    expect(input.taskSubject).toBe("Implement auth");
    expect(input.taskDescription).toBe("Add login endpoint");
    expect(input.teammateName).toBe("implementer");
    expect(input.teamName).toBe("my-team");
  });

  it("parseInput normalizes notification with notification fields", () => {
    const input = claudeCodeAdapter.parseInput(
      {
        cwd: "/project",
        message: "Claude needs your permission",
        title: "Permission needed",
        notification_type: "permission_prompt",
      },
      "Notification",
    );
    expect(input.hookType).toBe("notification");
    expect(input.notificationMessage).toBe("Claude needs your permission");
    expect(input.notificationTitle).toBe("Permission needed");
    expect(input.notificationType).toBe("permission_prompt");
  });

  it("parseInput normalizes subagent-start with agent fields", () => {
    const input = claudeCodeAdapter.parseInput(
      {
        cwd: "/project",
        agent_id: "agent-abc123",
        agent_type: "Explore",
      },
      "SubagentStart",
    );
    expect(input.hookType).toBe("subagent-start");
    expect(input.agentId).toBe("agent-abc123");
    expect(input.agentType).toBe("Explore");
  });

  it("parseInput normalizes subagent-stop with agent fields", () => {
    const input = claudeCodeAdapter.parseInput(
      {
        cwd: "/project",
        agent_id: "agent-def456",
        agent_type: "Plan",
        agent_transcript_path: "/path/to/transcript.jsonl",
        last_assistant_message: "Analysis complete.",
      },
      "SubagentStop",
    );
    expect(input.hookType).toBe("subagent-stop");
    expect(input.agentId).toBe("agent-def456");
    expect(input.agentType).toBe("Plan");
    expect(input.agentTranscriptPath).toBe("/path/to/transcript.jsonl");
    expect(input.lastAssistantMessage).toBe("Analysis complete.");
  });

  it("reclassifies task-notification prompt as notification", () => {
    const input = claudeCodeAdapter.parseInput(
      { cwd: "/project", prompt: "<task-notification>Task done</task-notification>" },
      "UserPromptSubmit",
    );
    expect(input.hookType).toBe("notification");
    expect(input.prompt).toBeUndefined();
    expect(input.notificationMessage).toBe("<task-notification>Task done</task-notification>");
    expect(input.notificationType).toBe("task-notification");
  });

  it("generateHookConfig produces valid structure with async hooks", () => {
    const config = claudeCodeAdapter.generateHookConfig("npx adit-hook");
    expect(config.configPath).toBe(".claude/settings.local.json");
    expect(config.content.hooks).toBeDefined();

    const hooks = config.content.hooks as Record<string, unknown>;
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.SessionEnd).toBeDefined();
    expect(hooks.TaskCompleted).toBeDefined();
    expect(hooks.Notification).toBeDefined();
    expect(hooks.SubagentStart).toBeDefined();
    expect(hooks.SubagentStop).toBeDefined();

    // Verify hooks run synchronously (no async flag)
    for (const hookName of Object.keys(hooks)) {
      const entries = hooks[hookName] as Array<{
        hooks: Array<{ type: string; command: string; async?: boolean }>;
      }>;
      expect(entries[0].hooks[0].async).toBeUndefined();
    }
  });
});

describe("OpenCode Adapter", () => {
  it("has correct hook mappings", () => {
    expect(opencodeAdapter.hookMappings.length).toBe(8);

    const mappings = opencodeAdapter.hookMappings.map((m) => m.platformEvent);
    expect(mappings).toContain("chat.message");
    // OpenCode has no "stop" hook; session.idle fires when the AI finishes
    // and also triggers a forced cloud sync (guards against lost data on /exit)
    expect(mappings).toContain("session.idle");
    expect(mappings).toContain("session.created");
    expect(mappings).toContain("session.deleted");
    // /exit fires command.executed (not session.deleted); intercepted synchronously
    expect(mappings).toContain("command.executed");
    // message.updated (assistant_metadata) removed — LLM cost/token tracking not needed
    expect(mappings).not.toContain("message.updated");
    expect(mappings).toContain("message.part.updated");
    expect(mappings).toContain("session.diff");
    expect(mappings).toContain("todo.updated");
  });

  it("parseInput normalizes prompt-submit", () => {
    const input = opencodeAdapter.parseInput(
      { cwd: "/project", prompt: "hello world", session_id: "sess-1" },
      "prompt-submit",
    );
    expect(input.hookType).toBe("prompt-submit");
    expect(input.prompt).toBe("hello world");
    expect(input.cwd).toBe("/project");
    expect(input.platformCli).toBe("opencode");
    expect(input.platformSessionId).toBe("sess-1");
  });

  it("parseInput maps session.idle to stop", () => {
    const input = opencodeAdapter.parseInput(
      { cwd: "/project", session_id: "sess-1", stop_reason: "completed" },
      "session.idle",
    );
    expect(input.hookType).toBe("stop");
    expect(input.platformSessionId).toBe("sess-1");
    expect(input.stopReason).toBe("completed");
  });

  it("parseInput normalizes stop (direct hookType)", () => {
    const input = opencodeAdapter.parseInput(
      { cwd: "/project", stop_reason: "completed", last_assistant_message: "Done." },
      "stop",
    );
    expect(input.hookType).toBe("stop");
    expect(input.stopReason).toBe("completed");
    expect(input.lastAssistantMessage).toBe("Done.");
  });

  it("parseInput normalizes session-start", () => {
    const input = opencodeAdapter.parseInput(
      { cwd: "/project", source: "startup", session_id: "sess-2", model: "claude-sonnet" },
      "session-start",
    );
    expect(input.hookType).toBe("session-start");
    expect(input.sessionSource).toBe("startup");
    expect(input.model).toBe("claude-sonnet");
  });

  it("parseInput normalizes session-end from session.deleted", () => {
    const input = opencodeAdapter.parseInput(
      { cwd: "/project", reason: "deleted", session_id: "sess-3" },
      "session-end",
    );
    expect(input.hookType).toBe("session-end");
    expect(input.sessionEndReason).toBe("deleted");
  });

  it("parseInput maps session.error to session-end", () => {
    const input = opencodeAdapter.parseInput(
      { cwd: "/project", reason: "error" },
      "session.error",
    );
    expect(input.hookType).toBe("session-end");
    expect(input.sessionEndReason).toBe("error");
  });

  it("parseInput normalizes notification (assistant_metadata)", () => {
    const input = opencodeAdapter.parseInput(
      {
        cwd: "/project",
        session_id: "sess-1",
        notification_type: "assistant_metadata",
        title: "Assistant Response",
        message: "Model: claude-sonnet, Cost: 0.05, Tokens: 1500",
        model: "claude-sonnet",
        cost: 0.05,
        tokens: { input: 1000, output: 500 },
      },
      "notification",
    );
    expect(input.hookType).toBe("notification");
    expect(input.notificationType).toBe("assistant_metadata");
    expect(input.notificationTitle).toBe("Assistant Response");
    expect(input.model).toBe("claude-sonnet");
    expect(input.rawPlatformData?.cost).toBe(0.05);
  });

  it("parseInput normalizes notification (tool_result)", () => {
    const input = opencodeAdapter.parseInput(
      {
        cwd: "/project",
        session_id: "sess-1",
        notification_type: "tool_result",
        title: "Read file.ts",
        message: "Tool read: Read file.ts",
        tool_name: "read",
        tool_input: { filePath: "file.ts" },
        tool_output: { content: "..." },
      },
      "notification",
    );
    expect(input.hookType).toBe("notification");
    expect(input.notificationType).toBe("tool_result");
    expect(input.toolName).toBe("read");
    expect(input.toolInput).toEqual({ filePath: "file.ts" });
  });

  it("parseInput normalizes task-completed (todo.updated)", () => {
    const input = opencodeAdapter.parseInput(
      {
        cwd: "/project",
        session_id: "sess-1",
        task_id: "todo-1",
        task_subject: "Add error handling",
        task_description: "Priority: high",
      },
      "task-completed",
    );
    expect(input.hookType).toBe("task-completed");
    expect(input.taskId).toBe("todo-1");
    expect(input.taskSubject).toBe("Add error handling");
    expect(input.taskDescription).toBe("Priority: high");
  });

  it("parseInput does not set transcriptPath (OpenCode has no transcript file)", () => {
    const input = opencodeAdapter.parseInput(
      { cwd: "/project", stop_reason: "completed" },
      "stop",
    );
    expect(input.transcriptPath).toBeUndefined();
  });

  it("generateHookConfig produces plugin file content", () => {
    const config = opencodeAdapter.generateHookConfig("npx adit-hook");
    expect(config.configPath).toBe(".opencode/plugins/adit.js");
    expect(config.content.plugin).toBeDefined();

    const pluginContent = config.content.plugin as string;
    expect(pluginContent).toContain("@adit/auto-generated");
    expect(pluginContent).toContain("adit-hook");
    expect(pluginContent).toContain("OPENCODE");
    // Core hooks
    expect(pluginContent).toContain("chat.message");
    // session.idle replaces the non-existent "stop" hook
    expect(pluginContent).toContain("session.idle");
    expect(pluginContent).toContain("session.created");
    expect(pluginContent).toContain("session.deleted");
    expect(pluginContent).toContain("session.error");
    // New events
    expect(pluginContent).toContain("message.part.updated");
    expect(pluginContent).toContain("todo.updated");
    // command.executed intercepts /exit synchronously
    expect(pluginContent).toContain("command.executed");
    expect(pluginContent).toContain("spawnAditHookSync");
    // process.on('exit') safety net for reliable cloud sync on exit
    expect(pluginContent).toContain('process.on("exit"');
    expect(pluginContent).toContain("flushOnExit");
    expect(pluginContent).toContain("SIGINT");
    expect(pluginContent).toContain("SIGTERM");
    // sessionEndFired flag prevents duplicate session-end calls
    expect(pluginContent).toContain("sessionEndFired");
    // Notification types — assistant_metadata removed (LLM cost/token tracking not needed)
    expect(pluginContent).not.toContain("message.updated");
    expect(pluginContent).not.toContain("assistant_metadata");
    expect(pluginContent).toContain("tool_result");
    expect(pluginContent).toContain("task-completed");
    // Removed: step_finish and session_diff are no longer recorded
    expect(pluginContent).not.toContain("step_finish");
    expect(pluginContent).not.toContain("session_diff");
    expect(pluginContent).not.toContain("session.diff");
  });

  it("generateHookConfig handles resolved binary path", () => {
    const config = opencodeAdapter.generateHookConfig('node "/path/to/hooks/dist/index.js"');
    const pluginContent = config.content.plugin as string;
    expect(pluginContent).toContain("/path/to/hooks/dist/index.js");
    expect(pluginContent).toContain('"node"');
  });

  it("validateInstallation reports missing plugin", async () => {
    const result = await opencodeAdapter.validateInstallation("/nonexistent/path");
    expect(result.valid).toBe(false);
    expect(result.checks.some((c) => !c.ok && c.detail.includes("Not found"))).toBe(true);
  });
});
