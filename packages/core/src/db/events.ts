/**
 * Event CRUD operations.
 *
 * Events are the heart of ADIT's timeline. Every action is recorded
 * as an event with full context.
 */

import type Database from "better-sqlite3";
import type {
  AditEvent,
  EventType,
  Actor,
  EventStatus,
} from "../types/index.js";

export interface InsertEventInput {
  id: string;
  sessionId: string;
  parentEventId?: string | null;
  sequence: number;
  eventType: EventType;
  actor: Actor;
  promptText?: string | null;
  cotText?: string | null;
  responseText?: string | null;
  toolName?: string | null;
  toolInputJson?: string | null;
  toolOutputJson?: string | null;
  checkpointSha?: string | null;
  checkpointRef?: string | null;
  diffStatJson?: string | null;
  gitBranch?: string | null;
  gitHeadSha?: string | null;
  envSnapshotId?: string | null;
  startedAt: string;
  endedAt?: string | null;
  status?: EventStatus;
  errorJson?: string | null;
  labelsJson?: string | null;
  planTaskId?: string | null;
  vclockJson: string;
}

const INSERT_SQL = `
  INSERT INTO events (
    id, session_id, parent_event_id, sequence, event_type, actor,
    prompt_text, cot_text, response_text,
    tool_name, tool_input_json, tool_output_json,
    checkpoint_sha, checkpoint_ref, diff_stat_json,
    git_branch, git_head_sha, env_snapshot_id,
    started_at, ended_at, status, error_json, labels_json, plan_task_id,
    vclock_json
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?
  )
`;

export function insertEvent(
  db: Database.Database,
  input: InsertEventInput,
): void {
  db.prepare(INSERT_SQL).run(
    input.id,
    input.sessionId,
    input.parentEventId ?? null,
    input.sequence,
    input.eventType,
    input.actor,
    input.promptText ?? null,
    input.cotText ?? null,
    input.responseText ?? null,
    input.toolName ?? null,
    input.toolInputJson ?? null,
    input.toolOutputJson ?? null,
    input.checkpointSha ?? null,
    input.checkpointRef ?? null,
    input.diffStatJson ?? null,
    input.gitBranch ?? null,
    input.gitHeadSha ?? null,
    input.envSnapshotId ?? null,
    input.startedAt,
    input.endedAt ?? null,
    input.status ?? "running",
    input.errorJson ?? null,
    input.labelsJson ?? null,
    input.planTaskId ?? null,
    input.vclockJson,
  );
}

export function getEventById(
  db: Database.Database,
  id: string,
): AditEvent | null {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEvent(row) : null;
}

export interface EventQueryOptions {
  sessionId?: string;
  eventType?: EventType;
  actor?: Actor;
  status?: EventStatus;
  hasCheckpoint?: boolean;
  limit?: number;
  afterSequence?: number;
}

export function queryEvents(
  db: Database.Database,
  opts: EventQueryOptions,
): AditEvent[] {
  const conditions: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];

  if (opts.sessionId) {
    conditions.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.eventType) {
    conditions.push("event_type = ?");
    params.push(opts.eventType);
  }
  if (opts.actor) {
    conditions.push("actor = ?");
    params.push(opts.actor);
  }
  if (opts.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.hasCheckpoint) {
    conditions.push("checkpoint_sha IS NOT NULL");
  }
  if (opts.afterSequence !== undefined) {
    conditions.push("sequence > ?");
    params.push(opts.afterSequence);
  }

  const where = conditions.join(" AND ");
  const limit = opts.limit ?? 50;
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT * FROM events WHERE ${where} ORDER BY sequence DESC LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map(rowToEvent);
}

