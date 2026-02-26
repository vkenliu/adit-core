/**
 * Sync state tracking — per-server sync cursor and version.
 *
 * Tracks the last-synced position so incremental push only
 * sends records the server hasn't seen yet.
 */

import type Database from "better-sqlite3";

export interface SyncState {
  serverUrl: string;
  clientId: string;
  lastSyncedEventId: string | null;
  lastSyncedAt: string | null;
  syncVersion: number;
}

/** Get sync state for a specific server */
export function getSyncState(
  db: Database.Database,
  serverUrl: string,
): SyncState | null {
  const row = db
    .prepare("SELECT * FROM sync_state WHERE server_url = ?")
    .get(serverUrl) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    serverUrl: row.server_url as string,
    clientId: row.client_id as string,
    lastSyncedEventId: (row.last_synced_event_id as string) ?? null,
    lastSyncedAt: (row.last_synced_at as string) ?? null,
    syncVersion: row.sync_version as number,
  };
}

/** Insert or update sync state */
export function upsertSyncState(
  db: Database.Database,
  state: SyncState,
): void {
  db.prepare(
    `INSERT INTO sync_state (server_url, client_id, last_synced_event_id, last_synced_at, sync_version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (server_url) DO UPDATE SET
       client_id = excluded.client_id,
       last_synced_event_id = excluded.last_synced_event_id,
       last_synced_at = excluded.last_synced_at,
       sync_version = excluded.sync_version`,
  ).run(
    state.serverUrl,
    state.clientId,
    state.lastSyncedEventId,
    state.lastSyncedAt,
    state.syncVersion,
  );
}

/** Remove sync state for a server (on logout) */
export function clearSyncState(
  db: Database.Database,
  serverUrl: string,
): void {
  db.prepare("DELETE FROM sync_state WHERE server_url = ?").run(serverUrl);
}
