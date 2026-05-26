import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnCliProcess: vi.fn(),
}));

vi.mock("./cli-process.js", () => ({
  spawnCliProcess: (...args: unknown[]) => mocks.spawnCliProcess(...args),
}));

import {
  CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE,
  CodexAppServerClient,
  isTransientCodexSystemSkillsError,
} from "./codex-app-server-client.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CodexAppServerClient", () => {
  it("starts app-server with request_user_input enabled for Default mode", async () => {
    mocks.spawnCliProcess.mockReturnValue(mockAppServerProcess());
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });

    await client.start();

    expect(mocks.spawnCliProcess).toHaveBeenCalledWith(
      "codex",
      [
        "app-server",
        "--enable",
        CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE,
        "--listen",
        "stdio://",
      ],
      expect.objectContaining({
        cwd: "/tmp/project",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("defers transient system skills ENOENT stderr until explicitly flushed", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });
    await client.start();

    child.stderr.emit(
      "data",
      "2026 ERROR codex_core_skills::loader: failed to stat skills path /Users/edy/.codex/skills/.system/imagegen/SKILL.md: No such file or directory (os error 2)\n",
    );

    expect(client.hasDeferredSystemSkillsStderr()).toBe(true);
    expect(stderrWrite).not.toHaveBeenCalled();

    client.flushDeferredSystemSkillsStderr();

    expect(client.hasDeferredSystemSkillsStderr()).toBe(false);
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("[codex app-server] 2026 ERROR codex_core_skills::loader"),
    );
  });

  it("prints non-system-skills stderr immediately", async () => {
    const child = mockAppServerProcess();
    mocks.spawnCliProcess.mockReturnValue(child);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = new CodexAppServerClient({ bin: "codex", cwd: "/tmp/project" });
    await client.start();

    child.stderr.emit("data", "regular app-server warning\n");

    expect(client.hasDeferredSystemSkillsStderr()).toBe(false);
    expect(stderrWrite).toHaveBeenCalledWith("[codex app-server] regular app-server warning\n");
  });
});

describe("isTransientCodexSystemSkillsError", () => {
  it("matches system skills ENOENT loader lines only", () => {
    expect(isTransientCodexSystemSkillsError(
      "ERROR codex_core_skills::loader: failed to read skills dir /Users/edy/.codex/skills/.system/openai-docs/assets: No such file or directory (os error 2)",
    )).toBe(true);
    expect(isTransientCodexSystemSkillsError(
      "ERROR codex_core_skills::loader: failed to read skills dir /Users/edy/.codex/skills/custom: No such file or directory (os error 2)",
    )).toBe(false);
  });
});

function mockAppServerProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter() as typeof child.stdout;
  child.stderr = new EventEmitter() as typeof child.stderr;
  child.stdout.setEncoding = vi.fn();
  child.stderr.setEncoding = vi.fn();
  child.stdin = {
    writable: true,
    write: vi.fn((payload: string) => {
      const request = JSON.parse(payload.trim()) as { id: number };
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({ id: request.id, result: {} })}\n`);
      });
      return true;
    }),
    end: vi.fn(),
  };
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}