export function getEventsBySession(
  db: Database.Database,
  sessionId: string,
  limit = 100,
): AditEvent[] {
  const rows = db
    .prepare(
      "SELECT * FROM events WHERE session_id = ? AND deleted_at IS NULL ORDER BY sequence ASC LIMIT ?",
    )
    .all(sessionId, limit) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function updateEventStatus(
  db: Database.Database,
  id: string,
  status: EventStatus,
  endedAt?: string,
  errorJson?: string | null,
): void {
  const now = endedAt ?? new Date().toISOString();
  db.prepare(
    "UPDATE events SET status = ?, ended_at = ?, error_json = ? WHERE id = ?",
  ).run(status, now, errorJson ?? null, id);
}

export function updateEventCheckpoint(
  db: Database.Database,
  id: string,
  checkpointSha: string,
  checkpointRef: string,
  diffStatJson: string,
): void {
  db.prepare(
    "UPDATE events SET checkpoint_sha = ?, checkpoint_ref = ?, diff_stat_json = ? WHERE id = ?",
  ).run(checkpointSha, checkpointRef, diffStatJson, id);
}

export function updateEventLabels(
  db: Database.Database,
  id: string,
  labelsJson: string,
  vclockJson: string,
): void {
  db.prepare(
    "UPDATE events SET labels_json = ?, vclock_json = ? WHERE id = ?",
  ).run(labelsJson, vclockJson, id);
}

export function allocateSequence(
  db: Database.Database,
  sessionId: string,
): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) as max_seq FROM events WHERE session_id = ?",
    )
    .get(sessionId) as { max_seq: number };
  return row.max_seq + 1;
}

export function searchEvents(
  db: Database.Database,
  query: string,
  limit = 20,
): AditEvent[] {
  const pattern = `%${query}%`;
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE deleted_at IS NULL
         AND (prompt_text LIKE ? OR cot_text LIKE ? OR response_text LIKE ? OR tool_name LIKE ?)
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, limit) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function getLatestCheckpointEvent(
  db: Database.Database,
  sessionId?: string,
): AditEvent | null {
  let sql =
    "SELECT * FROM events WHERE checkpoint_sha IS NOT NULL AND deleted_at IS NULL";
  const params: unknown[] = [];

  if (sessionId) {
    sql += " AND session_id = ?";
    params.push(sessionId);
  }
  sql += " ORDER BY sequence DESC LIMIT 1";

  const row = db.prepare(sql).get(...params) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEvent(row) : null;
}

/**
 * Delete all events and associated diffs for a project.
 * Respects foreign key order: diffs → events.
 * Returns the number of events deleted.
 */
export function clearEvents(
  db: Database.Database,
  projectId: string,
): number {
  const deleteAll = db.transaction(() => {
    // Delete diffs that belong to events in this project's sessions
    db.prepare(
      `DELETE FROM diffs WHERE event_id IN (
         SELECT e.id FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE s.project_id = ?
       )`,
    ).run(projectId);

    // Delete env_snapshots that belong to this project's sessions
    db.prepare(
      `DELETE FROM env_snapshots WHERE session_id IN (
         SELECT id FROM sessions WHERE project_id = ?
       )`,
    ).run(projectId);

    // Delete events
    const result = db
      .prepare(
        `DELETE FROM events WHERE session_id IN (
           SELECT id FROM sessions WHERE project_id = ?
         )`,
      )
      .run(projectId);

    // Delete sessions
    db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(projectId);

    // Clear sync state (cursors are invalid after clearing events)
    db.prepare(`DELETE FROM sync_state`).run();

    return result.changes;
  });

  return deleteAll();
}

/**
 * Count total events for a project.
 */
export function countEvents(
  db: Database.Database,
  projectId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM events e
       JOIN sessions s ON e.session_id = s.id
       WHERE s.project_id = ?`,
    )
    .get(projectId) as { cnt: number };
  return row.cnt;
}

function rowToEvent(row: Record<string, unknown>): AditEvent {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    parentEventId: (row.parent_event_id as string) ?? null,
    sequence: row.sequence as number,
    eventType: row.event_type as EventType,
    actor: row.actor as Actor,
    promptText: (row.prompt_text as string) ?? null,
    cotText: (row.cot_text as string) ?? null,
    responseText: (row.response_text as string) ?? null,
    toolName: (row.tool_name as string) ?? null,
    toolInputJson: (row.tool_input_json as string) ?? null,
    toolOutputJson: (row.tool_output_json as string) ?? null,
    checkpointSha: (row.checkpoint_sha as string) ?? null,
    checkpointRef: (row.checkpoint_ref as string) ?? null,
    diffStatJson: (row.diff_stat_json as string) ?? null,
    gitBranch: (row.git_branch as string) ?? null,
    gitHeadSha: (row.git_head_sha as string) ?? null,
    envSnapshotId: (row.env_snapshot_id as string) ?? null,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
    status: row.status as EventStatus,
    errorJson: (row.error_json as string) ?? null,
    labelsJson: (row.labels_json as string) ?? null,
    planTaskId: (row.plan_task_id as string) ?? null,
    vclockJson: row.vclock_json as string,
    deletedAt: (row.deleted_at as string) ?? null,
  };
}
