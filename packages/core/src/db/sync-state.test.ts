import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";
import { getSyncState, upsertSyncState } from "./sync-state.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-sync-state-${randomBytes(8).toString("hex")}.sqlite`);
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = path + suffix;
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

describe("sync state", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
  });

  it("does not move the local cursor or version backwards", () => {
    upsertSyncState(db, {
      serverUrl: "http://localhost:3000",
      clientId: "client-1",
      lastSyncedEventId: "01H000000000000000000000100",
      lastSyncedAt: "2026-05-18T06:00:00.000Z",
      syncVersion: 10,
    });

    upsertSyncState(db, {
      serverUrl: "http://localhost:3000",
      clientId: "client-1",
      lastSyncedEventId: "01H000000000000000000000050",
      lastSyncedAt: "2026-05-18T05:59:00.000Z",
      syncVersion: 9,
    });

    expect(getSyncState(db, "http://localhost:3000")).toEqual({
      serverUrl: "http://localhost:3000",
      clientId: "client-1",
      lastSyncedEventId: "01H000000000000000000000100",
      lastSyncedAt: "2026-05-18T06:00:00.000Z",
      syncVersion: 10,
    });
  });
});
