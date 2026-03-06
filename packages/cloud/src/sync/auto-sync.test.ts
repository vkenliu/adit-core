import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for time-based and count-based auto-sync triggers.
 *
 * These tests mock all external dependencies (DB, credentials, network)
 * to verify only the trigger decision logic in triggerAutoSync.
 */

const syncFn = vi.fn().mockResolvedValue({
  accepted: 0,
  duplicates: 0,
  conflicts: [],
  newSyncCursor: null,
  batches: 0,
  totalRecords: 0,
});

// Mock modules before importing the subject
vi.mock("../config.js", () => ({
  loadCloudConfig: vi.fn(),
  DEFAULT_SERVER_URL: "https://adit-cloud.varve.ai",
}));

vi.mock("../auth/credentials.js", () => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  isTokenExpired: vi.fn(() => false),
  credentialsFromEnvToken: vi.fn(() => null),
  incrementSyncErrors: vi.fn(() => false),
  clearSyncErrors: vi.fn(),
  isSyncDisabled: vi.fn(() => false),
}));

vi.mock("@adit/core", () => ({
  getSyncState: vi.fn(),
  loadConfig: vi.fn(() => ({ clientId: "test-client" })),
}));

vi.mock("./serializer.js", () => ({
  countUnsyncedRecords: vi.fn(),
}));

vi.mock("./engine.js", () => {
  return {
    SyncEngine: class MockSyncEngine {
      sync = syncFn;
    },
  };
});

vi.mock("../http/client.js", () => {
  return {
    CloudClient: class MockCloudClient {},
  };
});

vi.mock("../http/errors.js", () => ({
  CloudNetworkError: class extends Error {},
  CloudAuthError: class extends Error {},
}));

import { triggerAutoSync } from "./auto-sync.js";
import { loadCloudConfig } from "../config.js";
import { loadCredentials } from "../auth/credentials.js";
import { getSyncState } from "@adit/core";
import { countUnsyncedRecords } from "./serializer.js";

const mockLoadCloudConfig = vi.mocked(loadCloudConfig);
const mockLoadCredentials = vi.mocked(loadCredentials);
const mockGetSyncState = vi.mocked(getSyncState);
const mockCountUnsyncedRecords = vi.mocked(countUnsyncedRecords);

const fakeDb = {} as never;
const PROJECT_ID = "proj-123";
const SERVER_URL = "https://cloud.example.com";

function setupDefaults() {
  mockLoadCloudConfig.mockReturnValue({
    serverUrl: SERVER_URL,
    enabled: true,
    autoSync: true,
    batchSize: 500,
    syncThreshold: 20,
    syncTimeoutHours: 2,
    transcriptUpload: {
      enabled: false,
      pollIntervalSec: 30,
      maxConcurrent: 2,
      maxRetries: 3,
      minIncrementBytes: 1024,
    },
  });

  mockLoadCredentials.mockReturnValue({
    accessToken: "token",
    refreshToken: "refresh",
    clientId: "client-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    serverUrl: SERVER_URL,
  });

  mockGetSyncState.mockReturnValue({
    serverUrl: SERVER_URL,
    clientId: "client-1",
    lastSyncedEventId: "01H000000000000000000000",
    lastSyncedAt: new Date().toISOString(),
    syncVersion: 1,
  });

  mockCountUnsyncedRecords.mockReturnValue(0);
}

