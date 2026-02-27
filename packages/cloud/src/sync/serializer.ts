/**
 * Data serializer — builds sync batches from local SQLite data.
 *
 * Queries local tables for records not yet synced (after the cursor),
 * converts them to the server's expected format, and respects the
 * batch size limit (max 500 records per push).
 */

import type Database from "better-sqlite3";

/**
 * Server-facing record types.
 * These use snake_case field names matching the adit-cloud PostgreSQL schema.
 */

export interface SyncSession {
  id: string;
  project_id: string;
  client_id: string;
  session_type: string;
  platform: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  metadata_json: string | null;
  vclock_json: string | null;
  deleted_at: string | null;
}

export interface SyncEvent {
  id: string;
  session_id: string;
  client_id: string;
  parent_event_id: string | null;
  sequence: number;
  event_type: string;
  actor: string;
  status: string;
  prompt_text: string | null;
  cot_text: string | null;
  response_text: string | null;
  tool_name: string | null;
  tool_input_json: string | null;
  tool_output_json: string | null;
  checkpoint_sha: string | null;
  checkpoint_ref: string | null;
  diff_stat_json: string | null;
  git_branch: string | null;
  git_head_sha: string | null;
  env_snapshot_id: string | null;
  started_at: string;
  ended_at: string | null;
  error_json: string | null;
  labels_json: string | null;
  plan_task_id: string | null;
  vclock_json: string | null;
  deleted_at: string | null;
}

export interface SyncEnvSnapshot {
  id: string;
  session_id: string;
  client_id: string;
  git_branch: string | null;
  git_head_sha: string | null;
  modified_files: string | null;
  lockfile_hash: string | null;
  lockfile_path: string | null;
  env_vars: string | null;
  node_version: string | null;
  python_version: string | null;
  os_info: string | null;
  container_info: string | null;
  runtime_versions: string | null;
  shell_info: string | null;
  system_resources: string | null;
  package_manager: string | null;
  captured_at: string;
  vclock_json: string | null;
  deleted_at: string | null;
}

export interface SyncPlan {
  id: string;
  project_id: string;
  client_id: string;
  plan_type: string;
  parent_plan_id: string | null;
  title: string;
  content_md: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  vclock_json: string | null;
  deleted_at: string | null;
}

export interface SyncDiff {
  id: string;
  event_id: string;
  client_id: string;
  diff_text: string;
  file_filter: string | null;
  created_at: string;
}

export interface SyncBatch {
  sessions: SyncSession[];
  events: SyncEvent[];
  envSnapshots: SyncEnvSnapshot[];
  plans: SyncPlan[];
  diffs: SyncDiff[];
}

/**
 * Build a sync batch of records after the given cursor.
 *
 * For append-only records (events, env_snapshots, diffs), only selects
 * new records with id > cursor.
 *
 * For mutable records (sessions, plans), also includes records modified
 * since lastSyncedAt so updates are captured.
 *
 * Priority ordering: sessions first (parents), then events, env_snapshots,
 * plans, diffs — maintaining referential integrity on the server.
 */
export function buildSyncBatch(
  db: Database.Database,
  afterEventId: string | null,
  lastSyncedAt: string | null,
  projectId: string,
  cloudClientId: string,
  batchSize: number,
): SyncBatch {
  const batch: SyncBatch = {
    sessions: [],
    events: [],
    envSnapshots: [],
    plans: [],
    diffs: [],
  };

  let remaining = batchSize;

  // 1. Sessions — new or modified since last sync
  if (remaining > 0) {
    batch.sessions = querySessions(
      db,
      afterEventId,
      lastSyncedAt,
      projectId,
      cloudClientId,
      remaining,
    );
    remaining -= batch.sessions.length;
  }

  // 2. Events — append-only, only new records
  if (remaining > 0) {
    batch.events = queryEvents(
      db,
      afterEventId,
      projectId,
      cloudClientId,
      remaining,
    );
    remaining -= batch.events.length;
  }

  // 3. Env snapshots — append-only, filtered by project
  if (remaining > 0) {
    batch.envSnapshots = queryEnvSnapshots(
      db,
      afterEventId,
      projectId,
      cloudClientId,
      remaining,
    );
    remaining -= batch.envSnapshots.length;
  }

  // 4. Plans — mutable, include modified
  if (remaining > 0) {
    batch.plans = queryPlans(
      db,
      afterEventId,
      lastSyncedAt,
      projectId,
      cloudClientId,
      remaining,
    );
    remaining -= batch.plans.length;
  }

  // 5. Diffs — keyed by event_id, only for events in this batch
  if (batch.events.length > 0 && remaining > 0) {
    const eventIds = batch.events.map((e) => e.id);
    batch.diffs = queryDiffs(db, eventIds, cloudClientId, remaining);
  }

  return batch;
}

