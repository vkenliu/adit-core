import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  appStart: vi.fn(),
  appRequest: vi.fn(),
  appStop: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
}));

vi.mock("./codex-app-server-client.js", () => ({
  CodexAppServerClient: class {
    get isRunning() {
      return true;
    }

    start() {
      return mocks.appStart();
    }

    request(method: string, params: unknown) {
      return mocks.appRequest(method, params);
    }

    stop() {
      return mocks.appStop();
    }
  },
}));

import {
  CodexCliProvider,
  codexThreadModeOverrides,
  codexTurnModeOverrides,
  formatCodexTerminalNotice,
  normalizeCodexReclaimInput,
  promptInputForCodexMode,
} from "./codex-cli-provider.js";

function mockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockImplementation(() => mockChildProcess());
  mocks.appStart.mockResolvedValue(undefined);
  mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
    if (method === "thread/start") {
      return {
        model: "gpt-test",
        thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" },
      };
    }
    if (method === "thread/resume") {
      return {
        model: "gpt-test",
        thread: { id: (params as { threadId?: string }).threadId },
      };
    }
    return {};
  });
});

describe("normalizeCodexReclaimInput", () => {
  it("preserves normal reclaim input", () => {
    expect(normalizeCodexReclaimInput("/local\n")).toBe("/local\n");
  });

  it("decodes CSI-u reclaim input left by Codex terminal mode", () => {
    const encoded = "\x1b[I\x1b[O\x1b[47u\x1b[108u\x1b[111u\x1b[99u\x1b[97u\x1b[108u\x1b[13u";

    expect(normalizeCodexReclaimInput(encoded)).toBe("/local\n");
  });

  it("decodes modified CSI-u keys and strips unrelated CSI escapes", () => {
    const encoded = "\x1b[?1004h\x1b[47;1:3u\x1b[108;1:3u\x1b[111;1:3u\x1b[99;1:3u\x1b[97;1:3u\x1b[108;1:3u";

    expect(normalizeCodexReclaimInput(encoded)).toBe("/local");
  });
});

describe("formatCodexTerminalNotice", () => {
  it("clears stale TUI content when writing notices to a TTY", () => {
    expect(formatCodexTerminalNotice("[adit cloud codex] taken over", true)).toBe(
      "\r\x1b[2K\r\n\r\x1b[2K[adit cloud codex] taken over\x1b[0K\r\n",
    );
  });

  it("keeps plain newlines for non-TTY output", () => {
    expect(formatCodexTerminalNotice("[adit cloud codex] taken over\n", false)).toBe(
      "\n[adit cloud codex] taken over\n",
    );
  });
});

describe("Codex prompt modes", () => {
  it("wraps plan prompts with read-only planning instructions", () => {
    const prompt = promptInputForCodexMode("add login", "plan");

    expect(prompt).toContain("ADIT Plan mode is active.");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("User request:\nadd login");
  });

  it("leaves build prompts unchanged", () => {
    expect(promptInputForCodexMode("add login", "build")).toBe("add login");
  });

  it("uses read-only sandbox overrides in plan mode", () => {
    expect(codexThreadModeOverrides("plan")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    expect(codexTurnModeOverrides("plan")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
    });
  });

  it("uses full-access sandbox overrides in build mode", () => {
    expect(codexThreadModeOverrides("build")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    expect(codexTurnModeOverrides("build")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
    });
  });
});

describe("CodexCliProvider takeover", () => {
  it("starts a real empty thread when Web takes over without an active session", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();

    expect(mocks.appRequest).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        cwd: "/tmp/project",
        persistExtendedHistory: true,
      }),
    );
    expect(mocks.appRequest).not.toHaveBeenCalledWith(
      "thread/resume",
      expect.anything(),
    );
    expect(provider.state.owner).toBe("web");
    expect(provider.state.activeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(provider.state.resumeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(provider.state.sdkSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(events.some((event) =>
      event.type === "state" &&
      event.payload.activeSessionId === "019e2110-d96f-7e40-882e-b524fa9148e4"
    )).toBe(true);

    provider.stop();
  });

  it("resumes the active thread when Web takes over an existing session", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    provider.noteLocalSession("019e2110-d96f-7e40-882e-b524fa9148e4");

    await provider.takeover();

    expect(mocks.appRequest).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        cwd: "/tmp/project",
        persistExtendedHistory: true,
      }),
    );
    expect(mocks.appRequest).not.toHaveBeenCalledWith(
      "thread/start",
      expect.anything(),
    );
    expect(provider.state.owner).toBe("web");
    expect(provider.state.activeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");

    provider.stop();
  });

  it("does not resume a loaded empty thread when switching back to it", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();
    await provider.switchSession("019e0000-0000-7000-8000-000000000001");

    expect(mocks.appRequest).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: "019e0000-0000-7000-8000-000000000001",
      }),
    );

    mocks.appRequest.mockClear();
    await provider.switchSession("019e2110-d96f-7e40-882e-b524fa9148e4");

    expect(mocks.appRequest).not.toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      }),
    );
    expect(provider.state.activeSessionId).toBe("019e2110-d96f-7e40-882e-b524fa9148e4");

    provider.stop();
  });
});
