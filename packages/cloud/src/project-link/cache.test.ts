/**
 * Tests for project link local cache CRUD operations.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { openDatabase, closeDatabase } from "@adit/core";
import type Database from "better-sqlite3";
import {
  getProjectLinkCache,
  upsertProjectLinkCache,
  clearProjectLinkCache,
  updateCachedCommitSha,
  updateCachedDocHashes,
  updateCachedQualified,
} from "./cache.js";
import type { ProjectLinkCache } from "./types.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-cache-test-${randomBytes(8).toString("hex")}.sqlite`);
}

function makeCache(overrides: Partial<ProjectLinkCache> = {}): ProjectLinkCache {
  return {
    projectId: "proj-abc123",
    serverUrl: "https://cloud.example.com",
    confirmedProjectId: null,
    lastCommitSha: null,
    lastBranchSyncAt: null,
    lastDocSyncAt: null,
    docHashes: {},
    qualified: false,
    initializedAt: "2026-03-10T12:00:00.000Z",
    updatedAt: "2026-03-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("Project Link Cache", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    try { unlinkSync(dbPath); } catch { /* best-effort */ }
  });

  it("returns null when no cache exists", () => {
    const result = getProjectLinkCache(db, "nonexistent", "https://example.com");
    expect(result).toBeNull();
  });

  it("inserts and retrieves a cache entry", () => {
    const cache = makeCache({
      confirmedProjectId: "confirmed-123",
      docHashes: { "README.md": "abc123" },
    });

    upsertProjectLinkCache(db, cache);
    const result = getProjectLinkCache(db, cache.projectId, cache.serverUrl);

    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("proj-abc123");
    expect(result!.confirmedProjectId).toBe("confirmed-123");
    expect(result!.docHashes).toEqual({ "README.md": "abc123" });
    expect(result!.qualified).toBe(false);
  });

  it("upserts an existing cache entry", () => {
    const cache = makeCache();
    upsertProjectLinkCache(db, cache);

    const updated = makeCache({
      confirmedProjectId: "confirmed-456",
      lastCommitSha: "deadbeef",
      updatedAt: "2026-03-10T13:00:00.000Z",
    });
    upsertProjectLinkCache(db, updated);

    const result = getProjectLinkCache(db, cache.projectId, cache.serverUrl);
    expect(result!.confirmedProjectId).toBe("confirmed-456");
    expect(result!.lastCommitSha).toBe("deadbeef");
    // initializedAt should NOT change on upsert
    expect(result!.initializedAt).toBe("2026-03-10T12:00:00.000Z");
  });

  it("clears a cache entry", () => {
    const cache = makeCache();
    upsertProjectLinkCache(db, cache);

    clearProjectLinkCache(db, cache.projectId, cache.serverUrl);

    const result = getProjectLinkCache(db, cache.projectId, cache.serverUrl);
    expect(result).toBeNull();
  });

  it("updates commit SHA", () => {
    const cache = makeCache();
    upsertProjectLinkCache(db, cache);

    updateCachedCommitSha(db, cache.projectId, cache.serverUrl, "newsha123");

    const result = getProjectLinkCache(db, cache.projectId, cache.serverUrl);
    expect(result!.lastCommitSha).toBe("newsha123");
    expect(result!.updatedAt).not.toBe(cache.updatedAt);
  });

  it("updates doc hashes", () => {
    const cache = makeCache({ docHashes: { "README.md": "old-hash" } });
    upsertProjectLinkCache(db, cache);

    const newHashes = { "README.md": "new-hash", "PLAN.md": "plan-hash" };
    updateCachedDocHashes(db, cache.projectId, cache.serverUrl, newHashes);

    const result = getProjectLinkCache(db, cache.projectId, cache.serverUrl);
    expect(result!.docHashes).toEqual(newHashes);
    expect(result!.lastDocSyncAt).not.toBeNull();
  });

  it("updates qualified status", () => {
    const cache = makeCache();
    upsertProjectLinkCache(db, cache);
    expect(getProjectLinkCache(db, cache.projectId, cache.serverUrl)!.qualified).toBe(false);

    updateCachedQualified(db, cache.projectId, cache.serverUrl, true);

    const result = getProjectLinkCache(db, cache.projectId, cache.serverUrl);
    expect(result!.qualified).toBe(true);
  });

  it("supports multiple projects on different servers", () => {
    const cache1 = makeCache({ serverUrl: "https://server1.com" });
    const cache2 = makeCache({ serverUrl: "https://server2.com", confirmedProjectId: "other" });

    upsertProjectLinkCache(db, cache1);
    upsertProjectLinkCache(db, cache2);

    const r1 = getProjectLinkCache(db, cache1.projectId, "https://server1.com");
    const r2 = getProjectLinkCache(db, cache1.projectId, "https://server2.com");
    expect(r1!.confirmedProjectId).toBeNull();
    expect(r2!.confirmedProjectId).toBe("other");
  });
});