describe("triggerAutoSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not sync when count is below threshold and last sync is recent", async () => {
    mockCountUnsyncedRecords.mockReturnValue(10);
    await triggerAutoSync(fakeDb, PROJECT_ID);

    expect(mockCountUnsyncedRecords).toHaveBeenCalled();
    expect(syncFn).not.toHaveBeenCalled();
  });

  it("syncs when count meets threshold", async () => {
    mockCountUnsyncedRecords.mockReturnValue(20);
    await triggerAutoSync(fakeDb, PROJECT_ID);

    expect(mockCountUnsyncedRecords).toHaveBeenCalled();
    expect(syncFn).toHaveBeenCalled();
  });

  it("syncs via time trigger when >2h since last sync, skipping count check", async () => {
    // Last sync was 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    mockGetSyncState.mockReturnValue({
      serverUrl: SERVER_URL,
      clientId: "client-1",
      lastSyncedEventId: "01H000000000000000000000",
      lastSyncedAt: threeHoursAgo,
      syncVersion: 1,
    });

    await triggerAutoSync(fakeDb, PROJECT_ID);

    // Time trigger should skip the expensive count query
    expect(mockCountUnsyncedRecords).not.toHaveBeenCalled();
    expect(syncFn).toHaveBeenCalled();
  });

  it("falls through to count check when last sync is within timeout", async () => {
    // Last sync was 1 hour ago (within 2h timeout)
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    mockGetSyncState.mockReturnValue({
      serverUrl: SERVER_URL,
      clientId: "client-1",
      lastSyncedEventId: "01H000000000000000000000",
      lastSyncedAt: oneHourAgo,
      syncVersion: 1,
    });
    mockCountUnsyncedRecords.mockReturnValue(10);

    await triggerAutoSync(fakeDb, PROJECT_ID);

    // Count should be checked since time trigger didn't fire
    expect(mockCountUnsyncedRecords).toHaveBeenCalled();
    expect(syncFn).not.toHaveBeenCalled();
  });

  it("uses count-based trigger on first sync (no lastSyncedAt)", async () => {
    mockGetSyncState.mockReturnValue(null);
    mockCountUnsyncedRecords.mockReturnValue(60);

    await triggerAutoSync(fakeDb, PROJECT_ID);

    // First sync: no time trigger, falls through to count
    expect(mockCountUnsyncedRecords).toHaveBeenCalled();
    expect(syncFn).toHaveBeenCalled();
  });

  it("respects custom syncTimeoutHours", async () => {
    mockLoadCloudConfig.mockReturnValue({
      serverUrl: SERVER_URL,
      enabled: true,
      autoSync: true,
      batchSize: 500,
      syncThreshold: 20,
      syncTimeoutHours: 1, // 1 hour
      transcriptUpload: {
        enabled: false,
        pollIntervalSec: 30,
        maxConcurrent: 2,
        maxRetries: 3,
        minIncrementBytes: 1024,
      },
    });

    // Last sync was 2 hours ago (>1h timeout)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockGetSyncState.mockReturnValue({
      serverUrl: SERVER_URL,
      clientId: "client-1",
      lastSyncedEventId: "01H000000000000000000000",
      lastSyncedAt: twoHoursAgo,
      syncVersion: 1,
    });

    await triggerAutoSync(fakeDb, PROJECT_ID);

    expect(mockCountUnsyncedRecords).not.toHaveBeenCalled();
    expect(syncFn).toHaveBeenCalled();
  });

  it("does not sync when auto-sync is explicitly disabled via env var", async () => {
    process.env.ADIT_CLOUD_AUTO_SYNC = "false";

    await triggerAutoSync(fakeDb, PROJECT_ID);

    expect(syncFn).not.toHaveBeenCalled();
    delete process.env.ADIT_CLOUD_AUTO_SYNC;
  });

  it("syncs when credentials exist even without ADIT_CLOUD_URL env var", async () => {
    // No server URL in config — falls back to credentials
    mockLoadCloudConfig.mockReturnValue({
      serverUrl: null,
      enabled: false,
      autoSync: false,
      batchSize: 500,
      syncThreshold: 20,
      syncTimeoutHours: 2,
      transcriptUpload: {
        enabled: false,
        pollIntervalSec: 30,
        maxConcurrent: 2,
        maxRetries: 3,
        minIncrementBytes: 1024,
      },
    });
    mockCountUnsyncedRecords.mockReturnValue(25);

    await triggerAutoSync(fakeDb, PROJECT_ID);

    expect(syncFn).toHaveBeenCalled();
  });

  it("force-syncs on session-end even when below threshold and recently synced", async () => {
    mockCountUnsyncedRecords.mockReturnValue(1); // well below threshold

    await triggerAutoSync(fakeDb, PROJECT_ID, { force: true });

    // Should skip threshold checks entirely
    expect(mockCountUnsyncedRecords).not.toHaveBeenCalled();
    expect(mockGetSyncState).not.toHaveBeenCalled();
    expect(syncFn).toHaveBeenCalled();
  });

  it("does not sync when credentials are missing", async () => {
    mockLoadCredentials.mockReturnValue(null);

    await triggerAutoSync(fakeDb, PROJECT_ID);

    expect(syncFn).not.toHaveBeenCalled();
  });

  it("does not sync when credentials belong to different server", async () => {
    mockLoadCredentials.mockReturnValue({
      accessToken: "token",
      refreshToken: "refresh",
      clientId: "client-1",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      serverUrl: "https://other-server.com",
    });

    await triggerAutoSync(fakeDb, PROJECT_ID);

    expect(syncFn).not.toHaveBeenCalled();
  });
});
