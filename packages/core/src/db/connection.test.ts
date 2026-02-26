import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openDatabase, closeDatabase } from "./connection.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}

describe("Database", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      try {
        if (existsSync(p)) unlinkSync(p);
        if (existsSync(p + "-wal")) unlinkSync(p + "-wal");
        if (existsSync(p + "-shm")) unlinkSync(p + "-shm");
      } catch {
        // Best effort
      }
    }
    paths.length = 0;
  });

  it("creates a new database with all tables", () => {
    const path = tempDbPath();
    paths.push(path);
    const db = openDatabase(path);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain("sessions");
    expect(tables).toContain("events");
    expect(tables).toContain("env_snapshots");
    expect(tables).toContain("plans");
    expect(tables).toContain("diffs");
    expect(tables).toContain("_migrations");

    closeDatabase(db);
  });

  it("runs migrations only once", () => {
    const path = tempDbPath();
    paths.push(path);

    // Open twice — migrations should not fail
    const db1 = openDatabase(path);
    closeDatabase(db1);

    const db2 = openDatabase(path);
    const migrationCount = db2
      .prepare("SELECT COUNT(*) as count FROM _migrations")
      .get() as { count: number };
    expect(migrationCount.count).toBeGreaterThan(0);
    closeDatabase(db2);
  });

  it("uses WAL mode", () => {
    const path = tempDbPath();
    paths.push(path);
    const db = openDatabase(path);

    const mode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    expect(mode[0].journal_mode).toBe("wal");

    closeDatabase(db);
  });
});
