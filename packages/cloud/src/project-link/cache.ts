/**
 * Local SQLite cache for project link state.
 *
 * Tracks the server-confirmed project ID, last-synced commit SHA,
 * document content hashes, and qualification status. Stored in the
 * existing adit database ($projectRoot/.adit/adit.sqlite).
 */

import type Database from "better-sqlite3";
import type { ProjectLinkCache } from "./types.js";

/** Row shape from the project_link_cache table */
interface CacheRow {
  project_id: string;
  server_url: string;
  confirmed_project_id: string | null;
  last_commit_sha: string | null;
  last_branch_sync_at: string | null;
  last_doc_sync_at: string | null;
  doc_hashes_json: string;
  qualified: number;
  initialized_at: string;
  updated_at: string;
}

/** Get cached state for a project link */
export function getProjectLinkCache(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
): ProjectLinkCache | null {
  const row = db
    .prepare("SELECT * FROM project_link_cache WHERE project_id = ? AND server_url = ?")
    .get(projectId, serverUrl) as CacheRow | undefined;

  if (!row) return null;

  let docHashes: Record<string, string> = {};
  try {
    docHashes = JSON.parse(row.doc_hashes_json) as Record<string, string>;
  } catch {
    // Corrupted JSON — treat as empty (documents will be re-uploaded)
  }

  return {
    projectId: row.project_id,
    serverUrl: row.server_url,
    confirmedProjectId: row.confirmed_project_id,
    lastCommitSha: row.last_commit_sha,
    lastBranchSyncAt: row.last_branch_sync_at,
    lastDocSyncAt: row.last_doc_sync_at,
    docHashes,
    qualified: row.qualified === 1,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

/** Create or update project link cache */
export function upsertProjectLinkCache(
  db: Database.Database,
  cache: ProjectLinkCache,
): void {
  db.prepare(`
    INSERT INTO project_link_cache (
      project_id, server_url, confirmed_project_id,
      last_commit_sha, last_branch_sync_at, last_doc_sync_at,
      doc_hashes_json, qualified, initialized_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, server_url) DO UPDATE SET
      confirmed_project_id = excluded.confirmed_project_id,
      last_commit_sha = excluded.last_commit_sha,
      last_branch_sync_at = excluded.last_branch_sync_at,
      last_doc_sync_at = excluded.last_doc_sync_at,
      doc_hashes_json = excluded.doc_hashes_json,
      qualified = excluded.qualified,
      updated_at = excluded.updated_at
  `).run(
    cache.projectId,
    cache.serverUrl,
    cache.confirmedProjectId,
    cache.lastCommitSha,
    cache.lastBranchSyncAt,
    cache.lastDocSyncAt,
    JSON.stringify(cache.docHashes),
    cache.qualified ? 1 : 0,
    cache.initializedAt,
    cache.updatedAt,
  );
}

/** Clear cache for a project link (used by --force) */
export function clearProjectLinkCache(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
): void {
  db.prepare("DELETE FROM project_link_cache WHERE project_id = ? AND server_url = ?")
    .run(projectId, serverUrl);
}

/** Update the last-synced commit SHA after upload */
export function updateCachedCommitSha(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  sha: string,
): void {
  db.prepare(`
    UPDATE project_link_cache
    SET last_commit_sha = ?, updated_at = ?
    WHERE project_id = ? AND server_url = ?
  `).run(sha, new Date().toISOString(), projectId, serverUrl);
}

/** Update cached document hashes after upload */
export function updateCachedDocHashes(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  hashes: Record<string, string>,
): void {
  db.prepare(`
    UPDATE project_link_cache
    SET doc_hashes_json = ?, last_doc_sync_at = ?, updated_at = ?
    WHERE project_id = ? AND server_url = ?
  `).run(
    JSON.stringify(hashes),
    new Date().toISOString(),
    new Date().toISOString(),
    projectId,
    serverUrl,
  );
}

/** Mark as qualified or not */
export function updateCachedQualified(
  db: Database.Database,
  projectId: string,
  serverUrl: string,
  qualified: boolean,
): void {
  db.prepare(`
    UPDATE project_link_cache
    SET qualified = ?, updated_at = ?
    WHERE project_id = ? AND server_url = ?
  `).run(qualified ? 1 : 0, new Date().toISOString(), projectId, serverUrl);
}
