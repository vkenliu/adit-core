import { describe, it, expect } from "vitest";
import { getAdapter, listAdapters, detectPlatform, registerAdapter } from "./registry.js";
import { claudeCodeAdapter } from "./claude-code.js";
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

  it("lists all registered adapters", () => {
    const adapters = listAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(1);
    expect(adapters.find((a) => a.platform === "claude-code")).toBeDefined();
  });

  it("detects platform from environment", () => {
    // Default should be claude-code
    const platform = detectPlatform();
    expect(["claude-code", "cursor", "copilot", "other"]).toContain(platform);
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
    expect(claudeCodeAdapter.hookMappings).toHaveLength(9);

    const mappings = claudeCodeAdapter.hookMappings.map((m) => m.platformEvent);
    expect(mappings).toContain("UserPromptSubmit");
    expect(mappings).toContain("PostToolUse");
    expect(mappings).toContain("Stop");
    expect(mappings).toContain("SessionStart");
    expect(mappings).toContain("SessionEnd");
    expect(mappings).toContain("TaskCompleted");
    expect(mappings).toContain("Notification");
    expect(mappings).toContain("SubagentStart");
    expect(mappings).toContain("SubagentStop");
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

  it("parseInput normalizes tool-use", () => {
    const input = claudeCodeAdapter.parseInput(
      { cwd: "/project", tool_name: "Write", tool_input: { path: "/a.ts" } },
      "PostToolUse",
    );
    expect(input.hookType).toBe("tool-use");
    expect(input.toolName).toBe("Write");
    expect(input.toolInput).toEqual({ path: "/a.ts" });
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

  it("generateHookConfig produces valid structure with async hooks", () => {
    const config = claudeCodeAdapter.generateHookConfig("npx adit-hook");
    expect(config.configPath).toBe(".claude/settings.local.json");
    expect(config.content.hooks).toBeDefined();

    const hooks = config.content.hooks as Record<string, unknown>;
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.SessionEnd).toBeDefined();
    expect(hooks.TaskCompleted).toBeDefined();
    expect(hooks.Notification).toBeDefined();
    expect(hooks.SubagentStart).toBeDefined();
    expect(hooks.SubagentStop).toBeDefined();

    // Verify async: true is set on all hooks
    for (const hookName of Object.keys(hooks)) {
      const entries = hooks[hookName] as Array<{
        hooks: Array<{ type: string; command: string; async: boolean }>;
      }>;
      expect(entries[0].hooks[0].async).toBe(true);
    }
  });
});
