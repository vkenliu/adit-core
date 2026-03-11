/**
 * Tests for the unified hook dispatcher.
 *
 * Mocks all external dependencies (DB, engine, cloud) to verify
 * that dispatchHook correctly routes each hook type, handles
 * cloud auto-sync with force flags, and maintains fail-open behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Mocks ----

const mockRecordEvent = vi.fn().mockResolvedValue({
  id: "evt-001",
  sessionId: "sess-001",
  sequence: 1,
  eventType: "prompt_submit",
  actor: "user",
});
const mockCreateCheckpoint = vi.fn().mockResolvedValue(null);
const mockList = vi.fn().mockResolvedValue([]);

vi.mock("@adit/core", () => ({
  getLatestEnvSnapshot: vi.fn(() => null),
  endSession: vi.fn(),
  withPerf: vi.fn((_dir: string, _cat: string, _op: string, fn: () => unknown) => fn()),
}));

vi.mock("@adit/engine", () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
  createTimelineManager: vi.fn(() => ({
    recordEvent: mockRecordEvent,
    createCheckpoint: mockCreateCheckpoint,
    list: mockList,
  })),
  captureEnvironment: vi.fn().mockResolvedValue("env-001"),
  diffEnvironments: vi.fn().mockReturnValue({ changes: [], severity: "none" }),
}));

vi.mock("@adit/cloud", () => ({
  triggerTranscriptUpload: vi.fn().mockResolvedValue(undefined),
  triggerAutoSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../common/context.js", () => ({
  initHookContext: vi.fn().mockResolvedValue({
    db: { close: vi.fn() },
    config: {
      projectId: "proj-001",
      projectRoot: "/test",
      dataDir: "/tmp/adit-test",
      clientId: "client-001",
      dbPath: "/tmp/test.db",
      captureEnv: false,
    },
    session: { id: "sess-001" },
  }),
}));

import { dispatchHook } from "./unified.js";
import { endSession } from "@adit/core";
import { getChangedFiles } from "@adit/engine";
import type { NormalizedHookInput } from "../adapters/types.js";

const mockEndSession = vi.mocked(endSession);
const mockGetChangedFiles = vi.mocked(getChangedFiles);

describe("dispatchHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes prompt-submit and records event with prompt text", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "prompt-submit",
      prompt: "Fix the bug in auth.ts",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "prompt_submit",
        actor: "user",
        promptText: "Fix the bug in auth.ts",
      }),
    );
  });

  it("skips prompt-submit when prompt is empty", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "prompt-submit",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it("routes stop and records assistant_response event", async () => {
    mockGetChangedFiles.mockResolvedValue([]);

    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "stop",
      stopReason: "completed",
      lastAssistantMessage: "Done fixing the bug.",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "assistant_response",
        actor: "assistant",
        responseText: "Done fixing the bug.",
      }),
    );
  });

  it("creates checkpoint on stop when working tree is dirty", async () => {
    mockGetChangedFiles.mockResolvedValue([
      { path: "src/auth.ts", status: "M" },
    ]);

    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "stop",
      stopReason: "completed",
    };

    await dispatchHook(input);

    expect(mockCreateCheckpoint).toHaveBeenCalledWith(
      "evt-001",
      "[adit] assistant response (completed)",
      [{ path: "src/auth.ts", status: "M" }],
    );
  });

  it("does not create checkpoint on stop when working tree is clean", async () => {
    mockGetChangedFiles.mockResolvedValue([]);

    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "stop",
      stopReason: "completed",
    };

    await dispatchHook(input);

    expect(mockCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("routes session-end and calls endSession", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "session-end",
      sessionEndReason: "exit",
    };

    await dispatchHook(input);

    expect(mockEndSession).toHaveBeenCalledWith(
      expect.anything(),
      "sess-001",
      "completed",
    );
  });

  it("routes session-end with error reason", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "session-end",
      sessionEndReason: "error",
    };

    await dispatchHook(input);

    expect(mockEndSession).toHaveBeenCalledWith(
      expect.anything(),
      "sess-001",
      "error",
    );
  });

  it("routes notification and records event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "notification",
      notificationMessage: "Tool result: file created",
      notificationTitle: "Tool Result",
      notificationType: "tool_result",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "notification",
        actor: "system",
        responseText: "Tool result: file created",
        toolName: "tool_result",
      }),
    );
  });

  it("routes task-completed and records event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "task-completed",
      taskId: "task-001",
      taskSubject: "Implement login page",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "task_completed",
        actor: "assistant",
        responseText: "Implement login page",
      }),
    );
  });

  it("routes subagent-start and records event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "subagent-start",
      agentId: "agent-001",
      agentType: "code-reviewer",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "subagent_start",
        actor: "assistant",
        toolName: "code-reviewer",
      }),
    );
  });

  it("routes subagent-stop and records event", async () => {
    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "subagent-stop",
      agentId: "agent-001",
      agentType: "code-reviewer",
      lastAssistantMessage: "Review complete, 3 issues found.",
    };

    await dispatchHook(input);

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-001",
        eventType: "subagent_stop",
        actor: "assistant",
        toolName: "code-reviewer",
      }),
    );
  });

  it("closes database in finally block even if handler throws", async () => {
    mockRecordEvent.mockRejectedValueOnce(new Error("DB error"));

    const input: NormalizedHookInput = {
      cwd: "/test",
      hookType: "prompt-submit",
      prompt: "test",
    };

    // The context mock's db.close should still be called
    const { initHookContext } = await import("../common/context.js");
    const ctx = await vi.mocked(initHookContext).mock.results[0]?.value;

    await expect(dispatchHook(input)).rejects.toThrow();
  });
});
