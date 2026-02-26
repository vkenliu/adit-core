/**
 * Session CRUD operations.
 */

import type Database from "better-sqlite3";
import type { AditSession, SessionStatus, Platform, SessionType } from "../types/index.js";

export interface CreateSessionInput {
  id: string;
  projectId: string;
  clientId: string;
  sessionType: SessionType;
  platform: Platform;
  startedAt: string;
  metadataJson?: string | null;
  vclockJson: string;
}

export function insertSession(
  db: Database.Database,
  input: CreateSessionInput,
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, client_id, session_type, platform, started_at, metadata_json, vclock_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId,
    input.clientId,
    input.sessionType,
    input.platform,
    input.startedAt,
    input.metadataJson ?? null,
    input.vclockJson,
  );
}

export function getSessionById(
  db: Database.Database,
  id: string,
): AditSession | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSession(row) : null;
}

export function getActiveSession(
  db: Database.Database,
  projectId: string,
  clientId: string,
): AditSession | null {
  const row = db
    .prepare(
      "SELECT * FROM sessions WHERE project_id = ? AND client_id = ? AND status = 'active' AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(projectId, clientId) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function endSession(
  db: Database.Database,
  id: string,
  status: SessionStatus = "completed",
  vclockJson?: string,
): void {
  const now = new Date().toISOString();
  if (vclockJson) {
    db.prepare(
      "UPDATE sessions SET ended_at = ?, status = ?, vclock_json = ? WHERE id = ?",
    ).run(now, status, vclockJson, id);
  } else {
    db.prepare(
      "UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?",
    ).run(now, status, id);
  }
}

export function listSessions(
  db: Database.Database,
  projectId: string,
  limit = 20,
): AditSession[] {
  const rows = db
    .prepare(
      "SELECT * FROM sessions WHERE project_id = ? AND deleted_at IS NULL ORDER BY started_at DESC LIMIT ?",
    )
    .all(projectId, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

function rowToSession(row: Record<string, unknown>): AditSession {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    clientId: row.client_id as string,
    sessionType: row.session_type as SessionType,
    platform: row.platform as Platform,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
    status: row.status as SessionStatus,
    metadataJson: (row.metadata_json as string) ?? null,
    vclockJson: row.vclock_json as string,
    deletedAt: (row.deleted_at as string) ?? null,
  };
}
