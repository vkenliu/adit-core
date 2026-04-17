/**
 * Tests for Gemini CLI adapter hook chaining (install/uninstall).
 *
 * Validates that installHooks() appends ADIT entries alongside
 * other tools' hooks instead of overwriting them, and that
 * uninstallHooks() removes only ADIT entries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { geminiAdapter } from "./gemini.js";

/** Create a unique temp directory for each test */
function tempProjectRoot(): string {
  const dir = join(tmpdir(), `adit-hook-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readSettings(projectRoot: string): Record<string, unknown> {
  const settingsPath = join(projectRoot, ".gemini", "settings.json");
  return JSON.parse(readFileSync(settingsPath, "utf-8"));
}

function writeSettings(projectRoot: string, settings: Record<string, unknown>): void {
  const geminiDir = join(projectRoot, ".gemini");
  if (!existsSync(geminiDir)) {
    mkdirSync(geminiDir, { recursive: true });
  }
  writeFileSync(join(geminiDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

describe("Gemini CLI Hook Chaining", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = tempProjectRoot();
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("has 6 hook mappings", () => {
    expect(geminiAdapter.hookMappings).toHaveLength(6);
    expect(geminiAdapter.hookMappings.map(m => m.platformEvent)).toEqual([
      "SessionStart",
      "BeforeAgent",
      "AfterAgent",
      "SessionEnd",
      "AfterTool",
      "Notification"
    ]);
  });

  describe("parseInput", () => {
    it("parses BeforeAgent event", () => {
      const raw = {
        session_id: "session123",
        cwd: "/project",
        hook_event_name: "BeforeAgent",
        timestamp: "2024-01-01T12:00:00Z",
        prompt: "What's the weather?",
        model: "gemini-pro"
      };

      const result = geminiAdapter.parseInput(raw, "BeforeAgent");

      expect(result.hookType).toBe("prompt-submit");
      expect(result.platformCli).toBe("gemini");
      expect(result.platformSessionId).toBe("session123");
      expect(result.cwd).toBe("/project");
      expect(result.prompt).toBe("What's the weather?");
      expect(result.rawPlatformData).toEqual(raw);
    });

    it("parses AfterAgent event", () => {
      const raw = {
        session_id: "session123",
        cwd: "/project",
        hook_event_name: "AfterAgent",
        timestamp: "2024-01-01T12:05:00Z",
        stop_hook_active: true,
        prompt: "Initial prompt",
        prompt_response: "The weather is sunny",
        model: "gemini-pro"
      };

      const result = geminiAdapter.parseInput(raw, "AfterAgent");

      expect(result.hookType).toBe("stop");
      expect(result.platformSessionId).toBe("session123");
      expect(result.stopHookActive).toBe(true);
      expect(result.prompt).toBe("Initial prompt");
      expect(result.lastAssistantMessage).toBe("The weather is sunny");
    });

    it("parses AfterTool event", () => {
      const raw = {
        session_id: "session123",
        cwd: "/project",
        hook_event_name: "AfterTool",
        timestamp: "2024-01-01T12:10:00Z",
        tool_name: "readFile",
        tool_input: { path: "/test.txt" },
        tool_response: { content: "Hello World" },
        model: "gemini-pro"
      };

      const result = geminiAdapter.parseInput(raw, "AfterTool");

      expect(result.hookType).toBe("notification");
      expect(result.toolName).toBe("readFile");
      expect(result.toolInput).toEqual({ path: "/test.txt" });
      expect(result.toolOutput).toEqual({ content: "Hello World" });
    });

    it("parses Notification event", () => {
      const raw = {
        session_id: "session123",
        cwd: "/project",
        hook_event_name: "Notification",
        timestamp: "2024-01-01T12:15:00Z",
        notification_type: "info",
        message: "Tool completed successfully",
        title: "Tool Result",
        model: "gemini-pro"
      };

      const result = geminiAdapter.parseInput(raw, "Notification");

      expect(result.hookType).toBe("notification");
      expect(result.notificationType).toBe("info");
      expect(result.notificationMessage).toBe("Tool completed successfully");
      expect(result.notificationTitle).toBe("Tool Result");
    });

    it("parses SessionStart event", () => {
      const raw = {
        session_id: "session123",
        cwd: "/project",
        hook_event_name: "SessionStart",
        timestamp: "2024-01-01T12:00:00Z",
        source: "startup",
        model: "gemini-pro"
      };

      const result = geminiAdapter.parseInput(raw, "SessionStart");

      expect(result.hookType).toBe("session-start");
      expect(result.sessionSource).toBe("startup");
    });

    it("parses SessionEnd event", () => {
      const raw = {
        session_id: "session123",
        cwd: "/project",
        hook_event_name: "SessionEnd",
        timestamp: "2024-01-01T12:30:00Z",
        reason: "exit",
        model: "gemini-pro"
      };

      const result = geminiAdapter.parseInput(raw, "SessionEnd");

      expect(result.hookType).toBe("session-end");
      expect(result.sessionEndReason).toBe("exit");
    });
  });

  describe("generateHookConfig", () => {
    it("generates correct config structure", () => {
      const config = geminiAdapter.generateHookConfig("npx adit-hook");

      expect(config.configPath).toBe(".gemini/settings.json");
      expect(config.content.hooks).toBeDefined();
      expect(Object.keys(config.content.hooks)).toHaveLength(6);
      expect(config.content.hooks.SessionStart).toBeDefined();
      expect(config.content.hooks.BeforeAgent).toBeDefined();
      expect(config.content.hooks.AfterAgent).toBeDefined();
      expect(config.content.hooks.SessionEnd).toBeDefined();
      expect(config.content.hooks.AfterTool).toBeDefined();
      expect(config.content.hooks.Notification).toBeDefined();
    });

    it("uses GEMINI=1 prefix and timeout 5000", () => {
      const config = geminiAdapter.generateHookConfig("npx adit-hook");

      const entry = config.content.hooks.SessionStart[0];
      expect((entry as { hooks: Array<{ command: string }> }).hooks[0].command).toContain("GEMINI=1");
      expect((entry as { hooks: Array<{ command: string }> }).hooks[0].command).toContain("npx adit-hook");
      expect((entry as { hooks: Array<{ command: string }> }).hooks[0].command).toContain("session-start");
      expect((entry as { hooks: Array<{ command: string }> }).hooks[0].timeout).toBe(5000);
    });
  });

  it("installs hooks into an empty project (no existing settings)", async () => {
    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.BeforeAgent).toBeDefined();
    expect(hooks.AfterAgent).toBeDefined();
    expect(hooks.SessionEnd).toBeDefined();
    expect(hooks.AfterTool).toBeDefined();
    expect(hooks.Notification).toBeDefined();

    // Each event should have exactly one matcher group with one ADIT hook
    const stopEntries = hooks.AfterAgent as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("adit-hook");
  });

  it("preserves other tools' hooks when installing ADIT hooks", async () => {
    // Pre-install another tool's hooks (e.g., Entire CLI)
    const otherToolHook = {
      hooks: [
        { type: "command", command: "entire hook session-start", timeout: 5000 },
      ],
    };
    writeSettings(projectRoot, {
      hooks: {
        SessionStart: [otherToolHook],
        AfterAgent: [
          { hooks: [{ type: "command", command: "entire hook stop", timeout: 5000 }] },
        ],
      },
    });

    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // SessionStart should have both: Entire's hook + ADIT's hook
    const sessionStartEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStartEntries).toHaveLength(2);
    expect(sessionStartEntries[0].hooks[0].command).toContain("entire");
    expect(sessionStartEntries[1].hooks[0].command).toContain("adit-hook");

    // AfterAgent should also have both
    const afterAgentEntries = hooks.AfterAgent as Array<{ hooks: Array<{ command: string }> }>;
    expect(afterAgentEntries).toHaveLength(2);
    expect(afterAgentEntries[0].hooks[0].command).toContain("entire");
    expect(afterAgentEntries[1].hooks[0].command).toContain("adit-hook");
  });

  it("replaces stale ADIT hooks on reinstall (no duplicates)", async () => {
    // Simulate a previous ADIT install
    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    // Reinstall with a different binary path (e.g., after update)
    await geminiAdapter.installHooks(projectRoot, 'node "/new/path/hooks/dist/index.js"');

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // Should have exactly one entry per event, with the new path
    const afterAgentEntries = hooks.AfterAgent as Array<{ hooks: Array<{ command: string }> }>;
    expect(afterAgentEntries).toHaveLength(1);
    expect(afterAgentEntries[0].hooks[0].command).toContain("/new/path/hooks/dist/index.js");
    expect(afterAgentEntries[0].hooks[0].command).not.toContain("npx adit-hook");
  });

  it("preserves other tools' hooks on reinstall while replacing ADIT's", async () => {
    // Setup: another tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "my-linter check", timeout: 3000 }],
    };
    writeSettings(projectRoot, {
      hooks: {
        BeforeAgent: [otherToolHook],
      },
    });

    // First ADIT install
    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let settings = readSettings(projectRoot);
    let entries = (settings.hooks as Record<string, unknown[]>).BeforeAgent as unknown[];
    expect(entries).toHaveLength(2);

    // Reinstall ADIT (should replace old ADIT, keep linter)
    await geminiAdapter.installHooks(projectRoot, 'node "/updated/hooks/dist/index.js"');

    settings = readSettings(projectRoot);
    entries = (settings.hooks as Record<string, unknown[]>).BeforeAgent as Array<{ hooks: Array<{ command: string }> }>;
    expect(entries).toHaveLength(2);

    const commands = (entries as Array<{ hooks: Array<{ command: string }> }>).map(
      (e) => e.hooks[0].command,
    );
    expect(commands).toContain("my-linter check");
    expect(commands.some((c) => c.includes("/updated/hooks/dist/index.js"))).toBe(true);
    expect(commands.some((c) => c.includes("npx adit-hook"))).toBe(false);
  });

  it("preserves hook events that ADIT does not use", async () => {
    // Another tool registers a custom hook event ADIT doesn't know about
    writeSettings(projectRoot, {
      hooks: {
        BeforeQuery: [
          { matcher: "SELECT|CREATE", hooks: [{ type: "command", command: "sql-validator run" }] },
        ],
      },
    });

    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // BeforeQuery should be preserved exactly as-is
    const beforeQueryEntries = hooks.BeforeQuery as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(beforeQueryEntries).toHaveLength(1);
    expect(beforeQueryEntries[0].matcher).toBe("SELECT|CREATE");
    expect(beforeQueryEntries[0].hooks[0].command).toBe("sql-validator run");

    // ADIT hooks should also be present
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.AfterAgent).toBeDefined();
  });

  it("preserves non-hook settings keys", async () => {
    writeSettings(projectRoot, {
      model: "gemini-pro",
      permissions: { allow: ["read", "write"] },
      hooks: {
        AfterAgent: [{ hooks: [{ type: "command", command: "other-tool stop" }] }],
      },
    });

    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    expect(settings.model).toBe("gemini-pro");
    expect(settings.permissions).toEqual({ allow: ["read", "write"] });
  });

  it("handles corrupted settings file gracefully", async () => {
    const geminiDir = join(projectRoot, ".gemini");
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(join(geminiDir, "settings.json"), "{ invalid json }}}");

    // Should not throw — starts fresh
    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.AfterAgent).toBeDefined();
  });

  it("uninstallHooks removes only ADIT entries, preserves others", async () => {
    // Setup: other tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "entire hook stop", timeout: 5000 }],
    };
    writeSettings(projectRoot, {
      hooks: {
        AfterAgent: [otherToolHook],
        SessionStart: [
          { hooks: [{ type: "command", command: "entire hook session-start" }] },
        ],
      },
    });

    // Install ADIT alongside
    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let settings = readSettings(projectRoot);
    expect((settings.hooks as Record<string, unknown[]>).AfterAgent).toHaveLength(2);

    // Uninstall ADIT
    await geminiAdapter.uninstallHooks(projectRoot);

    settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // Entire's hooks should remain
    const afterAgentEntries = hooks.AfterAgent as Array<{ hooks: Array<{ command: string }> }>;
    expect(afterAgentEntries).toHaveLength(1);
    expect(afterAgentEntries[0].hooks[0].command).toContain("entire");

    const sessionStartEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStartEntries).toHaveLength(1);
    expect(sessionStartEntries[0].hooks[0].command).toContain("entire");
  });

  it("uninstallHooks cleans up empty event arrays and hooks object", async () => {
    // Only ADIT hooks installed
    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    await geminiAdapter.uninstallHooks(projectRoot);

    const settings = readSettings(projectRoot);
    // hooks key should be deleted entirely when all events are empty
    expect(settings.hooks).toBeUndefined();
  });

  it("handles flat command entries from other tools", async () => {
    // Some tools may use flat command format instead of nested hooks array
    writeSettings(projectRoot, {
      hooks: {
        AfterAgent: [
          { command: "my-tool stop", type: "command" },
        ],
      },
    });

    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const afterAgentEntries = (settings.hooks as Record<string, unknown[]>).AfterAgent;
    // Should preserve the flat entry + add ADIT's nested entry
    expect(afterAgentEntries).toHaveLength(2);
  });

  it("install is idempotent — multiple installs with same path produce same result", async () => {
    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");
    const first = readSettings(projectRoot);

    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");
    const second = readSettings(projectRoot);

    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");
    const third = readSettings(projectRoot);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("validateInstallation detects ADIT hooks in chained configuration", async () => {
    // Other tool installed first
    writeSettings(projectRoot, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "entire hook session-start" }] },
        ],
      },
    });

    // Install ADIT alongside
    await geminiAdapter.installHooks(projectRoot, "npx adit-hook");

    const result = await geminiAdapter.validateInstallation(projectRoot);
    expect(result.valid).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });
});