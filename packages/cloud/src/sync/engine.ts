/**
 * Sync engine — orchestrates cursor-based incremental push.
 *
 * Protocol:
 * 1. GET /api/sync/status → retrieve server's cursor
 * 2. Build batch of local records after cursor
 * 3. POST /api/sync/push → push batch
 * 4. Update local cursor from response
 * 5. Repeat until no more records
 */

import type Database from "better-sqlite3";
import { getSyncState, upsertSyncState, withPerf } from "@varveai/adit-core";
import type { SyncState } from "@varveai/adit-core";
import type { CloudClient } from "../http/client.js";
import { buildSyncBatch, batchRecordCount, countUnsyncedRecords } from "./serializer.js";
import { handleConflicts, type SyncConflict } from "./conflicts.js";

export type { SyncConflict } from "./conflicts.js";

export interface SyncResult {
  /** Total records accepted by server */
  accepted: number;
  /** Records already seen by server (de-duplicated) */
  duplicates: number;
  /** Conflicts detected on mutable records */
  conflicts: SyncConflict[];
  /** New sync cursor after all batches */
  newSyncCursor: string | null;
  /** Number of batches pushed */
  batches: number;
  /** Total records sent across all batches */
  totalRecords: number;
}

interface PushResponse {
  accepted: number;
  duplicates: number;
  conflicts: SyncConflict[];
  newSyncCursor: string;
  newSyncVersion: number;
}

/** Per-project cursor entry returned by the server in projectCursors. */
interface ProjectCursor {
  lastSyncedEventId: string | null;
  lastSyncedAt: string | null;
}

/**
 * Response from GET /api/sync/status.
 *
 * The server tracks cursors per (clientId, projectId) pair and returns them
 * in the `projectCursors` map. The top-level `lastSyncedEventId` and
 * `syncVersion` remain for backward compatibility.
 */
interface StatusResponse {
  lastSyncedEventId: string | null;
  syncVersion: number;
  lastSyncedAt: string | null;
  /** Per-project cursor map. Key is projectId. Present on updated servers. */
  projectCursors?: Record<string, ProjectCursor>;
}

export class SyncEngine {
  private readonly db: Database.Database;
  private readonly client: CloudClient;
  private readonly projectId: string;
  private readonly batchSize: number;
  private readonly serverUrl: string;
  private readonly cloudClientId: string;
  private readonly dataDir: string | null;

  constructor(
    db: Database.Database,
    client: CloudClient,
    config: {
      projectId: string;
      batchSize: number;
      serverUrl: string;
      cloudClientId: string;
      dataDir?: string;
    },
  ) {
    this.db = db;
    this.client = client;
    this.projectId = config.projectId;
    this.batchSize = config.batchSize;
    this.serverUrl = config.serverUrl;
    this.cloudClientId = config.cloudClientId;
    this.dataDir = config.dataDir ?? null;
  }

