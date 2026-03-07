/**
 * Tests for cloud credential management — circuit breaker logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * We mock homedir() so credential files go to a temp directory
 * instead of the real ~/.adit/ folder.
 */
const tempHome = join(tmpdir(), `adit-creds-test-${randomBytes(8).toString("hex")}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  incrementSyncErrors,
  clearSyncErrors,
  isSyncDisabled,
  type CloudCredentials,
} from "./credentials.js";

function makeCreds(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
  return {
    authType: "token",
    accessToken: "test-token",
    refreshToken: "",
    clientId: "test-client",
    expiresAt: "",
    serverUrl: "http://localhost:3000",
    ...overrides,
  };
}

describe("Circuit Breaker", () => {
  beforeEach(() => {
    mkdirSync(join(tempHome, ".adit"), { recursive: true });
    // Start with valid credentials
    saveCredentials(makeCreds());
  });

  afterEach(() => {
    try {
      const path = join(tempHome, ".adit", "cloud-credentials.json");
      if (existsSync(path)) unlinkSync(path);
    } catch { /* best-effort cleanup */ }
  });

  it("is not disabled initially", () => {
    expect(isSyncDisabled()).toBe(false);
  });

  it("increments error count without disabling below threshold", () => {
    incrementSyncErrors(5);
    incrementSyncErrors(5);
    incrementSyncErrors(5);

    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(3);
    expect(creds?.syncDisabled).toBe(false);
    expect(isSyncDisabled()).toBe(false);
  });

  it("disables sync at threshold (5 errors)", () => {
    for (let i = 0; i < 5; i++) {
      incrementSyncErrors(5);
    }

    expect(isSyncDisabled()).toBe(true);
    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(5);
    expect(creds?.syncDisabled).toBe(true);
  });

  it("clearSyncErrors resets counter and re-enables sync", () => {
    for (let i = 0; i < 5; i++) {
      incrementSyncErrors(5);
    }
    expect(isSyncDisabled()).toBe(true);

    clearSyncErrors();

    expect(isSyncDisabled()).toBe(false);
    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(0);
    expect(creds?.syncDisabled).toBe(false);
    expect(creds?.firstSyncErrorAt).toBeUndefined();
  });

  it("records firstSyncErrorAt on first error", () => {
    const before = Date.now();
    incrementSyncErrors(5);
    const after = Date.now();

    const creds = loadCredentials();
    expect(creds?.firstSyncErrorAt).toBeDefined();
    const errorTime = new Date(creds!.firstSyncErrorAt!).getTime();
    expect(errorTime).toBeGreaterThanOrEqual(before);
    expect(errorTime).toBeLessThanOrEqual(after);
  });

  it("preserves firstSyncErrorAt across consecutive errors within window", () => {
    incrementSyncErrors(5);
    const creds1 = loadCredentials();
    const firstErrorAt = creds1?.firstSyncErrorAt;

    incrementSyncErrors(5);
    const creds2 = loadCredentials();

    expect(creds2?.firstSyncErrorAt).toBe(firstErrorAt);
    expect(creds2?.syncErrorCount).toBe(2);
  });

  it("auto-resets breaker when error window has expired", () => {
    // Simulate 5 errors that happened 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    saveCredentials(makeCreds({
      syncErrorCount: 5,
      syncDisabled: true,
      firstSyncErrorAt: twoHoursAgo,
    }));

    // isSyncDisabled should auto-reset because window expired
    expect(isSyncDisabled()).toBe(false);

    // Credentials should be cleaned up
    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(0);
    expect(creds?.syncDisabled).toBe(false);
  });

  it("stays disabled when errors are within the window", () => {
    // Simulate 5 errors that happened 30 minutes ago
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    saveCredentials(makeCreds({
      syncErrorCount: 5,
      syncDisabled: true,
      firstSyncErrorAt: thirtyMinAgo,
    }));

    expect(isSyncDisabled()).toBe(true);
  });

  it("resets error count when new error is outside the window", () => {
    // Simulate old errors from 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    saveCredentials(makeCreds({
      syncErrorCount: 4,
      syncDisabled: false,
      firstSyncErrorAt: twoHoursAgo,
    }));

    // New error should reset window — count starts from 1
    incrementSyncErrors(5);

    const creds = loadCredentials();
    expect(creds?.syncErrorCount).toBe(1);
    expect(creds?.syncDisabled).toBe(false);
    // firstSyncErrorAt should be updated to now
    const errorTime = new Date(creds!.firstSyncErrorAt!).getTime();
    expect(Date.now() - errorTime).toBeLessThan(5000);
  });

  it("returns false from incrementSyncErrors when no credentials", () => {
    clearCredentials();
    expect(incrementSyncErrors(5)).toBe(false);
  });

  it("clearSyncErrors is a no-op when no credentials", () => {
    clearCredentials();
    // Should not throw
    clearSyncErrors();
  });
});
