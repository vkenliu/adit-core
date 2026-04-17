/**
 * Tests for Cursor adapter.
 *
 * Validates hook generation in Cursor's native flat format,
 * install/uninstall chaining, stdin field mapping, and
 * legacy Claude Code format migration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { cursorAdapter, extractLastAssistantMessage } from "./cursor.js";

/** Create a unique temp directory for each test */
function tempProjectRoot(): string {
  const dir = join(tmpdir(), `adit-hook-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readHooks(projectRoot: string): Record<string, unknown> {
  const hooksPath = join(projectRoot, ".cursor", "hooks.json");
  const config = JSON.parse(readFileSync(hooksPath, "utf-8"));
  return config.hooks ?? config;
}

function readFullConfig(projectRoot: string): Record<string, unknown> {
  const hooksPath = join(projectRoot, ".cursor", "hooks.json");
  return JSON.parse(readFileSync(hooksPath, "utf-8"));
}

function writeHooks(projectRoot: string, hooks: Record<string, unknown>): void {
  const cursorDir = join(projectRoot, ".cursor");
  if (!existsSync(cursorDir)) {
    mkdirSync(cursorDir, { recursive: true });
  }
  writeFileSync(join(cursorDir, "hooks.json"), JSON.stringify(hooks, null, 2) + "\n");
}

describe("Cursor Adapter - Hook Generation", () => {
  it("generates hooks in Cursor's native flat format", () => {
    const config = cursorAdapter.generateHookConfig("npx adit-hook");
    const hooks = config.content.hooks as Record<string, unknown[]>;

    // Verify event names match Cursor's native names
    expect(hooks.beforeSubmitPrompt).toBeDefined();
    expect(hooks.stop).toBeDefined();
    expect(hooks.sessionStart).toBeDefined();
    expect(hooks.sessionEnd).toBeDefined();
    expect(hooks.afterAgentResponse).toBeDefined();

    // Verify flat format (no nested "hooks" array)
    const stopEntry = hooks.stop[0] as { command: string; type: string; timeout: number };
    expect(stopEntry.command).toBeDefined();
    expect(stopEntry.type).toBe("command");
    expect(stopEntry.timeout).toBe(10); // seconds, not milliseconds
    expect(typeof stopEntry).toBe("object");
    expect(Array.isArray((stopEntry as Record<string, unknown>).hooks)).toBe(false);
  });

  it("includes CURSOR=1 prefix in commands", () => {
    const config = cursorAdapter.generateHookConfig("npx adit-hook");
    const hooks = config.content.hooks as Record<string, unknown[]>;

    for (const [, entries] of Object.entries(hooks)) {
      const entry = (entries as Array<{ command: string }>)[0];
      expect(entry.command).toMatch(/^CURSOR=1 /);
    }
  });

  it("uses correct config path", () => {
    const config = cursorAdapter.generateHookConfig("npx adit-hook");
    expect(config.configPath).toBe(".cursor/hooks.json");
  });
});

describe("Cursor Adapter - parseInput", () => {
  it("maps Cursor stdin fields to NormalizedHookInput", () => {
    const raw = {
      conversation_id: "conv-123",
      generation_id: "gen-456",
      model: "claude-sonnet-4-6",
      hook_event_name: "beforeSubmitPrompt",
      cursor_version: "1.7.2",
      workspace_roots: ["/path/to/project"],
      user_email: "user@example.com",
      transcript_path: "/path/to/transcript.jsonl",
    };

    const input = cursorAdapter.parseInput(raw, "prompt-submit");

    expect(input.cwd).toBe("/path/to/project");
    expect(input.platformSessionId).toBe("conv-123");
    expect(input.transcriptPath).toBe("/path/to/transcript.jsonl");
    expect(input.model).toBe("claude-sonnet-4-6");
    expect(input.platformCli).toBe("cursor");
    expect(input.hookType).toBe("prompt-submit");
    expect(input.rawPlatformData).toBe(raw);
  });

  it("uses session_id when conversation_id is absent (sessionStart/sessionEnd)", () => {
    const raw = {
      session_id: "sess-789",
      is_background_agent: false,
      composer_mode: "agent",
      model: "claude-sonnet-4-6",
    };

    const input = cursorAdapter.parseInput(raw, "session-start");

    expect(input.platformSessionId).toBe("sess-789");
    expect(input.sessionSource).toBe("agent");
  });

  it("maps sessionEnd reason field", () => {
    const raw = {
      session_id: "sess-789",
      reason: "completed",
      duration_ms: 5000,
      final_status: "success",
    };

    const input = cursorAdapter.parseInput(raw, "session-end");

    expect(input.sessionEndReason).toBe("completed");
  });

  it("falls back to CURSOR_PROJECT_DIR env when workspace_roots is absent", () => {
    const original = process.env.CURSOR_PROJECT_DIR;
    process.env.CURSOR_PROJECT_DIR = "/env/project/dir";

    try {
      const raw = { conversation_id: "conv-1" };
      const input = cursorAdapter.parseInput(raw, "prompt-submit");
      expect(input.cwd).toBe("/env/project/dir");
    } finally {
      if (original !== undefined) {
        process.env.CURSOR_PROJECT_DIR = original;
      } else {
        delete process.env.CURSOR_PROJECT_DIR;
      }
    }
  });

  it("falls back to process.cwd() when neither workspace_roots nor CURSOR_PROJECT_DIR is set", () => {
    const original = process.env.CURSOR_PROJECT_DIR;
    delete process.env.CURSOR_PROJECT_DIR;

    try {
      const raw = { conversation_id: "conv-1" };
      const input = cursorAdapter.parseInput(raw, "prompt-submit");
      expect(input.cwd).toBe(process.cwd());
    } finally {
      if (original !== undefined) {
        process.env.CURSOR_PROJECT_DIR = original;
      }
    }
  });
});

describe("Cursor Hook Chaining (install/uninstall)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = tempProjectRoot();
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("installs hooks into an empty project (no existing hooks)", async () => {
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = readHooks(projectRoot);

    expect(hooks.beforeSubmitPrompt).toBeDefined();
    expect(hooks.stop).toBeDefined();
    expect(hooks.sessionStart).toBeDefined();
    expect(hooks.sessionEnd).toBeDefined();
    expect(hooks.afterAgentResponse).toBeDefined();

    // Each event should have exactly one flat entry
    const stopEntries = hooks.stop as Array<{ command: string; type: string; timeout: number }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].command).toContain("adit-hook");
    expect(stopEntries[0].type).toBe("command");
    expect(stopEntries[0].timeout).toBe(10);
  });

  it("preserves other tools' hooks when installing ADIT hooks", async () => {
    // Pre-install another tool's hooks in Cursor's flat format
    writeHooks(projectRoot, {
      hooks: {
        sessionStart: [
          { command: "entire hook session-start", type: "command", timeout: 5 },
        ],
        stop: [
          { command: "entire hook stop", type: "command", timeout: 5 },
        ],
      },
    });

    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = readHooks(projectRoot);

    // sessionStart should have both: Entire's hook + ADIT's hook
    const sessionStartEntries = hooks.sessionStart as Array<{ command: string }>;
    expect(sessionStartEntries).toHaveLength(2);
    expect(sessionStartEntries[0].command).toContain("entire");
    expect(sessionStartEntries[1].command).toContain("adit-hook");

    // stop should also have both
    const stopEntries = hooks.stop as Array<{ command: string }>;
    expect(stopEntries).toHaveLength(2);
    expect(stopEntries[0].command).toContain("entire");
    expect(stopEntries[1].command).toContain("adit-hook");
  });

  it("replaces stale ADIT hooks on reinstall (no duplicates)", async () => {
    // Simulate a previous ADIT install
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    // Reinstall with a different binary path (e.g., after update)
    await cursorAdapter.installHooks(projectRoot, 'node "/new/path/hooks/dist/index.js"');

    const hooks = readHooks(projectRoot);

    // Should have exactly one entry per event, with the new path
    const stopEntries = hooks.stop as Array<{ command: string }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].command).toContain("/new/path/hooks/dist/index.js");
    expect(stopEntries[0].command).not.toContain("npx adit-hook");
  });

  it("preserves other tools' hooks on reinstall while replacing ADIT's", async () => {
    // Setup: another tool + ADIT
    writeHooks(projectRoot, {
      hooks: {
        beforeSubmitPrompt: [
          { command: "my-linter check", type: "command", timeout: 3 },
        ],
      },
    });

    // First ADIT install
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let hooks = readHooks(projectRoot);
    let entries = hooks.beforeSubmitPrompt as unknown[];
    expect(entries).toHaveLength(2);

    // Reinstall ADIT (should replace old ADIT, keep linter)
    await cursorAdapter.installHooks(projectRoot, 'node "/updated/hooks/dist/index.js"');

    hooks = readHooks(projectRoot);
    entries = hooks.beforeSubmitPrompt as Array<{ command: string }>;
    expect(entries).toHaveLength(2);

    const commands = (entries as Array<{ command: string }>).map((e) => e.command);
    expect(commands).toContain("my-linter check");
    expect(commands.some((c) => c.includes("/updated/hooks/dist/index.js"))).toBe(true);
    expect(commands.some((c) => c.includes("npx adit-hook"))).toBe(false);
  });

  it("preserves hook events that ADIT does not use", async () => {
    // Another tool registers a custom hook event ADIT doesn't know about
    writeHooks(projectRoot, {
      hooks: {
        preToolUse: [
          { command: "my-formatter run", matcher: "Write|Edit" },
        ],
      },
    });

    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = readHooks(projectRoot);

    // preToolUse should be preserved exactly as-is
    const preToolEntries = hooks.preToolUse as Array<{ command: string; matcher: string }>;
    expect(preToolEntries).toHaveLength(1);
    expect(preToolEntries[0].command).toBe("my-formatter run");
    expect(preToolEntries[0].matcher).toBe("Write|Edit");

    // ADIT hooks should also be present
    expect(hooks.sessionStart).toBeDefined();
    expect(hooks.stop).toBeDefined();
  });

  it("preserves non-hooks settings keys", async () => {
    writeHooks(projectRoot, {
      version: 1,
      settings: { theme: "dark" },
      hooks: {
        stop: [{ command: "other-tool stop", type: "command" }],
      },
    });

    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    // Read full config to verify non-hooks keys preserved
    const fullConfig = readFullConfig(projectRoot);
    expect(fullConfig.version).toBe(1);
    expect(fullConfig.settings).toEqual({ theme: "dark" });
  });

  it("handles corrupted hooks file gracefully", async () => {
    const cursorDir = join(projectRoot, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "hooks.json"), "{ invalid json }}}");

    // Should not throw — starts fresh
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = readHooks(projectRoot);
    expect(hooks.stop).toBeDefined();
  });

  it("uninstallHooks removes only ADIT entries, preserves others", async () => {
    // Setup: other tool + ADIT
    writeHooks(projectRoot, {
      hooks: {
        stop: [
          { command: "entire hook stop", type: "command", timeout: 5 },
        ],
        sessionStart: [
          { command: "entire hook session-start", type: "command" },
        ],
      },
    });

    // Install ADIT alongside
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let hooks = readHooks(projectRoot);
    expect(hooks.stop).toHaveLength(2);

    // Uninstall ADIT
    await cursorAdapter.uninstallHooks(projectRoot);

    hooks = readHooks(projectRoot);

    // Entire's hooks should remain
    const stopEntries = hooks.stop as Array<{ command: string }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].command).toContain("entire");

    const sessionEntries = hooks.sessionStart as Array<{ command: string }>;
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0].command).toContain("entire");
  });

  it("uninstallHooks cleans up empty event arrays and hooks object", async () => {
    // Only ADIT hooks installed
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    await cursorAdapter.uninstallHooks(projectRoot);

    const hooks = readHooks(projectRoot);
    // hooks object should still exist but be empty
    expect(hooks).toEqual({});
  });

  it("install is idempotent — multiple installs with same path produce same result", async () => {
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    const first = readHooks(projectRoot);

    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    const second = readHooks(projectRoot);

    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");
    const third = readHooks(projectRoot);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("validateInstallation detects ADIT hooks in chained configuration", async () => {
    // Other tool installed first
    writeHooks(projectRoot, {
      hooks: {
        sessionStart: [
          { command: "entire hook session-start", type: "command" },
        ],
      },
    });

    // Install ADIT alongside
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    const result = await cursorAdapter.validateInstallation(projectRoot);
    expect(result.valid).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("migrates legacy Claude Code format entries during install", async () => {
    // Simulate old ADIT install with Claude Code format event names + nested structure
    writeHooks(projectRoot, {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "CURSOR=1 npx adit-hook prompt-submit", timeout: 10000 }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: "CURSOR=1 npx adit-hook stop", timeout: 10000 }] },
        ],
        SessionStart: [
          { hooks: [{ type: "command", command: "CURSOR=1 npx adit-hook session-start", timeout: 10000 }] },
        ],
        SessionEnd: [
          { hooks: [{ type: "command", command: "CURSOR=1 npx adit-hook session-end", timeout: 10000 }] },
        ],
        Notification: [
          { hooks: [{ type: "command", command: "CURSOR=1 npx adit-hook notification", timeout: 10000 }] },
        ],
      },
    });

    // Reinstall with new format
    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = readHooks(projectRoot);

    // Legacy keys should be gone
    expect(hooks.UserPromptSubmit).toBeUndefined();
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.SessionStart).toBeUndefined();
    expect(hooks.SessionEnd).toBeUndefined();
    expect(hooks.Notification).toBeUndefined();

    // New Cursor-native keys should be present with flat format
    expect(hooks.beforeSubmitPrompt).toBeDefined();
    expect(hooks.stop).toBeDefined();
    expect(hooks.sessionStart).toBeDefined();
    expect(hooks.sessionEnd).toBeDefined();
    expect(hooks.afterAgentResponse).toBeDefined();
  });

  it("uninstallHooks also cleans up legacy Claude Code format entries", async () => {
    // Simulate old ADIT install
    writeHooks(projectRoot, {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "CURSOR=1 npx adit-hook prompt-submit" }] },
        ],
        Stop: [
          { hooks: [{ type: "command", command: "CURSOR=1 npx adit-hook stop" }] },
        ],
      },
    });

    await cursorAdapter.uninstallHooks(projectRoot);

    const hooks = readHooks(projectRoot);
    expect(hooks.UserPromptSubmit).toBeUndefined();
    expect(hooks.Stop).toBeUndefined();
  });

  it("handles other tools' hooks in nested format alongside flat ADIT entries", async () => {
    // Some tool might use the Claude Code nested format
    writeHooks(projectRoot, {
      hooks: {
        stop: [
          { hooks: [{ type: "command", command: "other-tool stop", timeout: 5000 }] },
        ],
      },
    });

    await cursorAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooks = readHooks(projectRoot);
    const stopEntries = hooks.stop as unknown[];
    expect(stopEntries).toHaveLength(2);
  });
});

describe("Cursor Adapter - extractLastAssistantMessage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `adit-transcript-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("extracts last assistant text from JSONL transcript", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Hi there!" }] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Hi there!");
  });

  it("extracts multi-block assistant message", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "explain" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [
        { type: "text", text: "Part one." },
        { type: "tool_use", name: "ReadFile", input: {} },
        { type: "text", text: "Part two." },
      ] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Part one.\nPart two.");
  });

  it("returns last assistant message when multiple exist", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "q1" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "a1" }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "q2" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "a2" }] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("a2");
  });

  it("returns undefined for file with no assistant messages", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }),
    ].join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBeUndefined();
  });

  it("returns undefined for nonexistent file", () => {
    const result = extractLastAssistantMessage(join(tempDir, "nope.jsonl"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty file", () => {
    const transcriptPath = join(tempDir, "empty.jsonl");
    writeFileSync(transcriptPath, "");
    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBeUndefined();
  });

  it("skips assistant entries with only tool_use (no text)", () => {
    const transcriptPath = join(tempDir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: {} }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Done!" }] } }),
    ].join("\n") + "\n");

    // Scans backwards — finds "Done!" first
    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Done!");
  });

  it("handles large files by reading only the tail", () => {
    const transcriptPath = join(tempDir, "large.jsonl");
    // Write 200 lines to ensure tail-only reading
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `filler ${i}` }] } }));
    }
    // The important line is at the very end
    lines.push(JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Final answer" }] } }));
    writeFileSync(transcriptPath, lines.join("\n") + "\n");

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe("Final answer");
  });
});

