/**
 * Tests for Codex CLI adapter hook chaining (install/uninstall).
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
import { codexAdapter } from "./codex.js";

/** Create a unique temp directory for each test */
function tempProjectRoot(): string {
  const dir = join(tmpdir(), `adit-hook-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readHooks(projectRoot: string): Record<string, unknown> {
  const hooksPath = join(projectRoot, ".codex", "hooks.json");
  return JSON.parse(readFileSync(hooksPath, "utf-8"));
}

function writeHooks(projectRoot: string, hooks: Record<string, unknown>): void {
  const codexDir = join(projectRoot, ".codex");
  if (!existsSync(codexDir)) {
    mkdirSync(codexDir, { recursive: true });
  }
  writeFileSync(join(codexDir, "hooks.json"), JSON.stringify(hooks, null, 2) + "\n");
}

describe("Codex CLI Hook Chaining", () => {
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
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();

    // Each event should have exactly one matcher group with one ADIT hook
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("adit-hook");
  });

  it("preserves other tools' hooks when installing ADIT hooks", async () => {
    // Pre-install another tool's hooks
    const otherToolHook = {
      hooks: [
        { type: "command", command: "my-linter check", timeout: 10 },
      ],
    };
    writeHooks(projectRoot, {
      hooks: {
        SessionStart: [otherToolHook],
        Stop: [
          { hooks: [{ type: "command", command: "my-formatter run", timeout: 10 }] },
        ],
      },
    });

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    // SessionStart should have both: Other's hook + ADIT's hook
    const sessionStartEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionStartEntries).toHaveLength(2);
    expect(sessionStartEntries[0].hooks[0].command).toContain("my-linter");
    expect(sessionStartEntries[1].hooks[0].command).toContain("adit-hook");

    // Stop should also have both
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(2);
    expect(stopEntries[0].hooks[0].command).toContain("my-formatter");
    expect(stopEntries[1].hooks[0].command).toContain("adit-hook");
  });

  it("replaces stale ADIT hooks on reinstall (no duplicates)", async () => {
    // Simulate a previous ADIT install
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    // Reinstall with a different binary path (e.g., after update)
    await codexAdapter.installHooks(projectRoot, 'node "/new/path/hooks/dist/index.js"');

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    // Should have exactly one entry per event, with the new path
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("/new/path/hooks/dist/index.js");
    expect(stopEntries[0].hooks[0].command).not.toContain("npx adit-hook");
  });

  it("preserves other tools' hooks on reinstall while replacing ADIT's", async () => {
    // Setup: another tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "my-linter check", timeout: 10 }],
    };
    writeHooks(projectRoot, {
      hooks: {
        UserPromptSubmit: [otherToolHook],
      },
    });

    // First ADIT install
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let hooksConfig = readHooks(projectRoot);
    let entries = (hooksConfig.hooks as Record<string, unknown[]>).UserPromptSubmit as unknown[];
    expect(entries).toHaveLength(2);

    // Reinstall ADIT (should replace old ADIT, keep linter)
    await codexAdapter.installHooks(projectRoot, 'node "/updated/hooks/dist/index.js"');

    hooksConfig = readHooks(projectRoot);
    entries = (hooksConfig.hooks as Record<string, unknown[]>).UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
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
    writeHooks(projectRoot, {
      hooks: {
        CustomEvent: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "my-formatter run" }] },
        ],
      },
    });

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    // CustomEvent should be preserved exactly as-is
    const customEntries = hooks.CustomEvent as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0].matcher).toBe("Write|Edit");
    expect(customEntries[0].hooks[0].command).toBe("my-formatter run");

    // ADIT hooks should also be present
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
  });

  it("preserves non-hook settings keys", async () => {
    writeHooks(projectRoot, {
      permissions: { allow: ["read", "write"] },
      model: "gpt-4",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "other-tool stop" }] }],
      },
    });

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    expect(hooksConfig.permissions).toEqual({ allow: ["read", "write"] });
    expect(hooksConfig.model).toBe("gpt-4");
  });

  it("handles corrupted hooks file gracefully", async () => {
    const codexDir = join(projectRoot, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "hooks.json"), "{ invalid json }}}");

    // Should not throw — starts fresh
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toBeDefined();
  });

  it("uninstallHooks removes only ADIT entries, preserves others", async () => {
    // Setup: other tool + ADIT
    const otherToolHook = {
      hooks: [{ type: "command", command: "my-linter check", timeout: 10 }],
    };
    writeHooks(projectRoot, {
      hooks: {
        Stop: [otherToolHook],
        SessionStart: [
          { hooks: [{ type: "command", command: "my-formatter run", timeout: 10 }] },
        ],
      },
    });

    // Install ADIT alongside
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    // Verify both present
    let hooksConfig = readHooks(projectRoot);
    expect((hooksConfig.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);

    // Uninstall ADIT
    await codexAdapter.uninstallHooks(projectRoot);

    hooksConfig = readHooks(projectRoot);
    const hooks = hooksConfig.hooks as Record<string, unknown[]>;

    // Other tools' hooks should remain
    const stopEntries = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stopEntries).toHaveLength(1);
    expect(stopEntries[0].hooks[0].command).toContain("my-linter");

    const sessionEntries = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0].hooks[0].command).toContain("my-formatter");
  });

  it("uninstallHooks cleans up empty event arrays and hooks object", async () => {
    // Only ADIT hooks installed
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    await codexAdapter.uninstallHooks(projectRoot);

    const hooksConfig = readHooks(projectRoot);
    // hooks key should be deleted entirely when all events are empty
    expect(hooksConfig.hooks).toBeUndefined();
  });

  it("handles flat command entries from other tools", async () => {
    // Some tools may use flat command format instead of nested hooks array
    writeHooks(projectRoot, {
      hooks: {
        Stop: [
          { command: "my-tool stop", type: "command" },
        ],
      },
    });

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const hooksConfig = readHooks(projectRoot);
    const stopEntries = (hooksConfig.hooks as Record<string, unknown[]>).Stop;
    // Should preserve the flat entry + add ADIT's nested entry
    expect(stopEntries).toHaveLength(2);
  });

  it("install is idempotent — multiple installs with same path produce same result", async () => {
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");
    const first = readHooks(projectRoot);

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");
    const second = readHooks(projectRoot);

    await codexAdapter.installHooks(projectRoot, "npx adit-hook");
    const third = readHooks(projectRoot);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("validateInstallation detects ADIT hooks in chained configuration", async () => {
    // Other tool installed first
    writeHooks(projectRoot, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "my-liner start", timeout: 30 }] },
        ],
      },
    });

    // Install ADIT alongside
    await codexAdapter.installHooks(projectRoot, "npx adit-hook");

    const result = await codexAdapter.validateInstallation(projectRoot);
    expect(result.valid).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  describe("Hook mappings", () => {
    it("has exactly 4 hook mappings", () => {
      expect(codexAdapter.hookMappings).toHaveLength(4);
    });

    it("maps UserPromptSubmit to prompt-submit", () => {
      const mapping = codexAdapter.hookMappings.find(m => m.platformEvent === "UserPromptSubmit");
      expect(mapping).toEqual({
        platformEvent: "UserPromptSubmit",
        aditHandler: "prompt-submit"
      });
    });

    it("maps Stop to stop", () => {
      const mapping = codexAdapter.hookMappings.find(m => m.platformEvent === "Stop");
      expect(mapping).toEqual({
        platformEvent: "Stop",
        aditHandler: "stop"
      });
    });

    it("maps SessionStart to session-start with matcher", () => {
      const mapping = codexAdapter.hookMappings.find(m => m.platformEvent === "SessionStart");
      expect(mapping).toEqual({
        platformEvent: "SessionStart",
        aditHandler: "session-start",
        matcher: "startup|resume"
      });
    });

    it("maps PostToolUse to notification with matcher", () => {
      const mapping = codexAdapter.hookMappings.find(m => m.platformEvent === "PostToolUse");
      expect(mapping).toEqual({
        platformEvent: "PostToolUse",
        aditHandler: "notification",
        matcher: "Bash"
      });
    });
  });

  describe("parseInput", () => {
    it("parses SessionStart input correctly", () => {
      const raw = {
        session_id: "session123",
        transcript_path: "/path/to/transcript",
        cwd: "/project",
        hook_event_name: "SessionStart",
        model: "gpt-4",
        turn_id: "turn456"
      };

      const result = codexAdapter.parseInput(raw, "SessionStart");

      expect(result).toEqual({
        cwd: "/project",
        hookType: "session-start",
        platformCli: "codex",
        platformSessionId: "session123",
        transcriptPath: "/path/to/transcript",
        permissionMode: undefined,
        model: "gpt-4",
        sessionSource: undefined,
        sessionEndReason: undefined,
        rawPlatformData: raw
      });
    });

    it("parses UserPromptSubmit input correctly", () => {
      const raw = {
        session_id: "session123",
        prompt: "Hello, help me with my code",
        model: "gpt-4",
        cwd: "/project"
      };

      const result = codexAdapter.parseInput(raw, "UserPromptSubmit");

      expect(result).toEqual({
        cwd: "/project",
        hookType: "prompt-submit",
        platformCli: "codex",
        platformSessionId: "session123",
        prompt: "Hello, help me with my code",
        permissionMode: undefined,
        model: "gpt-4",
        sessionSource: undefined,
        sessionEndReason: undefined,
        rawPlatformData: raw
      });
    });

    it("parses Stop input correctly", () => {
      const raw = {
        session_id: "session123",
        stop_reason: "user_requested",
        last_assistant_message: "Done with task",
        model: "gpt-4",
        cwd: "/project"
      };

      const result = codexAdapter.parseInput(raw, "Stop");

      expect(result).toEqual({
        cwd: "/project",
        hookType: "stop",
        platformCli: "codex",
        platformSessionId: "session123",
        stopReason: "user_requested",
        lastAssistantMessage: "Done with task",
        permissionMode: undefined,
        model: "gpt-4",
        sessionSource: undefined,
        sessionEndReason: undefined,
        rawPlatformData: raw
      });
    });

    it("parses PostToolUse input correctly", () => {
      const raw = {
        session_id: "session123",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        tool_response: { output: "file1.txt\nfile2.txt" },
        model: "gpt-4",
        cwd: "/project"
      };

      const result = codexAdapter.parseInput(raw, "PostToolUse");

      expect(result).toEqual({
        cwd: "/project",
        hookType: "notification",
        platformCli: "codex",
        platformSessionId: "session123",
        toolName: "Bash",
        toolInput: { command: "ls -la" },
        toolOutput: { output: "file1.txt\nfile2.txt" },
        permissionMode: undefined,
        model: "gpt-4",
        sessionSource: undefined,
        sessionEndReason: undefined,
        rawPlatformData: raw
      });
    });
  });

  describe("generateHookConfig", () => {
    it("generates correct hook configuration", () => {
      const config = codexAdapter.generateHookConfig("npx adit-hook");

      expect(config).toEqual({
        configPath: ".codex/hooks.json",
        content: {
          hooks: {
            SessionStart: [
              { matcher: "startup|resume", hooks: [{ type: "command", command: "CODEX=1 npx adit-hook session-start", timeout: 30 }] }
            ],
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: "CODEX=1 npx adit-hook prompt-submit", timeout: 30 }] }
            ],
            Stop: [
              { hooks: [{ type: "command", command: "CODEX=1 npx adit-hook stop", timeout: 30 }] }
            ],
            PostToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "CODEX=1 npx adit-hook notification", timeout: 30 }] }
            ]
          }
        }
      });
    });
  });

  describe("validateInstallation", () => {
    it("detects valid installation with all hooks", async () => {
      // Install hooks
      await codexAdapter.installHooks(projectRoot, "npx adit-hook");

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(true);
      expect(result.checks.length).toBe(2);
      expect(result.checks[0].name).toBe(".codex directory");
      expect(result.checks[0].ok).toBe(true);
      expect(result.checks[1].name).toBe("Hook configuration");
      expect(result.checks[1].ok).toBe(true);
    });

    it("detects missing .codex directory", async () => {
      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(false);
      expect(result.checks[0].name).toBe(".codex directory");
      expect(result.checks[0].ok).toBe(false);
    });

    it("detects missing hooks configuration", async () => {
      // Create .codex directory but no hooks.json
      const codexDir = join(projectRoot, ".codex");
      mkdirSync(codexDir, { recursive: true });

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(false);
      expect(result.checks[1].name).toBe("Hook configuration");
      expect(result.checks[1].ok).toBe(false);
      expect(result.checks[1].detail).toContain("No hook configuration found");
    });

    it("detects partial hooks configuration", async () => {
      // Install only some hooks manually
      writeHooks(projectRoot, {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "CODEX=1 npx adit-hook session-start", timeout: 10 }] }
          ]
          // Missing other hooks
        }
      });

      const result = await codexAdapter.validateInstallation(projectRoot);

      expect(result.valid).toBe(false);
      expect(result.checks[1].name).toBe("Hook configuration");
      expect(result.checks[1].ok).toBe(false);
      expect(result.checks[1].detail).toContain("Missing hooks");
    });
  });

  describe("getResumeCommand", () => {
    it("returns codex --continue for Codex", () => {
      const command = codexAdapter.getResumeCommand("/project");
      expect(command).toBe("codex --continue");
    });
  });
});