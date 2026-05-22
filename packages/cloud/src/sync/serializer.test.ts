import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  closeDatabase,
  insertEvent,
  insertSession,
  openDatabase,
} from "@varveai/adit-core";
import { buildSyncBatch } from "./serializer.js";

const PROJECT_ID = "proj-serializer";
const LOCAL_CLIENT_ID = "local-client";
const CLOUD_CLIENT_ID = "cloud-client";

function tempDbPath(): string {
  return join(tmpdir(), `adit-cloud-serializer-${randomBytes(8).toString("hex")}.sqlite`);
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = path + suffix;
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

function insertTestSession(db: Database.Database, id: string): void {
  insertSession(db, {
    id,
    projectId: PROJECT_ID,
    clientId: LOCAL_CLIENT_ID,
    sessionType: "interactive",
    platform: "claude-code",
    startedAt: "2026-05-18T00:00:00.000Z",
    vclockJson: "{}",
  });
}

function insertTestEvent(
  db: Database.Database,
  input: {
    id: string;
    sessionId: string;
    eventType: "checkpoint" | "prompt_submit" | "assistant_response";
    sequence: number;
    promptText?: string;
    responseText?: string;
  },
): void {
  insertEvent(db, {
    id: input.id,
    sessionId: input.sessionId,
    sequence: input.sequence,
    eventType: input.eventType,
    actor: input.eventType === "prompt_submit" ? "user" : "assistant",
    promptText: input.promptText ?? null,
    responseText: input.responseText ?? null,
    startedAt: "2026-05-18T00:00:00.000Z",
    status: "success",
    vclockJson: "{}",
  });
}

describe("sync serializer", () => {
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

  it("stops the event batch before an unanswered prompt", () => {
    const firstSessionId = "01H000000000000000000000001";
    const laterSessionId = "01H000000000000000000000025";
    insertTestSession(db, firstSessionId);
    insertTestSession(db, laterSessionId);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId: firstSessionId,
      eventType: "checkpoint",
      sequence: 1,
      responseText: "Session started",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000020",
      sessionId: firstSessionId,
      eventType: "prompt_submit",
      sequence: 2,
      promptText: "half turn",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000030",
      sessionId: laterSessionId,
      eventType: "checkpoint",
      sequence: 1,
      responseText: "Later session started",
    });

    const batch = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);

    expect(batch.sessions.map((s) => s.id)).toEqual([firstSessionId]);
    expect(batch.events.map((e) => e.id)).toEqual([
      "01H000000000000000000000010",
    ]);
    expect(batch.events.some((e) => e.event_type === "prompt_submit")).toBe(false);
  });

  it("includes a prompt once the same session has a following assistant response", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId,
      eventType: "checkpoint",
      sequence: 1,
      responseText: "Session started",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000020",
      sessionId,
      eventType: "prompt_submit",
      sequence: 2,
      promptText: "closed turn",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000030",
      sessionId,
      eventType: "assistant_response",
      sequence: 3,
      promptText: "closed turn",
      responseText: "done",
    });

    const batch = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);

    expect(batch.events.map((e) => e.id)).toEqual([
      "01H000000000000000000000010",
      "01H000000000000000000000020",
      "01H000000000000000000000030",
    ]);
  });

  it("treats multiple prompts as closed once the session has a following assistant response", () => {
    const sessionId = "01H000000000000000000000001";
    insertTestSession(db, sessionId);

    insertTestEvent(db, {
      id: "01H000000000000000000000010",
      sessionId,
      eventType: "prompt_submit",
      sequence: 1,
      promptText: "first prompt",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000020",
      sessionId,
      eventType: "prompt_submit",
      sequence: 2,
      promptText: "second prompt",
    });
    insertTestEvent(db, {
      id: "01H000000000000000000000030",
      sessionId,
      eventType: "assistant_response",
      sequence: 3,
      promptText: "second prompt",
      responseText: "done",
    });

    const batch = buildSyncBatch(db, null, null, PROJECT_ID, CLOUD_CLIENT_ID, 500);

    expect(batch.events.map((e) => e.id)).toEqual([
      "01H000000000000000000000010",
      "01H000000000000000000000020",
      "01H000000000000000000000030",
    ]);
  });
});
