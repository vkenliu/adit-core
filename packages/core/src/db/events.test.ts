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
