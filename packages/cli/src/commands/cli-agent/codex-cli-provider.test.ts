import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  appStart: vi.fn(),
  appRequest: vi.fn(),
  appStop: vi.fn(),
  appServerOptions: null as null | {
    onNotification?: (message: unknown) => void;
  },
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));

vi.mock("./codex-app-server-client.js", () => ({
  CodexAppServerClient: class {
    constructor(options: unknown) {
      mocks.appServerOptions = options as typeof mocks.appServerOptions;
    }

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

vi.mock("@varveai/adit-engine", () => ({
  getCurrentBranch: vi.fn(async () => "main"),
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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const DEFAULT_APP_SERVER_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/compact/start",
  "skills/list",
  "model/list",
  "mcpServerStatus/list",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
];

function appServerMethodsError(methods = DEFAULT_APP_SERVER_METHODS): Error {
  return new Error(
    `Invalid request: unknown variant \`adit/capabilities/discover\`, expected one of ${
      methods.map((method) => `\`${method}\``).join(", ")
    }`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appServerOptions = null;
  mocks.spawn.mockImplementation(() => mockChildProcess());
  mocks.appStart.mockResolvedValue(undefined);
  mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
    if (method === "adit/capabilities/discover") {
      throw appServerMethodsError();
    }
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
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    if (method === "skills/list") {
      return {
        data: [
          {
            cwd: (params as { cwds?: string[] }).cwds?.[0] ?? "/tmp/project",
            skills: [
              {
                name: "imagegen",
                description: "Generate images",
                path: "/tmp/skills/imagegen/SKILL.md",
                scope: "system",
                enabled: true,
              },
              {
                name: "git-workflow",
                description: "Use Git safely",
                path: "/tmp/skills/git-workflow/SKILL.md",
                scope: "user",
                enabled: true,
              },
            ],
          },
        ],
      };
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: [
          {
            name: "chrome-devtools",
            tools: {
              list_pages: { name: "list_pages" },
              take_snapshot: { name: "take_snapshot" },
            },
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
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
  it("does not emit fixed slash commands on construction", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === "slash-commands")).toBe(false);

    provider.stop();
  });

  it("rejects Web takeover after the local Codex CLI exits", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });
    const child = mocks.spawn.mock.results[0]?.value as EventEmitter;

    child.emit("exit", 0, null);

    expect(provider.state.owner).toBe("stopped");

    await expect(provider.takeover()).rejects.toMatchObject({
      message: "local Codex owner is not available",
      statusCode: 409,
    });
    expect(mocks.appRequest).not.toHaveBeenCalled();

    provider.stop();
  });

  it("hydrates slash commands from app-server methods", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();

    const slashEvent = events.find((event) => event.type === "slash-commands");
    expect(slashEvent?.payload.commands).toEqual([
      { name: "compact", description: "Compress the current Codex thread" },
      { name: "mcp", description: "Show 1 Codex MCP server" },
      { name: "skills", description: "List 2 Codex skills" },
      { name: "fork", description: "Fork the current Codex thread" },
      { name: "model", description: "List available Codex models" },
      { name: "new", description: "Start a new Codex thread" },
      { name: "clear", description: "Start a clean Codex thread" },
      { name: "imagegen", description: "Use Codex skill: Generate images" },
      { name: "git-workflow", description: "Use Codex skill: Use Git safely" },
      { name: "mcp.chrome-devtools", description: "Show Codex MCP server: chrome-devtools" },
    ]);

    provider.stop();
  });

  it("omits slash commands whose app-server methods are missing", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError(["initialize", "thread/start", "skills/list"]);
      }
      if (method === "thread/start") {
        return {
          model: "gpt-test",
          thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" },
        };
      }
      if (method === "skills/list") {
        return {
          data: [
            {
              cwd: (params as { cwds?: string[] }).cwds?.[0] ?? "/tmp/project",
              skills: [{ name: "imagegen", enabled: true }],
            },
          ],
        };
      }
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();

    const slashEvent = events.find((event) => event.type === "slash-commands");
    expect((slashEvent?.payload.commands as Array<{ name: string }>).map((command) => command.name)).toEqual([
      "skills",
      "new",
      "clear",
      "imagegen",
    ]);
    await expect(
      provider.handleSlashCommand({ name: "mcp", args: [], raw: "/mcp" }),
    ).rejects.toMatchObject({
      message: "Codex Cloud Coding does not expose /mcp as an executable native command.",
      statusCode: 400,
    });

    provider.stop();
  });

  it("emits an empty slash list when capability hydrate fails without blocking takeover", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "adit/capabilities/discover") {
        throw new Error("app-server refused capability probe");
      }
      if (method === "thread/start") {
        return {
          model: "gpt-test",
          thread: { id: "019e2110-d96f-7e40-882e-b524fa9148e4" },
        };
      }
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();

    expect(provider.state.owner).toBe("web");
    const slashEvent = events.find((event) => event.type === "slash-commands");
    expect(slashEvent?.payload.commands).toEqual([]);

    provider.stop();
  });

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

  it("binds a pending Web session when the first slash command starts a thread", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let threadStartCount = 0;
    const initialThreadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const slashThreadId = "019e2110-d96f-7e40-882e-b524fa9148e5";
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError();
      }
      if (method === "thread/start") {
        threadStartCount += 1;
        return {
          model: "gpt-test",
          thread: { id: threadStartCount === 1 ? initialThreadId : slashThreadId },
        };
      }
      if (method === "skills/list") return { data: [] };
      if (method === "mcpServerStatus/list") return { data: [] };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    events.length = 0;

    await provider.handleSlashCommand({
      name: "new",
      args: [],
      raw: "/new",
      sessionId: "pending_web_session",
      pendingSessionId: "pending_web_session",
      localMessageId: "local-user-1",
    });

    expect(provider.state.activeSessionId).toBe(slashThreadId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session-bound",
      payload: {
        pendingSessionId: "pending_web_session",
        sessionId: slashThreadId,
        createdAt: expect.any(Number),
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/new",
        sessionId: slashThreadId,
      }),
    }));

    provider.stop();
  });

  it("binds a pending Web session when /fork starts an empty thread", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let threadStartCount = 0;
    const initialThreadId = "019e2110-d96f-7e40-882e-b524fa9148e4";
    const slashThreadId = "019e2110-d96f-7e40-882e-b524fa9148e5";
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "adit/capabilities/discover") {
        throw appServerMethodsError();
      }
      if (method === "thread/start") {
        threadStartCount += 1;
        return {
          model: "gpt-test",
          thread: { id: threadStartCount === 1 ? initialThreadId : slashThreadId },
        };
      }
      if (method === "skills/list") return { data: [] };
      if (method === "mcpServerStatus/list") return { data: [] };
      return {};
    });
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    events.length = 0;
    mocks.appRequest.mockClear();

    await provider.handleSlashCommand({
      name: "fork",
      args: [],
      raw: "/fork",
      sessionId: "pending_web_session",
      pendingSessionId: "pending_web_session",
      localMessageId: "local-user-1",
    });

    expect(provider.state.activeSessionId).toBe(slashThreadId);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session-bound",
      payload: {
        pendingSessionId: "pending_web_session",
        sessionId: slashThreadId,
        createdAt: expect.any(Number),
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/fork",
        text: expect.stringContaining("no conversation to fork"),
        sessionId: slashThreadId,
      }),
    }));
    expect(mocks.appRequest.mock.calls.filter(([method]) => method === "thread/fork")).toHaveLength(0);

    provider.stop();
  });

  it("refreshes skills from app-server when /skills runs", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    await provider.takeover();
    mocks.appRequest.mockClear();
    mocks.appRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "skills/list") {
        return {
          data: [
            {
              cwd: (params as { cwds?: string[] }).cwds?.[0] ?? "/tmp/project",
              skills: [
                {
                  name: "skill-installer",
                  description: "Install skills",
                  enabled: true,
                },
              ],
            },
          ],
        };
      }
      return {};
    });

    await provider.handleSlashCommand({ name: "skills", args: [], raw: "/skills" });

    expect(mocks.appRequest).toHaveBeenCalledWith("skills/list", {
      cwds: ["/tmp/project"],
      forceReload: false,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/skills",
        noticeKind: "skills",
        skills: [
          expect.objectContaining({
            name: "skill-installer",
            description: "Install skills",
          }),
        ],
      }),
    }));
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "skills", description: "List 1 Codex skill" });
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "skill-installer", description: "Use Codex skill: Install skills" });

    provider.stop();
  });

  it("refreshes MCP servers from app-server when /mcp runs", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    await provider.takeover();
    mocks.appRequest.mockClear();
    mocks.appRequest.mockImplementation(async (method: string) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            { name: "chrome-devtools", tools: {}, authStatus: "unsupported" },
            { name: "codex_apps", tools: {}, authStatus: "bearerToken" },
          ],
        };
      }
      return {};
    });

    await provider.handleSlashCommand({ name: "mcp", args: [], raw: "/mcp" });

    expect(mocks.appRequest).toHaveBeenCalledWith("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/mcp",
        text: expect.stringContaining("codex_apps"),
      }),
    }));
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "mcp", description: "Show 2 Codex MCP servers" });
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "mcp.chrome-devtools", description: "Show Codex MCP server: chrome-devtools" });
    expect(events.filter((event) => event.type === "slash-commands").at(-1)?.payload.commands)
      .toContainEqual({ name: "mcp.codex_apps", description: "Show Codex MCP server: codex_apps" });

    provider.stop();
  });

  it("exposes individual skill slash commands that refresh skill data", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    await provider.takeover();
    mocks.appRequest.mockClear();

    await provider.handleSlashCommand({ name: "imagegen", args: [], raw: "/imagegen" });

    expect(mocks.appRequest).toHaveBeenCalledWith("skills/list", {
      cwds: ["/tmp/project"],
      forceReload: false,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/imagegen",
        noticeKind: "skills",
        skills: [
          expect.objectContaining({
            name: "imagegen",
            description: "Generate images",
          }),
        ],
      }),
    }));

    provider.stop();
  });

  it("exposes individual MCP server slash commands that refresh MCP data", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });
    await provider.takeover();
    mocks.appRequest.mockClear();

    await provider.handleSlashCommand({
      name: "mcp.chrome-devtools",
      args: [],
      raw: "/mcp.chrome-devtools",
    });

    expect(mocks.appRequest).toHaveBeenCalledWith("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "notice",
      payload: expect.objectContaining({
        title: "/mcp.chrome-devtools",
        text: "- chrome-devtools: auth=unsupported, tools=2",
      }),
    }));

    provider.stop();
  });

  it("reports current branch and latest token usage while Web controls Codex", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    provider.noteModel("gpt-5.5");
    mocks.appServerOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        tokenUsage: {
          last: {
            inputTokens: 1200,
            outputTokens: 300,
            reasoningOutputTokens: 50,
            cachedInputTokens: 200,
            cacheCreationInputTokens: 10,
          },
        },
      },
    });
    await tick();

    expect(provider.state.currentBranch).toBe("main");
    expect(provider.state.lastTokenUsage).toEqual(expect.objectContaining({
      inputTokens: 1200,
      outputTokens: 300,
      reasoningTokens: 50,
      cacheReadTokens: 200,
      cacheWriteTokens: 10,
      source: "codex-app-server",
    }));
    expect(provider.state.contextUsage).toEqual(expect.objectContaining({
      totalTokens: 1500,
      maxTokens: 1_050_000,
      modelId: "gpt-5.5",
      source: "codex-app-server",
    }));
    expect(provider.state.contextUsage?.percentage).toBeCloseTo(1500 / 1_050_000 * 100);
    expect(events).toContainEqual(expect.objectContaining({
      type: "state",
      payload: expect.objectContaining({
        currentBranch: "main",
        contextUsage: expect.objectContaining({
          totalTokens: 1500,
          maxTokens: 1_050_000,
          modelId: "gpt-5.5",
        }),
        lastTokenUsage: expect.objectContaining({
          inputTokens: 1200,
          outputTokens: 300,
          reasoningTokens: 50,
          cacheReadTokens: 200,
          cacheWriteTokens: 10,
        }),
      }),
    }));

    (provider as unknown as { contextUsage: null }).contextUsage = null;
    provider.noteModel("gpt-5.5");
    expect(provider.state.contextUsage).toEqual(expect.objectContaining({
      totalTokens: 1500,
      maxTokens: 1_050_000,
      modelId: "gpt-5.5",
    }));

    provider.stop();
  });

  it("preserves leading spaces in Codex app-server text deltas", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    mocks.appServerOptions?.onNotification?.({
      method: "item/agentMessage/delta",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        itemId: "item-1",
        delta: " Let's",
      },
    });
    mocks.appServerOptions?.onNotification?.({
      method: "item/agentMessage/delta",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        itemId: "item-1",
        delta: " analyze",
      },
    });
    await tick();

    expect(events.filter((event) => event.type === "assistant-delta").map((event) => event.payload.text))
      .toEqual([" Let's", " analyze"]);

    provider.stop();
  });

  it("keeps Codex context usage scoped to the selected thread", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();
    provider.noteModel("gpt-5.5");
    mocks.appServerOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        tokenUsage: {
          last: {
            inputTokens: 1200,
            outputTokens: 300,
          },
        },
      },
    });
    await tick();
    expect(provider.state.contextUsage?.totalTokens).toBe(1500);

    await provider.switchSession("019e0000-0000-7000-8000-000000000001");
    provider.noteModel("gpt-5.5");
    expect(provider.state.contextUsage).toBeNull();
    expect(provider.state.lastTokenUsage).toBeNull();

    mocks.appServerOptions?.onNotification?.({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "019e0000-0000-7000-8000-000000000001",
        tokenUsage: {
          last: {
            inputTokens: 2200,
            outputTokens: 400,
          },
        },
      },
    });
    await tick();
    expect(provider.state.contextUsage?.totalTokens).toBe(2600);

    await provider.switchSession("019e2110-d96f-7e40-882e-b524fa9148e4");
    expect(provider.state.contextUsage?.totalTokens).toBe(1500);
    expect(provider.state.lastTokenUsage?.inputTokens).toBe(1200);

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

describe("CodexCliProvider abort", () => {
  it("interrupts the active turn and emits a non-error abort event", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    await provider.abort();

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      turnId: "turn-1",
    });
    expect(events.some((event) => event.type === "run.aborted")).toBe(true);
    expect(events.some((event) =>
      event.type === "error" &&
      String(event.payload.message ?? "").includes("aborted")
    )).toBe(false);

    provider.stop();
  });
});

describe("CodexCliProvider steerPrompt", () => {
  it("sends steering input to the active turn without queuing a new prompt", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
      onEvent: (event) => events.push(event),
    });

    await provider.takeover();
    await provider.sendPrompt("hello");
    mocks.appRequest.mockClear();

    await provider.steerPrompt("focus on tests", {
      sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      localMessageId: "local-steer-1",
    });

    expect(mocks.appRequest).toHaveBeenCalledWith("turn/steer", {
      threadId: "019e2110-d96f-7e40-882e-b524fa9148e4",
      expectedTurnId: "turn-1",
      input: [
        {
          type: "text",
          text: "focus on tests",
          text_elements: [],
        },
      ],
    });
    expect(mocks.appRequest).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(events).toContainEqual(expect.objectContaining({
      type: "message",
      payload: expect.objectContaining({
        role: "user",
        sessionId: "019e2110-d96f-7e40-882e-b524fa9148e4",
        messageId: "local-steer-1",
        text: "focus on tests",
        inputKind: "steer",
      }),
    }));

    provider.stop();
  });

  it("rejects steering when no turn is active", async () => {
    const provider = new CodexCliProvider({
      bin: "codex",
      args: [],
      cwd: "/tmp/project",
    });

    await provider.takeover();

    await expect(provider.steerPrompt("too early")).rejects.toThrow(
      "Codex is not currently accepting steering input",
    );

    provider.stop();
  });
});
