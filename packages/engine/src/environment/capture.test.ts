/**
 * Tests for the environment capture secret blocklist.
 *
 * Verifies that known secret env vars (NPM_TOKEN, NODE_AUTH_TOKEN, etc.)
 * are excluded from captured environment snapshots even though they match
 * the SAFE_ENV_PREFIXES list.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all external dependencies
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:util", () => ({
  promisify: vi.fn(() => vi.fn().mockRejectedValue(new Error("not found"))),
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => "{}"),
  existsSync: vi.fn(() => false),
}));
vi.mock("@adit/core", () => ({
  generateId: vi.fn(() => "env-001"),
  createClock: vi.fn(() => ({})),
  serialize: vi.fn(() => '{"c": 1}'),
  insertEnvSnapshot: vi.fn(),
}));
vi.mock("../git/runner.js", () => ({
  getHeadSha: vi.fn().mockResolvedValue("abc123"),
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
}));
vi.mock("../detector/working-tree.js", () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
}));

import { captureEnvironment } from "./capture.js";
import { insertEnvSnapshot } from "@adit/core";

const mockInsertEnvSnapshot = vi.mocked(insertEnvSnapshot);

describe("Environment Capture — Secret Blocklist", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("excludes NPM_TOKEN from captured env vars", async () => {
    process.env.NPM_TOKEN = "npm_secret_token_12345";
    process.env.NPM_CONFIG_REGISTRY = "https://registry.npmjs.org";

    const fakeDb = {} as never;
    const fakeConfig = {
      projectRoot: "/test",
      dataDir: "/tmp/adit",
      clientId: "test-client",
      projectId: "proj-001",
      dbPath: "/tmp/test.db",
      captureEnv: true,
    };

    await captureEnvironment(fakeDb, fakeConfig as never, "sess-001");

    expect(mockInsertEnvSnapshot).toHaveBeenCalledTimes(1);
    const envVarsJson = mockInsertEnvSnapshot.mock.calls[0][1].envVarsJson as string;
    const envVars = JSON.parse(envVarsJson);

    // NPM_TOKEN should be excluded
    expect(envVars).not.toHaveProperty("NPM_TOKEN");
    // NPM_CONFIG_REGISTRY should be included (safe)
    expect(envVars).toHaveProperty("NPM_CONFIG_REGISTRY");
  });

  it("excludes NODE_AUTH_TOKEN from captured env vars", async () => {
    process.env.NODE_AUTH_TOKEN = "ghp_secret123";
    process.env.NODE_ENV = "development";

    const fakeDb = {} as never;
    const fakeConfig = {
      projectRoot: "/test",
      dataDir: "/tmp/adit",
      clientId: "test-client",
      projectId: "proj-001",
      dbPath: "/tmp/test.db",
      captureEnv: true,
    };

    await captureEnvironment(fakeDb, fakeConfig as never, "sess-001");

    expect(mockInsertEnvSnapshot).toHaveBeenCalledTimes(1);
    const envVarsJson = mockInsertEnvSnapshot.mock.calls[0][1].envVarsJson as string;
    const envVars = JSON.parse(envVarsJson);

    expect(envVars).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(envVars).toHaveProperty("NODE_ENV");
  });

  it("excludes NPM_CONFIG_AUTHTOKEN from captured env vars", async () => {
    process.env.NPM_CONFIG_AUTHTOKEN = "auth_token_secret";
    process.env.NPM_CONFIG_LOGLEVEL = "warn";

    const fakeDb = {} as never;
    const fakeConfig = {
      projectRoot: "/test",
      dataDir: "/tmp/adit",
      clientId: "test-client",
      projectId: "proj-001",
      dbPath: "/tmp/test.db",
      captureEnv: true,
    };

    await captureEnvironment(fakeDb, fakeConfig as never, "sess-001");

    expect(mockInsertEnvSnapshot).toHaveBeenCalledTimes(1);
    const envVarsJson = mockInsertEnvSnapshot.mock.calls[0][1].envVarsJson as string;
    const envVars = JSON.parse(envVarsJson);

    expect(envVars).not.toHaveProperty("NPM_CONFIG_AUTHTOKEN");
    expect(envVars).toHaveProperty("NPM_CONFIG_LOGLEVEL");
  });

  it("excludes all known secret env vars simultaneously", async () => {
    process.env.NPM_TOKEN = "secret1";
    process.env.NPM_CONFIG_AUTHTOKEN = "secret2";
    process.env.NPM_CONFIG__AUTH = "secret3";
    process.env.NODE_AUTH_TOKEN = "secret4";
    process.env.NODE_PRE_GYP_GITHUB_TOKEN = "secret5";
    // These should still be captured
    process.env.NODE_ENV = "production";
    process.env.NPM_CONFIG_LOGLEVEL = "info";

    const fakeDb = {} as never;
    const fakeConfig = {
      projectRoot: "/test",
      dataDir: "/tmp/adit",
      clientId: "test-client",
      projectId: "proj-001",
      dbPath: "/tmp/test.db",
      captureEnv: true,
    };

    await captureEnvironment(fakeDb, fakeConfig as never, "sess-001");

    expect(mockInsertEnvSnapshot).toHaveBeenCalledTimes(1);
    const envVarsJson = mockInsertEnvSnapshot.mock.calls[0][1].envVarsJson as string;
    const envVars = JSON.parse(envVarsJson);

    expect(envVars).not.toHaveProperty("NPM_TOKEN");
    expect(envVars).not.toHaveProperty("NPM_CONFIG_AUTHTOKEN");
    expect(envVars).not.toHaveProperty("NPM_CONFIG__AUTH");
    expect(envVars).not.toHaveProperty("NODE_AUTH_TOKEN");
    expect(envVars).not.toHaveProperty("NODE_PRE_GYP_GITHUB_TOKEN");
    expect(envVars).toHaveProperty("NODE_ENV");
    expect(envVars).toHaveProperty("NPM_CONFIG_LOGLEVEL");
  });
});
