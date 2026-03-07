/**
 * Tests for the timeline manager.
 *
 * Verifies the code review fixes:
 * - revertTo uses git checkout (not git reset --hard)
 * - undo uses git checkout (not git reset --hard)
 * - recordEvent uses insertEventAutoSeq (not allocateSequence + insertEvent)
 * - recordEvent throws explicit error if post-insert re-fetch returns null
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockInsertEventAutoSeq = vi.fn();
const mockGetEventById = vi.fn();
const mockGetLatestCheckpointEvent = vi.fn();
const mockGetParentSha = vi.fn();

vi.mock("@adit/core", () => ({
  generateId: vi.fn(() => "evt-new-001"),
  createClock: vi.fn(() => ({ "test-client": 1 })),
  serialize: vi.fn(() => '{"test-client":1}'),
  insertEventAutoSeq: (...args: unknown[]) => mockInsertEventAutoSeq(...args),
  getEventById: (...args: unknown[]) => mockGetEventById(...args),
  queryEvents: vi.fn(() => []),
  updateEventCheckpoint: vi.fn(),
  updateEventLabels: vi.fn(),
  searchEvents: vi.fn(() => []),
  getLatestCheckpointEvent: (...args: unknown[]) => mockGetLatestCheckpointEvent(...args),
  insertDiff: vi.fn(),
  getDiffText: vi.fn(() => null),
  tick: vi.fn(() => ({ "test-client": 2 })),
  deserialize: vi.fn(() => ({ "test-client": 1 })),
  withPerf: vi.fn((_dir: string, _cat: string, _op: string, fn: () => unknown) => fn()),
}));

const mockRunGitOrThrow = vi.fn().mockResolvedValue("");

const mockShaExists = vi.fn().mockResolvedValue(true);

vi.mock("../git/runner.js", () => ({
  getHeadSha: vi.fn().mockResolvedValue("head-sha-123"),
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
  runGitOrThrow: (...args: unknown[]) => mockRunGitOrThrow(...args),
  shaExists: (...args: unknown[]) => mockShaExists(...args),
}));

vi.mock("../git/refs.js", () => ({
  getRefPrefix: vi.fn(() => "refs/adit/checkpoints"),
  getParentSha: (...args: unknown[]) => mockGetParentSha(...args),
}));

vi.mock("../snapshot/creator.js", () => ({
  createSnapshot: vi.fn().mockResolvedValue(null),
  getCheckpointDiff: vi.fn().mockResolvedValue(""),
}));

import { createTimelineManager } from "./manager.js";
import type { AditConfig } from "@adit/core";

const fakeDb = {} as never;
const fakeConfig: AditConfig = {
  projectRoot: "/test-project",
  dataDir: "/tmp/adit-test",
  dbPath: "/tmp/test.db",
  projectId: "proj-001",
  clientId: "test-client",
  captureEnv: false,
};

describe("TimelineManager.recordEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses insertEventAutoSeq (not allocateSequence + insertEvent)", async () => {
    mockGetEventById.mockReturnValue({
      id: "evt-new-001",
      sessionId: "sess-001",
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
    });

    const tm = createTimelineManager(fakeDb, fakeConfig);
    await tm.recordEvent({
      sessionId: "sess-001",
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Hello",
    });

    expect(mockInsertEventAutoSeq).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        id: "evt-new-001",
        sessionId: "sess-001",
        eventType: "prompt_submit",
        actor: "user",
        promptText: "Hello",
      }),
    );
    // Verify no 'sequence' field is passed (it's computed in the SQL)
    const insertArg = mockInsertEventAutoSeq.mock.calls[0][1];
    expect(insertArg).not.toHaveProperty("sequence");
  });

  it("throws explicit error when getEventById returns null after insert", async () => {
    mockGetEventById.mockReturnValue(null);

    const tm = createTimelineManager(fakeDb, fakeConfig);

    await expect(
      tm.recordEvent({
        sessionId: "sess-001",
        eventType: "prompt_submit",
        actor: "user",
      }),
    ).rejects.toThrow("Failed to retrieve event after insert: evt-new-001");
  });
});

describe("TimelineManager.revertTo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses git checkout instead of git reset --hard", async () => {
    mockGetEventById.mockReturnValue({
      id: "evt-001",
      checkpointSha: "checkpoint-sha-abc",
    });

    const tm = createTimelineManager(fakeDb, fakeConfig);
    await tm.revertTo("evt-001");

    // Should use checkout -- . to avoid moving HEAD
    expect(mockRunGitOrThrow).toHaveBeenCalledWith(
      ["checkout", "checkpoint-sha-abc", "--", "."],
      { cwd: "/test-project" },
    );

    // Should NOT use reset --hard
    const calls = mockRunGitOrThrow.mock.calls;
    for (const call of calls) {
      expect(call[0]).not.toContain("reset");
    }
  });

  it("throws when event not found", async () => {
    mockGetEventById.mockReturnValue(null);

    const tm = createTimelineManager(fakeDb, fakeConfig);

    await expect(tm.revertTo("nonexistent")).rejects.toThrow("Event not found");
  });

  it("throws when event has no checkpoint", async () => {
    mockGetEventById.mockReturnValue({
      id: "evt-001",
      checkpointSha: null,
    });

    const tm = createTimelineManager(fakeDb, fakeConfig);

    await expect(tm.revertTo("evt-001")).rejects.toThrow("has no checkpoint");
  });
});

describe("TimelineManager.undo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses git checkout instead of git reset --hard", async () => {
    mockGetLatestCheckpointEvent.mockReturnValue({
      id: "evt-latest",
      checkpointSha: "latest-sha",
    });
    mockGetParentSha.mockResolvedValue("parent-sha-xyz");

    const tm = createTimelineManager(fakeDb, fakeConfig);
    await tm.undo();

    // Should use checkout -- . to avoid moving HEAD
    expect(mockRunGitOrThrow).toHaveBeenCalledWith(
      ["checkout", "parent-sha-xyz", "--", "."],
      { cwd: "/test-project" },
    );

    // Should NOT use reset --hard
    const calls = mockRunGitOrThrow.mock.calls;
    for (const call of calls) {
      expect(call[0]).not.toContain("reset");
    }
  });

  it("throws when no checkpoints exist", async () => {
    mockGetLatestCheckpointEvent.mockReturnValue(null);

    const tm = createTimelineManager(fakeDb, fakeConfig);

    await expect(tm.undo()).rejects.toThrow("No checkpoints to undo");
  });

  it("falls back to HEAD when parent of latest checkpoint not found", async () => {
    mockGetLatestCheckpointEvent.mockReturnValue({
      id: "evt-latest",
      checkpointSha: "latest-sha",
    });
    mockGetParentSha.mockResolvedValue(null);

    const tm = createTimelineManager(fakeDb, fakeConfig);
    await tm.undo();

    // Should fall back to HEAD when parent is unreachable
    expect(mockRunGitOrThrow).toHaveBeenCalledWith(
      ["checkout", "head-sha-123", "--", "."],
      { cwd: "/test-project" },
    );
  });

  it("throws when checkpoint SHA is unreachable in revertTo", async () => {
    mockGetEventById.mockReturnValue({
      id: "evt-001",
      checkpointSha: "unreachable-sha",
    });
    mockShaExists.mockResolvedValue(false);

    const tm = createTimelineManager(fakeDb, fakeConfig);

    await expect(tm.revertTo("evt-001")).rejects.toThrow("no longer reachable");

    // Restore for other tests
    mockShaExists.mockResolvedValue(true);
  });
});
