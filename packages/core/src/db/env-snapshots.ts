/**
 * Environment snapshot CRUD operations.
 */

import type Database from "better-sqlite3";
import type { EnvSnapshot } from "../types/index.js";

export interface CreateEnvSnapshotInput {
  id: string;
  sessionId: string;
  gitBranch: string;
  gitHeadSha: string;
  modifiedFiles?: string | null;
  depLockHash?: string | null;
  depLockPath?: string | null;
  envVarsJson?: string | null;
  nodeVersion?: string | null;
  pythonVersion?: string | null;
  osInfo?: string | null;
  vclockJson: string;
}

export function insertEnvSnapshot(
  db: Database.Database,
  input: CreateEnvSnapshotInput,
): void {
  db.prepare(`
    INSERT INTO env_snapshots (
      id, session_id, git_branch, git_head_sha,
      modified_files, dep_lock_hash, dep_lock_path,
      env_vars_json, node_version, python_version, os_info,
      captured_at, vclock_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    input.id,
    input.sessionId,
    input.gitBranch,
    input.gitHeadSha,
    input.modifiedFiles ?? null,
    input.depLockHash ?? null,
    input.depLockPath ?? null,
    input.envVarsJson ?? null,
    input.nodeVersion ?? null,
    input.pythonVersion ?? null,
    input.osInfo ?? null,
    input.vclockJson,
  );
}

export function getEnvSnapshotById(
  db: Database.Database,
  id: string,
): EnvSnapshot | null {
  const row = db
    .prepare("SELECT * FROM env_snapshots WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToEnvSnapshot(row) : null;
}

export function getLatestEnvSnapshot(
  db: Database.Database,
  sessionId: string,
): EnvSnapshot | null {
  const row = db
    .prepare(
      "SELECT * FROM env_snapshots WHERE session_id = ? AND deleted_at IS NULL ORDER BY captured_at DESC LIMIT 1",
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  return row ? rowToEnvSnapshot(row) : null;
}

function rowToEnvSnapshot(row: Record<string, unknown>): EnvSnapshot {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    gitBranch: row.git_branch as string,
    gitHeadSha: row.git_head_sha as string,
    modifiedFiles: (row.modified_files as string) ?? null,
    depLockHash: (row.dep_lock_hash as string) ?? null,
    depLockPath: (row.dep_lock_path as string) ?? null,
    envVarsJson: (row.env_vars_json as string) ?? null,
    nodeVersion: (row.node_version as string) ?? null,
    pythonVersion: (row.python_version as string) ?? null,
    osInfo: (row.os_info as string) ?? null,
    capturedAt: row.captured_at as string,
    vclockJson: row.vclock_json as string,
    deletedAt: (row.deleted_at as string) ?? null,
  };
}
