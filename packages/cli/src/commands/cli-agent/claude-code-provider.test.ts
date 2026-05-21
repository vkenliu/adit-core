import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAbortError extends Error {}
  return {
    AbortError: MockAbortError,
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    query: vi.fn(),
    remoteInterrupt: vi.fn(),
    remoteClose: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  AbortError: mocks.AbortError,
  query: (...args: unknown[]) => mocks.query(...args),
}));

vi.mock("@varveai/adit-engine", () => ({
  getCurrentBranch: vi.fn(async () => "main"),
}));

import {
  ClaudeCodeProvider,
  buildClaudeCloudRelayEnv,
  normalizeClaudeTodoWriteInput,
} from "./claude-code-provider.js";

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

function createCapabilityQuery() {
  return {
    supportedCommands: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    close: vi.fn(),
    interrupt: vi.fn(),
    async *[Symbol.asyncIterator]() {},
  };
}

function createRemoteQuery(abortController?: AbortController) {
  return {
    supportedCommands: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => ({
      totalTokens: 100,
      maxTokens: 200,
      percentage: 50,
      model: "claude-test",
    })),
    close: mocks.remoteClose,
    interrupt: mocks.remoteInterrupt.mockImplementation(async () => {
      abortController?.abort();
    }),
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve, reject) => {
        const signal = abortController?.signal;
        if (!signal) return resolve();
        if (signal.aborted) {
          reject(new mocks.AbortError("aborted"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new mocks.AbortError("aborted")),
          { once: true },
        );
      });
    },
  };
}

function findRemotePromptStream(): AsyncIterable<Record<string, unknown>> {
  const call = mocks.query.mock.calls.find(([input]) =>
    (input as { options?: { includePartialMessages?: boolean } }).options?.includePartialMessages === true
  );
  expect(call).toBeTruthy();
  return (call?.[0] as { prompt: AsyncIterable<Record<string, unknown>> }).prompt;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockImplementation(() => mockChildProcess());
  mocks.query.mockImplementation((
    input: {
      options?: {
        abortController?: AbortController;
        includePartialMessages?: boolean;
      };
    },
  ) => {
    if (input.options?.includePartialMessages) {
      return createRemoteQuery(input.options.abortController);
    }
    return createCapabilityQuery();
  });
});

describe("normalizeClaudeTodoWriteInput", () => {
  it("normalizes Claude TodoWrite input", () => {
    expect(
      normalizeClaudeTodoWriteInput({
        todos: [
          {
            id: "a",
            content: "Inspect auth flow",
            status: "in_progress",
            priority: "high",
            activeForm: "Inspecting auth flow",
          },
          {
            content: "Add regression test",
            status: "completed",
          },
        ],
      }),
    ).toEqual([
      {
        id: "a",
        content: "Inspect auth flow",
        status: "in_progress",
        priority: "high",
        activeForm: "Inspecting auth flow",
      },
      {
        id: "todo-1",
        content: "Add regression test",
        status: "completed",
      },
    ]);
  });

  it("distinguishes empty lists from malformed input", () => {
    expect(normalizeClaudeTodoWriteInput({ todos: [] })).toEqual([]);
    expect(normalizeClaudeTodoWriteInput({ todos: [{ status: "pending" }] })).toBeNull();
    expect(normalizeClaudeTodoWriteInput({})).toBeNull();
  });
});

describe("ClaudeCodeProvider abort", () => {
  it("does not acknowledge a prompt until the remote query can be interrupted", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    await provider.abort();

    expect(mocks.remoteInterrupt).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "run.aborted")).toBe(true);
    expect(events.some((event) =>
      event.type === "error" &&
      String(event.payload.message ?? "").includes("aborted")
    )).toBe(false);

    provider.stop();
  });

  it("marks a pending tool permission as errored when the run is aborted", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      provider.noteLocalSession(sessionId);
      await provider.takeover();
      await provider.sendPrompt("edit aaa.md", { mode: "plan" });

      const remoteCall = mocks.query.mock.calls.find(([input]) =>
        (input as { options?: { includePartialMessages?: boolean } }).options?.includePartialMessages === true
      );
      const canUseTool = (remoteCall?.[0] as {
        options?: {
          canUseTool?: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string; signal: AbortSignal },
          ) => Promise<unknown>;
        };
      }).options?.canUseTool;
      expect(canUseTool).toBeTypeOf("function");

      const toolSignal = new AbortController();
      const permission = canUseTool?.("Edit", { file_path: "aaa.md" }, {
        toolUseID: "tool-1",
        signal: toolSignal.signal,
      });
      await tick();
      expect(provider.permissions).toHaveLength(1);

      await provider.abort();
      await expect(permission).rejects.toThrow("Claude run aborted");

      expect(events).toContainEqual(expect.objectContaining({
        type: "tool",
        payload: expect.objectContaining({
          sessionId,
          toolUseId: "tool-1",
          toolName: "Edit",
          input: { file_path: "aaa.md" },
          error: "Claude run aborted",
          status: "error",
        }),
      }));
    } finally {
      provider.stop();
    }
  });
});

