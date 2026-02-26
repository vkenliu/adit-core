import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";
import { insertSession } from "./sessions.js";
import {
  insertEnvSnapshot,
  getEnvSnapshotById,
  getLatestEnvSnapshot,
  listEnvSnapshots,
} from "./env-snapshots.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-test-env-${randomBytes(8).toString("hex")}.sqlite`);
}

describe("EnvSnapshots CRUD (enriched)", () => {
  let db: Database.Database;
  let dbPath: string;
  const sessionId = "test-session-env";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);

    insertSession(db, {
      id: sessionId,
      projectId: "proj-001",
      clientId: "client-001",
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: "{}",
    });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it("inserts and retrieves a snapshot with all new fields", () => {
    insertEnvSnapshot(db, {
      id: "env-001",
      sessionId,
      gitBranch: "main",
      gitHeadSha: "abc1234",
      modifiedFiles: JSON.stringify(["file.ts"]),
      depLockHash: "hash123",
      depLockPath: "pnpm-lock.yaml",
      envVarsJson: JSON.stringify({ NODE_ENV: "test" }),
      nodeVersion: "v20.0.0",
      pythonVersion: "Python 3.11.0",
      osInfo: "linux 5.15.0",
      containerInfo: JSON.stringify({ inDocker: true }),
      runtimeVersionsJson: JSON.stringify({ rust: "1.75.0", go: "1.21.0" }),
      shellInfo: JSON.stringify({ shell: "/bin/bash", version: "5.2.0" }),
      systemResourcesJson: JSON.stringify({ arch: "x64", cpuModel: "Intel", totalMem: 16000000000, freeMem: 8000000000 }),
      packageManagerJson: JSON.stringify({ name: "pnpm", version: "9.0.0" }),
      vclockJson: "{}",
    });

    const snap = getEnvSnapshotById(db, "env-001");
    expect(snap).not.toBeNull();
    expect(snap!.gitBranch).toBe("main");
    expect(snap!.containerInfo).toBe(JSON.stringify({ inDocker: true }));
    expect(snap!.runtimeVersionsJson).toBe(JSON.stringify({ rust: "1.75.0", go: "1.21.0" }));
    expect(snap!.shellInfo).toBe(JSON.stringify({ shell: "/bin/bash", version: "5.2.0" }));
    expect(snap!.systemResourcesJson).toContain("x64");
    expect(snap!.packageManagerJson).toContain("pnpm");
  });

  it("handles null new fields (backwards compatible)", () => {
    insertEnvSnapshot(db, {
      id: "env-002",
      sessionId,
      gitBranch: "main",
      gitHeadSha: "abc1234",
      vclockJson: "{}",
    });

    const snap = getEnvSnapshotById(db, "env-002");
    expect(snap).not.toBeNull();
    expect(snap!.containerInfo).toBeNull();
    expect(snap!.runtimeVersionsJson).toBeNull();
    expect(snap!.shellInfo).toBeNull();
    expect(snap!.systemResourcesJson).toBeNull();
    expect(snap!.packageManagerJson).toBeNull();
  });

  it("getLatestEnvSnapshot returns most recent", () => {
    insertEnvSnapshot(db, {
      id: "env-003",
      sessionId,
      gitBranch: "main",
      gitHeadSha: "abc1111",
      vclockJson: "{}",
    });
    insertEnvSnapshot(db, {
      id: "env-004",
      sessionId,
      gitBranch: "main",
      gitHeadSha: "abc2222",
      vclockJson: "{}",
    });

    const latest = getLatestEnvSnapshot(db, sessionId);
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe("env-004");
  });

  it("listEnvSnapshots returns all snapshots in reverse order", () => {
    insertEnvSnapshot(db, {
      id: "env-005",
      sessionId,
      gitBranch: "main",
      gitHeadSha: "sha1",
      vclockJson: "{}",
    });
    insertEnvSnapshot(db, {
      id: "env-006",
      sessionId,
      gitBranch: "main",
      gitHeadSha: "sha2",
      vclockJson: "{}",
    });

    const snaps = listEnvSnapshots(db, sessionId, 10);
    expect(snaps).toHaveLength(2);
    // Most recent first
    expect(snaps[0].id).toBe("env-006");
    expect(snaps[1].id).toBe("env-005");
  });

  it("listEnvSnapshots respects limit", () => {
    for (let i = 0; i < 5; i++) {
      insertEnvSnapshot(db, {
        id: `env-limit-${i}`,
        sessionId,
        gitBranch: "main",
        gitHeadSha: `sha${i}`,
        vclockJson: "{}",
      });
    }

    const snaps = listEnvSnapshots(db, sessionId, 3);
    expect(snaps).toHaveLength(3);
  });
});
