/**
 * Tests for the SyncEngine.
 *
 * Verifies cursor-based incremental push, batch termination conditions,
 * and the infinite-loop guard (all duplicates + unchanged cursor).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@adit/core", () => ({
  getSyncState: vi.fn(() => null),
  upsertSyncState: vi.fn(),
  withPerf: vi.fn((_dir: string, _cat: string, _op: string, fn: () => unknown) => fn()),
}));

vi.mock("./serializer.js", () => ({
  buildSyncBatch: vi.fn(),
  batchRecordCount: vi.fn(),
}));

vi.mock("./conflicts.js", () => ({
  handleConflicts: vi.fn(),
}));

import { SyncEngine } from "./engine.js";
import { upsertSyncState } from "@adit/core";
import { buildSyncBatch, batchRecordCount } from "./serializer.js";

const mockBuildSyncBatch = vi.mocked(buildSyncBatch);
const mockBatchRecordCount = vi.mocked(batchRecordCount);
const mockUpsertSyncState = vi.mocked(upsertSyncState);

function createEngine(overrides: { batchSize?: number } = {}) {
  const mockClient = {
    get: vi.fn().mockResolvedValue({
      lastSyncedEventId: null,
      syncVersion: 0,
      lastSyncedAt: null,
    }),
    post: vi.fn().mockResolvedValue({
      accepted: 0,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: "cursor-1",
      newSyncVersion: 1,
    }),
  };

  const engine = new SyncEngine({} as never, mockClient as never, {
    projectId: "proj-001",
    batchSize: overrides.batchSize ?? 500,
    serverUrl: "https://cloud.example.com",
    cloudClientId: "client-001",
  });

  return { engine, mockClient };
}

describe("SyncEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when no records to sync", async () => {
    const { engine, mockClient } = createEngine();
    mockBatchRecordCount.mockReturnValue(0);
    mockBuildSyncBatch.mockReturnValue({ events: [], sessions: [], envSnapshots: [] } as never);

    const result = await engine.sync();

    expect(result.batches).toBe(0);
    expect(result.totalRecords).toBe(0);
    expect(result.accepted).toBe(0);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  it("pushes a single batch and stops when count < batchSize", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 500 });
    mockBuildSyncBatch.mockImplementation(() => ({ events: [{}], sessions: [] }) as never);
    let callCount = 0;
    mockBatchRecordCount.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? 10 : 0;
    });
    mockClient.post.mockResolvedValue({
      accepted: 10,
      duplicates: 0,
      conflicts: [],
      newSyncCursor: "cursor-after-10",
      newSyncVersion: 1,
    });

    const result = await engine.sync();

    expect(result.batches).toBe(1);
    expect(result.totalRecords).toBe(10);
    expect(result.accepted).toBe(10);
    expect(mockUpsertSyncState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lastSyncedEventId: "cursor-after-10",
      }),
    );
  });

  it("pushes multiple batches when first batch is full", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 100 });

    mockBuildSyncBatch.mockImplementation(() => ({ events: [{}], sessions: [] }) as never);
    let callCount = 0;
    mockBatchRecordCount.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? 100 : 50;
    });

    mockClient.post
      .mockResolvedValueOnce({
        accepted: 100,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "cursor-100",
        newSyncVersion: 1,
      })
      .mockResolvedValueOnce({
        accepted: 50,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: "cursor-150",
        newSyncVersion: 2,
      });

    const result = await engine.sync();

    expect(result.batches).toBe(2);
    expect(result.totalRecords).toBe(150);
    expect(result.accepted).toBe(150);
  });

  it("breaks on duplicate-only batch with unchanged cursor (infinite loop guard)", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 100 });
    mockBuildSyncBatch.mockReturnValue({ events: [{}], sessions: [] } as never);
    mockBatchRecordCount.mockReturnValue(100); // always full

    // Server returns all duplicates and doesn't advance cursor
    mockClient.post.mockResolvedValue({
      accepted: 0,
      duplicates: 100,
      conflicts: [],
      newSyncCursor: null, // cursor unchanged (was null, still null)
      newSyncVersion: 0,
    });

    const result = await engine.sync();

    // Should have stopped after 1 batch instead of looping forever
    expect(result.batches).toBe(1);
    expect(result.accepted).toBe(0);
    expect(result.duplicates).toBe(100);
  });

  it("continues when cursor advances even with all duplicates", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 100 });
    mockBuildSyncBatch.mockReturnValue({ events: [{}], sessions: [] } as never);
    mockBatchRecordCount
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(0); // stops on second call

    // Server returns all duplicates but advances cursor
    mockClient.post.mockResolvedValueOnce({
      accepted: 0,
      duplicates: 100,
      conflicts: [],
      newSyncCursor: "cursor-advanced",
      newSyncVersion: 1,
    });

    const result = await engine.sync();

    // Should have continued past the first batch since cursor advanced
    expect(result.batches).toBe(1);
  });

  it("accumulates conflicts across batches", async () => {
    const { engine, mockClient } = createEngine({ batchSize: 100 });

    let batchCall = 0;
    mockBuildSyncBatch.mockImplementation(() => ({ events: [{}], sessions: [] }) as never);
    mockBatchRecordCount.mockImplementation(() => {
      batchCall++;
      if (batchCall === 1) return 100;
      return 50;
    });

    mockClient.post
      .mockResolvedValueOnce({
        accepted: 99,
        duplicates: 0,
        conflicts: [{ type: "event", id: "evt-001", resolution: "server_wins" }],
        newSyncCursor: "cursor-100",
        newSyncVersion: 1,
      })
      .mockResolvedValueOnce({
        accepted: 49,
        duplicates: 0,
        conflicts: [{ type: "session", id: "sess-001", resolution: "server_wins" }],
        newSyncCursor: "cursor-150",
        newSyncVersion: 2,
      });

    const result = await engine.sync();

    expect(result.conflicts).toHaveLength(2);
    expect(result.accepted).toBe(148);
  });
});