describe("Cursor Adapter - parseInput stop fields", () => {
  it("maps raw.status to stopReason for stop events", () => {
    const raw = {
      conversation_id: "conv-123",
      workspace_roots: ["/path/to/project"],
      status: "completed",
    };

    const input = cursorAdapter.parseInput(raw, "stop");

    expect(input.hookType).toBe("stop");
    expect(input.stopReason).toBe("completed");
  });

  it("extracts lastAssistantMessage from transcript when available", () => {
    const tempDir = join(tmpdir(), `adit-stop-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const transcriptPath = join(tempDir, "transcript.jsonl");
      writeFileSync(transcriptPath, [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "10+3=?" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "10 + 3 = 13" }] } }),
      ].join("\n") + "\n");

      const raw = {
        conversation_id: "conv-123",
        workspace_roots: ["/path/to/project"],
        status: "completed",
        transcript_path: transcriptPath,
      };

      const input = cursorAdapter.parseInput(raw, "stop");

      expect(input.stopReason).toBe("completed");
      expect(input.lastAssistantMessage).toBe("10 + 3 = 13");
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("maps notification fields from afterAgentResponse", () => {
    const raw = {
      conversation_id: "conv-123",
      workspace_roots: ["/path/to/project"],
      message: "Agent completed the task",
      notification_type: "agent_response",
    };

    const input = cursorAdapter.parseInput(raw, "notification");

    expect(input.notificationMessage).toBe("Agent completed the task");
    expect(input.notificationType).toBe("agent_response");
  });
});