  /**
   * Full incremental sync: push all unsynced records in batches.
   *
   * Fetches the server's cursor, then pushes batches until all
   * local records have been synced.
   */
  async sync(): Promise<SyncResult> {
    const doSync = async (): Promise<SyncResult> => {
      // 1. Get server's current cursor
      const serverStatus = await this.getRemoteStatus();

      // 2. Extract per-project cursor (preferred) or fall back to global cursor.
      //    The server returns projectCursors[projectId] with the watermark
      //    for this specific project. If the server hasn't seen any events
      //    for this project yet, the entry will be absent — meaning send all.
      let cursor: string | null;
      let lastSyncedAt: string | null;
      let syncVersion = serverStatus.syncVersion;

      const projectEntry = serverStatus.projectCursors?.[this.projectId];
      if (projectEntry !== undefined) {
        // Server has a per-project cursor — use it directly.
        cursor = projectEntry.lastSyncedEventId;
        lastSyncedAt = projectEntry.lastSyncedAt;
        if (process.env.ADIT_DEBUG) {
          process.stderr.write(
            `[adit-cloud] sync: using per-project cursor for ${this.projectId}: ${cursor ?? "null"}\n`,
          );
        }
      } else if (serverStatus.projectCursors !== undefined) {
        // Server supports per-project cursors but has no entry for this
        // project — it has never seen events for it. Send everything.
        cursor = null;
        lastSyncedAt = null;
        if (process.env.ADIT_DEBUG) {
          process.stderr.write(
            `[adit-cloud] sync: no per-project cursor for ${this.projectId} — full push\n`,
          );
        }
      } else {
        // Legacy server without projectCursors — fall back to global cursor
        // with the cursor-ahead guard for safety.
        cursor = serverStatus.lastSyncedEventId;
        lastSyncedAt = serverStatus.lastSyncedAt;

        if (cursor) {
          const unsyncedWithCursor = countUnsyncedRecords(
            this.db,
            cursor,
            lastSyncedAt,
            this.projectId,
          );
          const totalLocal = countUnsyncedRecords(
            this.db,
            null,
            null,
            this.projectId,
          );
          if (unsyncedWithCursor === 0 && totalLocal > 0) {
            if (process.env.ADIT_DEBUG) {
              process.stderr.write(
                `[adit-cloud] sync: legacy global cursor ${cursor} is ahead of all ${totalLocal} local records — resetting to full push\n`,
              );
            }
            cursor = null;
          }
        }
      }

      const result: SyncResult = {
        accepted: 0,
        duplicates: 0,
        conflicts: [],
        newSyncCursor: cursor,
        batches: 0,
        totalRecords: 0,
      };

      // 3. Push batches until no more records
      while (true) {
        const batch = buildSyncBatch(
          this.db,
          cursor,
          lastSyncedAt,
          this.projectId,
          this.cloudClientId,
          this.batchSize,
        );

        const count = batchRecordCount(batch);
        if (count === 0) break; // All synced

        const response = await this.client.post<PushResponse>(
          "/api/sync/push",
          {
            clientId: this.cloudClientId,
            syncVersion,
            batch,
          },
        );

        result.accepted += response.accepted;
        result.duplicates += response.duplicates;
        result.conflicts.push(...response.conflicts);
        result.batches++;
        result.totalRecords += count;

        // Handle conflicts
        if (response.conflicts.length > 0) {
          handleConflicts(response.conflicts);
        }

        // Update cursor
        const prevCursor = cursor;
        cursor = response.newSyncCursor;
        syncVersion = response.newSyncVersion;
        result.newSyncCursor = cursor;

        // Guard against infinite loop: if all records were duplicates and
        // the cursor didn't advance, the same batch would repeat forever.
        if (response.accepted === 0 && cursor === prevCursor) {
          if (process.env.ADIT_DEBUG) {
            process.stderr.write(
              `[adit-cloud] sync: all ${count} records were duplicates and cursor unchanged — stopping\n`,
            );
          }
          break;
        }

        // Persist progress after each batch (crash-safe)
        upsertSyncState(this.db, {
          serverUrl: this.serverUrl,
          clientId: this.cloudClientId,
          lastSyncedEventId: cursor,
          lastSyncedAt: new Date().toISOString(),
          syncVersion,
        });

        // If batch was smaller than limit, we're done
        if (count < this.batchSize) break;
      }


      return result;
    };

    if (this.dataDir) {
      return withPerf(this.dataDir, "network", "cloud-sync", doSync);
    }
    return doSync();
  }

  /** Get sync status from server, scoped to this project. */
  async getRemoteStatus(): Promise<StatusResponse> {
    const params = new URLSearchParams({ projectId: this.projectId });
    return this.client.get<StatusResponse>(`/api/sync/status?${params.toString()}`);
  }

  /** Get local sync state */
  getLocalStatus(): SyncState | null {
    return getSyncState(this.db, this.serverUrl);
  }
}
