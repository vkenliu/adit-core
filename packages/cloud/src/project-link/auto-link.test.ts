/**
 * Tests for automatic project-link sync trigger.
 *
 * Validates precondition checks (credentials, staleness, config)
 * and verifies that a detached child process is spawned when all
 * conditions are met.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process.spawn before importing the module under test
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock credentials
const mockLoadCredentials = vi.fn();
const mockCredentialsFromEnvToken = vi.fn();
const mockIsSyncDisabled = vi.fn();
vi.mock("../auth/credentials.js", () => ({
  loadCredentials: (...args: unknown[]) => mockLoadCredentials(...args),
  credentialsFromEnvToken: (...args: unknown[]) => mockCredentialsFromEnvToken(...args),
  isSyncDisabled: (...args: unknown[]) => mockIsSyncDisabled(...args),
}));

// Mock cache
const mockGetProjectLinkCache = vi.fn();
vi.mock("./cache.js", () => ({
  getProjectLinkCache: (...args: unknown[]) => mockGetProjectLinkCache(...args),
}));

// Mock config
const mockLoadCloudConfig = vi.fn();
vi.mock("../config.js", () => ({
  loadCloudConfig: (...args: unknown[]) => mockLoadCloudConfig(...args),
  DEFAULT_SERVER_URL: "https://adit-cloud.varve.ai",
}));

import { triggerProjectLinkSync } from "./auto-link.js";

/** Fake database — triggerProjectLinkSync passes it through to getProjectLinkCache */
const fakeDb = {} as never;

function defaultConfig() {
  return {
    serverUrl: null,
    projectLink: { autoSync: true, staleHours: 2 },
  };
}

function defaultCredentials() {
  return {
    serverUrl: "https://adit-cloud.varve.ai",
    clientId: "test-client",
    accessToken: "tok_test",
    authType: "device",
  };
}

/** Create a mock child process object */
function mockChildProcess() {
  return { unref: vi.fn(), on: vi.fn() };
}

describe("triggerProjectLinkSync", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ADIT_AUTH_TOKEN;
    delete process.env.ADIT_PROJECT_LINK_AUTO_SYNC;

    mockLoadCloudConfig.mockReturnValue(defaultConfig());
    mockLoadCredentials.mockReturnValue(defaultCredentials());
    mockIsSyncDisabled.mockReturnValue(false);
    mockGetProjectLinkCache.mockReturnValue(null);
    mockSpawn.mockReturnValue(mockChildProcess());
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ADIT_")) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("spawns a detached child process when all preconditions pass", async () => {
    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("npx");
    expect(args).toEqual(["adit", "cloud", "project", "link", "--json", "--skip-qualify"]);
    expect(opts.cwd).toBe("/tmp/project");
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "ignore", "ignore"]);

    // Should unref the child so it doesn't keep the parent alive
    const child = mockSpawn.mock.results[0].value;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("skips when project-link auto-sync is disabled", async () => {
    mockLoadCloudConfig.mockReturnValue({
      ...defaultConfig(),
      projectLink: { autoSync: false, staleHours: 2 },
    });

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips when sync is disabled by circuit breaker", async () => {
    mockIsSyncDisabled.mockReturnValue(true);

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips when no credentials exist", async () => {
    mockLoadCredentials.mockReturnValue(null);

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips when credentials have no server URL", async () => {
    mockLoadCredentials.mockReturnValue({ ...defaultCredentials(), serverUrl: null });
    mockLoadCloudConfig.mockReturnValue({ ...defaultConfig(), serverUrl: null });

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("skips when cached data is still fresh", async () => {
    // Cache was synced 30 minutes ago (< 2 hour stale threshold)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    mockGetProjectLinkCache.mockReturnValue({
      lastBranchSyncAt: thirtyMinutesAgo,
    });

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawns when cached data is stale", async () => {
    // Cache was synced 3 hours ago (> 2 hour stale threshold)
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    mockGetProjectLinkCache.mockReturnValue({
      lastBranchSyncAt: threeHoursAgo,
    });

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("spawns when cache has no lastBranchSyncAt (first run)", async () => {
    mockGetProjectLinkCache.mockReturnValue({
      lastBranchSyncAt: null,
    });

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("spawns when no cache exists at all (first run)", async () => {
    mockGetProjectLinkCache.mockReturnValue(null);

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("skips when credentials server URL mismatches config server URL", async () => {
    mockLoadCloudConfig.mockReturnValue({
      ...defaultConfig(),
      serverUrl: "https://other-server.com",
    });
    mockLoadCredentials.mockReturnValue({
      ...defaultCredentials(),
      serverUrl: "https://adit-cloud.varve.ai",
    });

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does not throw when spawn fails", async () => {
    mockSpawn.mockImplementation(() => { throw new Error("npx not found"); });

    // Should not throw — fail-open
    await expect(
      triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project"),
    ).resolves.toBeUndefined();
  });

  it("uses env token credentials when ADIT_AUTH_TOKEN is set", async () => {
    process.env.ADIT_AUTH_TOKEN = "tok_env_test";
    mockCredentialsFromEnvToken.mockReturnValue({
      ...defaultCredentials(),
      accessToken: "tok_env_test",
    });

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("skips when ADIT_AUTH_TOKEN is set but credentialsFromEnvToken returns null", async () => {
    process.env.ADIT_AUTH_TOKEN = "tok_invalid";
    mockCredentialsFromEnvToken.mockReturnValue(null);

    await triggerProjectLinkSync(fakeDb, "proj_123", "/tmp/project");

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
