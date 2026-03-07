/**
 * Tests for Claude Code adapter hook chaining (install/uninstall).
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
import { claudeCodeAdapter } from "./claude-code.js";

/** Create a unique temp directory for each test */
function tempProjectRoot(): string {
  const dir = join(tmpdir(), `adit-hook-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readSettings(projectRoot: string): Record<string, unknown> {
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  return JSON.parse(readFileSync(settingsPath, "utf-8"));
}

function writeSettings(projectRoot: string, settings: Record<string, unknown>): void {
  const claudeDir = join(projectRoot, ".claude");
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
  writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify(settings, null, 2) + "\n");
}

describe("Claude Code Hook Chaining", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = tempProjectRoot();
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("installs hooks into an empty project (no existing settings)", async () => {
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.SessionEnd).toBeDefined();
    expect(hooks.TaskCompleted).toBeDefined();
    expect(hooks.Notification).toBeDefined();
    expect(hooks.SubagentStart).toBeDefined();
    expect(hooks.SubagentStop).toBeDefined();

    // Each event should have exactly one matcher group with one ADIT hook
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
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
        Stop: [
          { hooks: [{ type: "command", command: "entire hook stop", timeout: 5000 }] },
        ],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // SessionStart should have both: Entire's hook + ADIT's hook
    const sessionStartEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStartEntries).toHaveLength(2);
    expect(sessionStartEntries[0].hooks[0].command).toContain("entire");
    expect(sessionStartEntries[1].hooks[0].command).toContain("adit-hook");

    // Stop should also have both
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(2);
    expect(stopEntries[0].hooks[0].command).toContain("entire");
    expect(stopEntries[1].hooks[0].command).toContain("adit-hook");
  });

  it("replaces stale ADIT hooks on reinstall (no duplicates)", async () => {
    // Simulate a previous ADIT install
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    // Reinstall with a different binary path (e.g., after update)
    await claudeCodeAdapter.installHooks(projectRoot, 'node "/new/path/hooks/dist/index.js"');

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // Should have exactly one entry per event, with the new path
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("/new/path/hooks/dist/index.js");
    expect(stopEntries[0].hooks[0].command).not.toContain("npx adit-hook");
  });

  it("preserves other tools' hooks on reinstall while replacing ADIT's", async () => {
    // Setup: another tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "my-linter check", timeout: 3000 }],
    };
    writeSettings(projectRoot, {
      hooks: {
        UserPromptSubmit: [otherToolHook],
      },
    });

    // First ADIT install
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let settings = readSettings(projectRoot);
    let entries = (settings.hooks as Record<string, unknown[]>).UserPromptSubmit as unknown[];
    expect(entries).toHaveLength(2);

    // Reinstall ADIT (should replace old ADIT, keep linter)
    await claudeCodeAdapter.installHooks(projectRoot, 'node "/updated/hooks/dist/index.js"');

    settings = readSettings(projectRoot);
    entries = (settings.hooks as Record<string, unknown[]>).UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
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
        PostToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "my-formatter run" }] },
        ],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // PostToolUse should be preserved exactly as-is
    const postToolEntries = hooks.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(postToolEntries).toHaveLength(1);
    expect(postToolEntries[0].matcher).toBe("Write|Edit");
    expect(postToolEntries[0].hooks[0].command).toBe("my-formatter run");

    // ADIT hooks should also be present
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.Stop).toBeDefined();
  });

  it("preserves non-hook settings keys", async () => {
    writeSettings(projectRoot, {
      permissions: { allow: ["read", "write"] },
      model: "claude-sonnet-4-20250514",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "other-tool stop" }] }],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    expect(settings.permissions).toEqual({ allow: ["read", "write"] });
    expect(settings.model).toBe("claude-sonnet-4-20250514");
  });

  it("handles corrupted settings file gracefully", async () => {
    const claudeDir = join(projectRoot, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), "{ invalid json }}}");

    // Should not throw — starts fresh
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toBeDefined();
  });

  it("uninstallHooks removes only ADIT entries, preserves others", async () => {
    // Setup: other tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "entire hook stop", timeout: 5000 }],
    };
    writeSettings(projectRoot, {
      hooks: {
        Stop: [otherToolHook],
        SessionStart: [
          { hooks: [{ type: "command", command: "entire hook session-start" }] },
        ],
      },
    });

    // Install ADIT alongside
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let settings = readSettings(projectRoot);
    expect((settings.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);

    // Uninstall ADIT
    await claudeCodeAdapter.uninstallHooks(projectRoot);

    settings = readSettings(projectRoot);
    const hooks = settings.hooks as Record<string, unknown[]>;

    // Entire's hooks should remain
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("entire");

    const sessionEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0].hooks[0].command).toContain("entire");
  });

  it("uninstallHooks cleans up empty event arrays and hooks object", async () => {
    // Only ADIT hooks installed
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    await claudeCodeAdapter.uninstallHooks(projectRoot);

    const settings = readSettings(projectRoot);
    // hooks key should be deleted entirely when all events are empty
    expect(settings.hooks).toBeUndefined();
  });

  it("handles flat command entries from other tools", async () => {
    // Some tools may use flat command format instead of nested hooks array
    writeSettings(projectRoot, {
      hooks: {
        Stop: [
          { command: "my-tool stop", type: "command" },
        ],
      },
    });

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const settings = readSettings(projectRoot);
    const stopEntries = (settings.hooks as Record<string, unknown[]>).Stop;
    // Should preserve the flat entry + add ADIT's nested entry
    expect(stopEntries).toHaveLength(2);
  });

  it("install is idempotent — multiple installs with same path produce same result", async () => {
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
    const first = readSettings(projectRoot);

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
    const second = readSettings(projectRoot);

    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");
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
    await claudeCodeAdapter.installHooks(projectRoot, "npx adit-hook");

    const result = await claudeCodeAdapter.validateInstallation(projectRoot);
    expect(result.valid).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });
});
