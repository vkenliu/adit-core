import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";
import { insertSession } from "./sessions.js";
import {
  insertEvent,
  getEventById,
  queryEvents,
  getEventsBySession,
  updateEventStatus,
  updateEventLabels,
  allocateSequence,
  searchEvents,
  getLatestCheckpointEvent,
  getLatestCheckpointByBranch,
} from "./events.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}

describe("Events CRUD", () => {
  let db: Database.Database;
  let dbPath: string;
  const sessionId = "test-session-001";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);

    // Create a test session
    insertSession(db, {
      id: sessionId,
      projectId: "test-project",
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

  it("inserts and retrieves an event", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Hello, Claude!",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    const event = getEventById(db, "evt-001");
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("prompt_submit");
    expect(event!.actor).toBe("user");
    expect(event!.promptText).toBe("Hello, Claude!");
  });

  it("allocates monotonic sequences", () => {
    const seq1 = allocateSequence(db, sessionId);
    expect(seq1).toBe(1);

    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: seq1,
      eventType: "prompt_submit",
      actor: "user",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    const seq2 = allocateSequence(db, sessionId);
    expect(seq2).toBe(2);
  });

  it("queries events by type and actor", () => {
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
      sessionId,
      sequence: 2,
      eventType: "tool_call",
      actor: "tool",
      toolName: "Read",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });

    const userEvents = queryEvents(db, { actor: "user" });
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].actor).toBe("user");

    const toolEvents = queryEvents(db, { eventType: "tool_call" });
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].toolName).toBe("Read");
  });

  it("updates event status", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "tool_call",
      actor: "tool",
      startedAt: new Date().toISOString(),
      status: "running",
      vclockJson: '{"test-client": 1}',
    });

    updateEventStatus(db, "evt-001", "success");
    const event = getEventById(db, "evt-001");
    expect(event!.status).toBe("success");
    expect(event!.endedAt).not.toBeNull();
  });

  it("updates labels", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    updateEventLabels(
      db,
      "evt-001",
      '["working-auth", "pre-refactor"]',
      '{"test-client": 2}',
    );

    const event = getEventById(db, "evt-001");
    expect(JSON.parse(event!.labelsJson!)).toEqual([
      "working-auth",
      "pre-refactor",
    ]);
  });

  it("searches events by prompt text", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Add authentication to the login page",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
    insertEvent(db, {
      id: "evt-002",
      sessionId,
      sequence: 2,
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Fix the CSS styling on the header",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });

    const results = searchEvents(db, "authentication");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("evt-001");
  });

  it("finds latest checkpoint event", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
      checkpointSha: "abc123",
      checkpointRef: "refs/adit/checkpoints/evt-001",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
    insertEvent(db, {
      id: "evt-002",
      sessionId,
      sequence: 2,
      eventType: "assistant_response",
      actor: "assistant",
      checkpointSha: "def456",
      checkpointRef: "refs/adit/checkpoints/evt-002",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });

    const latest = getLatestCheckpointEvent(db);
    expect(latest).not.toBeNull();
    expect(latest!.checkpointSha).toBe("def456");
  });

  it("queries events filtered by git branch", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: "main",
      checkpointSha: "aaa111",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });
    insertEvent(db, {
      id: "evt-002",
      sessionId,
      sequence: 2,
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: "feature/auth",
      checkpointSha: "bbb222",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });
    insertEvent(db, {
      id: "evt-003",
      sessionId,
      sequence: 3,
      eventType: "prompt_submit",
      actor: "user",
      gitBranch: "main",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 3}',
    });

    const mainEvents = queryEvents(db, { gitBranch: "main" });
    expect(mainEvents).toHaveLength(2);
    expect(mainEvents.every((e) => e.gitBranch === "main")).toBe(true);

    const featureEvents = queryEvents(db, { gitBranch: "feature/auth" });
    expect(featureEvents).toHaveLength(1);
    expect(featureEvents[0].id).toBe("evt-002");

    // Combined filter: branch + checkpoint
    const mainCheckpoints = queryEvents(db, { gitBranch: "main", hasCheckpoint: true });
    expect(mainCheckpoints).toHaveLength(1);
    expect(mainCheckpoints[0].id).toBe("evt-001");
  });

  it("finds latest checkpoint by branch", () => {
    // Two checkpoints on main, one on feature branch
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: "main",
      checkpointSha: "aaa111",
      checkpointRef: "refs/adit/checkpoints/evt-001",
      startedAt: "2025-01-01T10:00:00Z",
      vclockJson: '{"test-client": 1}',
    });
    insertEvent(db, {
      id: "evt-002",
      sessionId,
      sequence: 2,
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: "main",
      checkpointSha: "bbb222",
      checkpointRef: "refs/adit/checkpoints/evt-002",
      startedAt: "2025-01-01T11:00:00Z",
      vclockJson: '{"test-client": 2}',
    });
    insertEvent(db, {
      id: "evt-003",
      sessionId,
      sequence: 3,
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: "feature/auth",
      checkpointSha: "ccc333",
      checkpointRef: "refs/adit/checkpoints/evt-003",
      startedAt: "2025-01-01T12:00:00Z",
      vclockJson: '{"test-client": 3}',
    });

    // Latest on main should be the second checkpoint
    const mainLatest = getLatestCheckpointByBranch(db, "main");
    expect(mainLatest).not.toBeNull();
    expect(mainLatest!.id).toBe("evt-002");
    expect(mainLatest!.checkpointSha).toBe("bbb222");

    // Latest on feature should be the third checkpoint
    const featureLatest = getLatestCheckpointByBranch(db, "feature/auth");
    expect(featureLatest).not.toBeNull();
    expect(featureLatest!.id).toBe("evt-003");
    expect(featureLatest!.checkpointSha).toBe("ccc333");
  });

  it("returns null for branch with no checkpoints", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "prompt_submit",
      actor: "user",
      gitBranch: "main",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    const result = getLatestCheckpointByBranch(db, "main");
    expect(result).toBeNull();

    // Non-existent branch
    const noResult = getLatestCheckpointByBranch(db, "does-not-exist");
    expect(noResult).toBeNull();
  });

  it("ignores deleted events when finding latest checkpoint by branch", () => {
    insertEvent(db, {
      id: "evt-001",
      sessionId,
      sequence: 1,
      eventType: "assistant_response",
      actor: "assistant",
      gitBranch: "main",
      checkpointSha: "aaa111",
      checkpointRef: "refs/adit/checkpoints/evt-001",
      startedAt: "2025-01-01T10:00:00Z",
      vclockJson: '{"test-client": 1}',
    });

    // Soft-delete the event
    db.prepare("UPDATE events SET deleted_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      "evt-001",
    );

    const result = getLatestCheckpointByBranch(db, "main");
    expect(result).toBeNull();
  });

  it("gets events by session ordered by sequence", () => {
    for (let i = 1; i <= 5; i++) {
      insertEvent(db, {
        id: `evt-${String(i).padStart(3, "0")}`,
        sessionId,
        sequence: i,
        eventType: "tool_call",
        actor: "tool",
        toolName: `Tool${i}`,
        startedAt: new Date().toISOString(),
        vclockJson: `{"test-client": ${i}}`,
      });
    }

    const events = getEventsBySession(db, sessionId);
    expect(events).toHaveLength(5);
    expect(events[0].sequence).toBe(1);
    expect(events[4].sequence).toBe(5);
  });
});