describe("ClaudeCodeProvider takeover", () => {
  it("does not emit fallback slash commands on construction", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      expect(events.some((event) => event.type === "slash-commands")).toBe(false);
    } finally {
      provider.stop();
    }
  });

  it("hydrates slash commands and MCP status from the SDK while local owns Claude", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const capabilityQuery = {
      supportedCommands: vi.fn(async () => [
        { name: "debug", description: "Enable debug logging" },
        { name: "lark-mail", description: "Use Lark mail" },
        { name: "custom-command" },
      ]),
      mcpServerStatus: vi.fn(async () => [
        { name: "lark", status: "connected" },
      ]),
      close: vi.fn(),
      interrupt: vi.fn(),
      async *[Symbol.asyncIterator]() {},
    };
    mocks.query.mockImplementation(() => capabilityQuery);

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await tick();
      await tick();

      expect(capabilityQuery.supportedCommands).toHaveBeenCalledTimes(1);
      expect(capabilityQuery.mcpServerStatus).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: "slash-commands",
        payload: expect.objectContaining({
          commands: [
            {
              name: "debug",
              description: "Enable debug logging",
              argumentHint: undefined,
              aliases: undefined,
            },
            {
              name: "lark-mail",
              description: "Use Lark mail",
              argumentHint: undefined,
              aliases: undefined,
            },
            {
              name: "custom-command",
              argumentHint: undefined,
              aliases: undefined,
            },
            {
              name: "rewind",
              description: "Rewind Claude Code files when checkpointing is available",
            },
          ],
        }),
      }));

      await provider.handleSlashCommand({ name: "mcp", args: [], raw: "/mcp" });
      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        payload: expect.objectContaining({
          title: "/mcp",
          text: "- lark: connected",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("keeps Claude native rewind when the SDK command snapshot is empty", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await tick();
      await tick();

      const slashEvents = events.filter((event) => event.type === "slash-commands");
      expect(slashEvents.length).toBeGreaterThan(0);
      expect(slashEvents.at(-1)?.payload.commands).toEqual([
        {
          name: "rewind",
          description: "Rewind Claude Code files when checkpointing is available",
        },
      ]);
    } finally {
      provider.stop();
    }
  });

  it("rejects unreported slash commands before hydrate while keeping internal notices available", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await expect(
        provider.handleSlashCommand({ name: "compact", args: [], raw: "/compact" }),
      ).rejects.toMatchObject({
        message: "Claude Code did not expose /compact for this Cloud session.",
        statusCode: 400,
      });

      await provider.handleSlashCommand({ name: "rewind", args: [], raw: "/rewind" });

      await provider.handleSlashCommand({ name: "mcp", args: [], raw: "/mcp" });
      await provider.handleSlashCommand({ name: "skills", args: [], raw: "/skills" });

      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        payload: expect.objectContaining({ title: "/mcp" }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        payload: expect.objectContaining({ title: "/rewind" }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "notice",
        payload: expect.objectContaining({ title: "/skills" }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("binds a pending Web session when the first native slash command starts a Claude session", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sessionId = "11111111-1111-1111-1111-111111111111";
    mocks.query.mockImplementation((
      input: {
        options?: {
          abortController?: AbortController;
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages) {
        return {
          supportedCommands: vi.fn(async () => [
            { name: "compact", description: "Compact conversation" },
          ]),
          mcpServerStatus: vi.fn(async () => []),
          close: vi.fn(),
          interrupt: vi.fn(),
          async *[Symbol.asyncIterator]() {},
        };
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            slash_commands: ["compact"],
          };
          yield {
            type: "result",
            session_id: sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
    });
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    try {
      await tick();
      await tick();
      await provider.takeover();

      await provider.handleSlashCommand({
        name: "compact",
        args: [],
        raw: "/compact",
        sessionId: "pending_web_session",
        pendingSessionId: "pending_web_session",
        localMessageId: "local-user-1",
      });
      await tick();
      await tick();

      expect(events).toContainEqual(expect.objectContaining({
        type: "session-bound",
        payload: {
          pendingSessionId: "pending_web_session",
          sessionId,
          createdAt: expect.any(Number),
        },
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "message",
        payload: expect.objectContaining({
          role: "user",
          sessionId,
          messageId: "local-user-1",
          text: "/compact",
        }),
      }));
    } finally {
      provider.stop();
    }
  });

  it("rejects Web takeover after the local Claude CLI exits", async () => {
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });
    const child = mocks.spawn.mock.results[0]?.value as EventEmitter;

    child.emit("exit", 0, null);

    expect(provider.state.owner).toBe("stopped");

    await expect(provider.takeover()).rejects.toMatchObject({
      message: "local Claude owner is not available",
      statusCode: 409,
    });

    provider.stop();
  });

  it("reports current branch and context usage while Web controls Claude", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    await tick();

    expect(provider.state.currentBranch).toBe("main");
    expect(events).toContainEqual(expect.objectContaining({
      type: "state",
      payload: expect.objectContaining({
        currentBranch: "main",
        contextUsage: expect.objectContaining({
          percentage: 50,
          totalTokens: 100,
          maxTokens: 200,
          modelId: "claude-test",
          source: "claude-sdk",
        }),
      }),
    }));

    await provider.abort();
    provider.stop();
  });

  it("accepts a new prompt after the SDK reports a completed result", async () => {
    const remotePrompts: string[] = [];
    mocks.query.mockImplementation((
      input: {
        prompt?: AsyncIterable<Record<string, unknown>>;
        options?: {
          abortController?: AbortController;
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages || !input.prompt) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          const iterator = input.prompt![Symbol.asyncIterator]();
          const first = await iterator.next();
          const content = (first.value?.message as { content?: unknown } | undefined)?.content;
          if (typeof content === "string") remotePrompts.push(content);
          yield {
            type: "result",
            session_id: "11111111-1111-1111-1111-111111111111",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await iterator.next();
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("first");
      await tick();

      const secondPrompt = provider.sendPrompt("second");
      const result = await Promise.race([
        secondPrompt.then(() => "resolved"),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);

      expect(result).toBe("resolved");
      expect(remotePrompts).toEqual(["first", "second"]);
    } finally {
      provider.stop();
    }
  });

  it("keeps the run busy until the SDK iterator finishes after result usage", async () => {
    let finishSdkOutput: () => void = () => {};
    const sdkOutputFinished = new Promise<void>((resolve) => {
      finishSdkOutput = resolve;
    });

    mocks.query.mockImplementation((
      input: {
        prompt?: AsyncIterable<Record<string, unknown>>;
        options?: {
          includePartialMessages?: boolean;
        };
      },
    ) => {
      if (!input.options?.includePartialMessages || !input.prompt) {
        return createCapabilityQuery();
      }

      return {
        supportedCommands: vi.fn(async () => []),
        mcpServerStatus: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({
          totalTokens: 100,
          maxTokens: 200,
          percentage: 50,
          model: "claude-test",
        })),
        close: mocks.remoteClose,
        interrupt: mocks.remoteInterrupt,
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            session_id: "11111111-1111-1111-1111-111111111111",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          await sdkOutputFinished;
        },
      };
    });

    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    try {
      await provider.takeover();
      await provider.sendPrompt("hello");
      await tick();

      expect(provider.state.busy).toBe(true);
      expect(provider.state.thinking).toBe(true);

      finishSdkOutput();
      await tick();
      await tick();

      expect(provider.state.busy).toBe(false);
      expect(provider.state.thinking).toBe(false);
    } finally {
      finishSdkOutput();
      provider.stop();
    }
  });
});

describe("ClaudeCodeProvider steerPrompt", () => {
  it("pushes steering input into the active SDK prompt stream", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");

    const iterator = findRemotePromptStream()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect((first.value.message as { content?: unknown }).content).toBe("hello");

    await provider.steerPrompt("focus on tests", {
      localMessageId: "local-steer-1",
    });

    const second = await iterator.next();
    expect((second.value.message as { content?: unknown }).content).toBe("focus on tests");
    expect(second.value.priority).toBe("now");
    expect(second.value.shouldQuery).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "message",
      payload: expect.objectContaining({
        role: "user",
        messageId: "local-steer-1",
        text: "focus on tests",
        inputKind: "steer",
      }),
    }));

    await provider.abort();
    provider.stop();
  });

  it("rejects steering when no SDK prompt stream is active", async () => {
    const provider = new ClaudeCodeProvider({
      bin: "claude",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();

    await expect(provider.steerPrompt("too early")).rejects.toThrow(
      "Claude Code is not currently accepting steering input",
    );

    provider.stop();
  });
});

describe("buildClaudeCloudRelayEnv", () => {
  it("disables inherited ADIT cloud side effects for relay-managed Claude hooks", () => {
    const env = buildClaudeCloudRelayEnv({
      TERM: "screen-256color",
      ADIT_CLOUD_AUTO_SYNC: "true",
      ADIT_PROJECT_LINK_AUTO_SYNC: "true",
      ADIT_TRANSCRIPT_UPLOAD: "true",
    });

    expect(env.TERM).toBe("screen-256color");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.ADIT_CLOUD_AUTO_SYNC).toBe("false");
    expect(env.ADIT_PROJECT_LINK_AUTO_SYNC).toBe("false");
    expect(env.ADIT_TRANSCRIPT_UPLOAD).toBe("false");
  });

  it("keeps color defaults for Claude child processes", () => {
    const env = buildClaudeCloudRelayEnv({});

    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.FORCE_COLOR).toBe("3");
  });
});
