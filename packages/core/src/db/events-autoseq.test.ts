/**
 * Tests for insertEventAutoSeq — atomic sequence allocation.
 *
 * Verifies that the sequence number is atomically computed in the INSERT
 * statement itself, preventing duplicate sequences from concurrent processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openDatabase, closeDatabase } from "./connection.js";
import { insertSession } from "./sessions.js";
import {
  insertEventAutoSeq,
  getEventById,
  getEventsBySession,
  allocateSequence,
  insertEvent,
} from "./events.js";

function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}

describe("insertEventAutoSeq", () => {
  let db: Database.Database;
  let dbPath: string;
  const sessionId = "test-session-autoseq";

  beforeEach(() => {
    dbPath = tempDbPath();
    db = openDatabase(dbPath);

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

  it("assigns sequence 1 to the first event", () => {
    insertEventAutoSeq(db, {
      id: "evt-auto-001",
      sessionId,
      eventType: "prompt_submit",
      actor: "user",
      promptText: "Hello",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    const event = getEventById(db, "evt-auto-001");
    expect(event).not.toBeNull();
    expect(event!.sequence).toBe(1);
  });

  it("assigns monotonically increasing sequences", () => {
    for (let i = 1; i <= 5; i++) {
      insertEventAutoSeq(db, {
        id: `evt-auto-${String(i).padStart(3, "0")}`,
        sessionId,
        eventType: "prompt_submit",
        actor: "user",
        startedAt: new Date().toISOString(),
        vclockJson: `{"test-client": ${i}}`,
      });
    }

    const events = getEventsBySession(db, sessionId);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("assigns independent sequences per session", () => {
    const session2 = "test-session-autoseq-2";
    insertSession(db, {
      id: session2,
      projectId: "test-project",
      clientId: "test-client",
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    // Insert 3 events in session 1
    for (let i = 1; i <= 3; i++) {
      insertEventAutoSeq(db, {
        id: `evt-s1-${i}`,
        sessionId,
        eventType: "prompt_submit",
        actor: "user",
        startedAt: new Date().toISOString(),
        vclockJson: `{"test-client": ${i}}`,
      });
    }

    // Insert 2 events in session 2
    for (let i = 1; i <= 2; i++) {
      insertEventAutoSeq(db, {
        id: `evt-s2-${i}`,
        sessionId: session2,
        eventType: "prompt_submit",
        actor: "user",
        startedAt: new Date().toISOString(),
        vclockJson: `{"test-client": ${i}}`,
      });
    }

    const s1Events = getEventsBySession(db, sessionId);
    const s2Events = getEventsBySession(db, session2);
    expect(s1Events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(s2Events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("correctly continues after manually inserted events", () => {
    // Insert one event using the old pattern
    insertEvent(db, {
      id: "evt-manual-001",
      sessionId,
      sequence: allocateSequence(db, sessionId),
      eventType: "prompt_submit",
      actor: "user",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 1}',
    });

    // Insert next event using the new auto-seq pattern
    insertEventAutoSeq(db, {
      id: "evt-auto-002",
      sessionId,
      eventType: "assistant_response",
      actor: "assistant",
      startedAt: new Date().toISOString(),
      vclockJson: '{"test-client": 2}',
    });

    const events = getEventsBySession(db, sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
  });

  it("stores all event fields correctly", () => {
    const now = new Date().toISOString();
    insertEventAutoSeq(db, {
      id: "evt-full-001",
      sessionId,
      parentEventId: null,
      eventType: "tool_call",
      actor: "tool",
      promptText: "test prompt",
      cotText: "thinking...",
      responseText: "result",
      toolName: "Read",
      toolInputJson: '{"path": "/foo"}',
      toolOutputJson: '{"content": "bar"}',
      gitBranch: "main",
      gitHeadSha: "abc123",
      startedAt: now,
      endedAt: now,
      status: "success",
      errorJson: null,
      planTaskId: null,
      clientId: "test-client",
      vclockJson: '{"test-client": 1}',
    });

    const event = getEventById(db, "evt-full-001");
    expect(event).not.toBeNull();
    expect(event!.eventType).toBe("tool_call");
    expect(event!.actor).toBe("tool");
    expect(event!.promptText).toBe("test prompt");
    expect(event!.toolName).toBe("Read");
    expect(event!.toolInputJson).toBe('{"path": "/foo"}');
    expect(event!.gitBranch).toBe("main");
    expect(event!.clientId).toBe("test-client");
    expect(event!.sequence).toBe(1);
  });
});
