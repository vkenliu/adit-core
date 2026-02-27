import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";
import { insertSession } from "./sessions.js";
import { insertEvent, clearEvents, countEvents } from "./events.js";
import { insertDiff } from "./diffs.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}

describe("clearEvents", () => {
  let db: Database.Database;
  let dbPath: string;
  const projectId = "test-project";
  const sessionId = "test-session-001";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);

    insertSession(db, {
      id: sessionId,
      projectId,
      clientId: "test-client",
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
  });

  afterEach(() => {
    closeDatabase(db);
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
      if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
    } catch {
      // Best effort
    }
  });

  it("returns 0 when no events exist", () => {
    const deleted = clearEvents(db, projectId);
    expect(deleted).toBe(0);
  });

  it("clears all events for a project", () => {
    for (let i = 1; i <= 5; i++) {
      insertEvent(db, {
        id: `evt-${String(i).padStart(3, "0")}`,
        sessionId,
        sequence: i,
        eventType: "tool_call",
        actor: "tool",
        startedAt: new Date().toISOString(),
        vclockJson: `{"test-client": ${i}}`,
      });
    }

    expect(countEvents(db, projectId)).toBe(5);
    const deleted = clearEvents(db, projectId);
    expect(deleted).toBe(5);
    expect(countEvents(db, projectId)).toBe(0);
  });

  it("clears associated diffs", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
      checkpointSha: "abc123",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    insertDiff(db, {
      id: "diff-001",
      eventId: "evt-001",
      diffText: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
    });

    clearEvents(db, projectId);

    const diffCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM diffs").get() as { cnt: number }
    ).cnt;
    expect(diffCount).toBe(0);
  });

  it("clears sessions after clearing events", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    clearEvents(db, projectId);

    const sessionCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ?").get(projectId) as {
        cnt: number;
      }
    ).cnt;
    expect(sessionCount).toBe(0);
  });

  it("clears sync state after clearing events", () => {
    db.prepare(
      "INSERT INTO sync_state (server_url, client_id, last_synced_event_id, sync_version) VALUES (?, ?, ?, ?)",
    ).run("https://example.com", "client-1", "evt-001", 1);

    clearEvents(db, projectId);

    const syncCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM sync_state").get() as { cnt: number }
    ).cnt;
    expect(syncCount).toBe(0);
  });

  it("does not clear events from other projects", () => {
    const otherSessionId = "other-session";
    insertSession(db, {
      id: otherSessionId,
      projectId: "other-project",
      clientId: "test-client",
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    insertEvent(db, {
      id: "evt-002",
      sessionId: otherSessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });

    clearEvents(db, projectId);

    expect(countEvents(db, projectId)).toBe(0);
    expect(countEvents(db, "other-project")).toBe(1);
  });
});

describe("countEvents", () => {
  let db: Database.Database;
  let dbPath: string;
  const projectId = "test-project";
  const sessionId = "test-session-001";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);

    insertSession(db, {
      id: sessionId,
      projectId,
      clientId: "test-client",
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
  });

  afterEach(() => {
    closeDatabase(db);
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
      if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
    } catch {
      // Best effort
    }
  });

  it("returns 0 for empty database", () => {
    expect(countEvents(db, projectId)).toBe(0);
  });

  it("counts events for a specific project", () => {
    for (let i = 1; i <= 3; i++) {
      insertEvent(db, {
        id: `evt-${String(i).padStart(3, "0")}`,
        sessionId,
        sequence: i,
        eventType: "tool_call",
        actor: "tool",
        startedAt: new Date().toISOString(),
        vclockJson: `{"test-client": ${i}}`,
      });
    }

    expect(countEvents(db, projectId)).toBe(3);
  });
});