/** Count total unsynced records across all tables */
export function countUnsyncedRecords(
  db: Database.Database,
  afterEventId: string | null,
  lastSyncedAt: string | null,
  projectId: string,
): number {
  let total = 0;

  // Events
  if (afterEventId) {
    const eventRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE e.id > ? AND s.project_id = ?`,
      )
      .get(afterEventId, projectId) as { cnt: number };
    total += eventRow.cnt;
  } else {
    const eventRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE s.project_id = ?`,
      )
      .get(projectId) as { cnt: number };
    total += eventRow.cnt;
  }

  // Sessions (new or modified)
  if (afterEventId) {
    const params: unknown[] = [projectId];
    let sql = `SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ? AND (id > ?`;
    params.push(afterEventId);
    if (lastSyncedAt) {
      sql += ` OR ended_at > ?`;
      params.push(lastSyncedAt);
    }
    sql += `)`;
    const row = db.prepare(sql).get(...params) as { cnt: number };
    total += row.cnt;
  } else {
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM sessions WHERE project_id = ?`,
      )
      .get(projectId) as { cnt: number };
    total += row.cnt;
  }

  return total;
}

/** Get total record count in a batch */
export function batchRecordCount(batch: SyncBatch): number {
  return (
    batch.sessions.length +
    batch.events.length +
    batch.envSnapshots.length +
    batch.plans.length +
    batch.diffs.length
  );
}

// --- Internal query helpers ---

function querySessions(
  db: Database.Database,
  afterId: string | null,
  lastSyncedAt: string | null,
  projectId: string,
  cloudClientId: string,
  limit: number,
): SyncSession[] {
  let sql: string;
  const params: unknown[] = [];

  if (afterId) {
    const conditions = ["project_id = ?", "(id > ?"];
    params.push(projectId, afterId);
    if (lastSyncedAt) {
      conditions[1] += " OR ended_at > ?";
      params.push(lastSyncedAt);
    }
    conditions[1] += ")";
    sql = `SELECT * FROM sessions WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ?`;
  } else {
    sql = `SELECT * FROM sessions WHERE project_id = ? ORDER BY id ASC LIMIT ?`;
    params.push(projectId);
  }
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    client_id: cloudClientId,
    session_type: r.session_type as string,
    platform: r.platform as string,
    started_at: r.started_at as string,
    ended_at: (r.ended_at as string) ?? null,
    status: r.status as string,
    metadata_json: (r.metadata_json as string) ?? null,
    vclock_json: (r.vclock_json as string) ?? null,
    deleted_at: (r.deleted_at as string) ?? null,
  }));
}

function queryEvents(
  db: Database.Database,
  afterId: string | null,
  projectId: string,
  cloudClientId: string,
  limit: number,
): SyncEvent[] {
  let sql: string;
  const params: unknown[] = [];

  if (afterId) {
    sql = `SELECT e.* FROM events e
           JOIN sessions s ON e.session_id = s.id
           WHERE e.id > ? AND s.project_id = ?
           ORDER BY e.id ASC LIMIT ?`;
    params.push(afterId, projectId, limit);
  } else {
    sql = `SELECT e.* FROM events e
           JOIN sessions s ON e.session_id = s.id
           WHERE s.project_id = ?
           ORDER BY e.id ASC LIMIT ?`;
    params.push(projectId, limit);
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    session_id: r.session_id as string,
    client_id: cloudClientId,
    parent_event_id: (r.parent_event_id as string) ?? null,
    sequence: r.sequence as number,
    event_type: r.event_type as string,
    actor: r.actor as string,
    status: r.status as string,
    prompt_text: (r.prompt_text as string) ?? null,
    cot_text: (r.cot_text as string) ?? null,
    response_text: (r.response_text as string) ?? null,
    tool_name: (r.tool_name as string) ?? null,
    tool_input_json: (r.tool_input_json as string) ?? null,
    tool_output_json: (r.tool_output_json as string) ?? null,
    checkpoint_sha: (r.checkpoint_sha as string) ?? null,
    checkpoint_ref: (r.checkpoint_ref as string) ?? null,
    diff_stat_json: (r.diff_stat_json as string) ?? null,
    git_branch: (r.git_branch as string) ?? null,
    git_head_sha: (r.git_head_sha as string) ?? null,
    env_snapshot_id: (r.env_snapshot_id as string) ?? null,
    started_at: r.started_at as string,
    ended_at: (r.ended_at as string) ?? null,
    error_json: (r.error_json as string) ?? null,
    labels_json: (r.labels_json as string) ?? null,
    plan_task_id: (r.plan_task_id as string) ?? null,
    vclock_json: (r.vclock_json as string) ?? null,
    deleted_at: (r.deleted_at as string) ?? null,
  }));
}

function queryEnvSnapshots(
  db: Database.Database,
  afterId: string | null,
  projectId: string,
  cloudClientId: string,
  limit: number,
): SyncEnvSnapshot[] {
  let sql: string;
  const params: unknown[] = [];

  // Join on sessions to filter by project_id (prevents cross-project leaks)
  if (afterId) {
    sql = `SELECT es.* FROM env_snapshots es
           JOIN sessions s ON es.session_id = s.id
           WHERE es.id > ? AND s.project_id = ?
           ORDER BY es.id ASC LIMIT ?`;
    params.push(afterId, projectId, limit);
  } else {
    sql = `SELECT es.* FROM env_snapshots es
           JOIN sessions s ON es.session_id = s.id
           WHERE s.project_id = ?
           ORDER BY es.id ASC LIMIT ?`;
    params.push(projectId, limit);
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    session_id: r.session_id as string,
    client_id: cloudClientId,
    git_branch: (r.git_branch as string) ?? null,
    git_head_sha: (r.git_head_sha as string) ?? null,
    modified_files: (r.modified_files as string) ?? null,
    lockfile_hash: (r.dep_lock_hash as string) ?? null,
    lockfile_path: (r.dep_lock_path as string) ?? null,
    env_vars: (r.env_vars_json as string) ?? null,
    node_version: (r.node_version as string) ?? null,
    python_version: (r.python_version as string) ?? null,
    os_info: (r.os_info as string) ?? null,
    container_info: (r.container_info as string) ?? null,
    runtime_versions: (r.runtime_versions_json as string) ?? null,
    shell_info: (r.shell_info as string) ?? null,
    system_resources: (r.system_resources_json as string) ?? null,
    package_manager: (r.package_manager_json as string) ?? null,
    captured_at: r.captured_at as string,
    vclock_json: (r.vclock_json as string) ?? null,
    deleted_at: (r.deleted_at as string) ?? null,
  }));
}

function queryPlans(
  db: Database.Database,
  afterId: string | null,
  lastSyncedAt: string | null,
  projectId: string,
  cloudClientId: string,
  limit: number,
): SyncPlan[] {
  let sql: string;
  const params: unknown[] = [];

  if (afterId) {
    const conditions = ["project_id = ?", "(id > ?"];
    params.push(projectId, afterId);
    if (lastSyncedAt) {
      conditions[1] += " OR updated_at > ?";
      params.push(lastSyncedAt);
    }
    conditions[1] += ")";
    sql = `SELECT * FROM plans WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ?`;
  } else {
    sql = `SELECT * FROM plans WHERE project_id = ? ORDER BY id ASC LIMIT ?`;
    params.push(projectId);
  }
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    client_id: cloudClientId,
    plan_type: r.plan_type as string,
    parent_plan_id: (r.parent_plan_id as string) ?? null,
    title: r.title as string,
    content_md: r.content_md as string,
    status: r.status as string,
    created_at: r.created_at as string,
    updated_at: (r.updated_at as string) ?? null,
    vclock_json: (r.vclock_json as string) ?? null,
    deleted_at: (r.deleted_at as string) ?? null,
  }));
}

function queryDiffs(
  db: Database.Database,
  eventIds: string[],
  cloudClientId: string,
  limit: number,
): SyncDiff[] {
  if (eventIds.length === 0) return [];

  const placeholders = eventIds.map(() => "?").join(",");
  const sql = `SELECT * FROM diffs WHERE event_id IN (${placeholders}) LIMIT ?`;

  const rows = db
    .prepare(sql)
    .all(...eventIds, limit) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    event_id: r.event_id as string,
    client_id: cloudClientId,
    diff_text: r.diff_text as string,
    file_filter: (r.file_filter as string) ?? null,
    created_at: r.created_at as string,
  }));
}
