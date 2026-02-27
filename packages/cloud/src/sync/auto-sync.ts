/**
 * Auto-sync trigger — fire-and-forget sync after hook events.
 *
 * Called from the hooks system via dynamic import. Fully fail-open:
 * any error is swallowed so it never blocks the AI agent.
 *
 * Sync is triggered when either:
 * - The number of unsynced records meets the configured threshold
 *   (ADIT_CLOUD_SYNC_THRESHOLD, default 50), OR
 * - More than syncTimeoutHours (default 12h) have elapsed since
 *   the last successful sync (ADIT_CLOUD_SYNC_TIMEOUT_HOURS).
 *
 * The time-based trigger is checked first using the already-loaded
 * sync_state row (single PK lookup), skipping the more expensive
 * multi-table COUNT queries when the timeout has elapsed.
 *
 * Failed syncs are not retried immediately — they will be picked up
 * on the next trigger when conditions are still met.
 */

import type Database from "better-sqlite3";
import { getSyncState } from "@adit/core";
import { loadCloudConfig } from "../config.js";
import { loadCredentials, isTokenExpired } from "../auth/credentials.js";
import { CloudClient } from "../http/client.js";
import { CloudNetworkError, CloudAuthError } from "../http/errors.js";
import { SyncEngine } from "./engine.js";
import { countUnsyncedRecords } from "./serializer.js";

/**
 * Trigger a background sync if credentials exist and the unsynced record
 * count meets the threshold (or the time trigger fires).
 *
 * This function is designed to be called as fire-and-forget:
 *   triggerAutoSync(db, projectId).catch(() => {})
 *
 * Precondition checks (in order):
 * 1. Valid credentials present (client is authenticated)
 * 2. Resolve server URL: env var takes priority, falls back to credentials
 * 3. Auto-sync not explicitly disabled (ADIT_CLOUD_AUTO_SYNC !== "false")
 * 4. Time-based trigger: >syncTimeoutHours since last sync (skips count)
 * 5. Count-based trigger: unsynced record count >= syncThreshold
 *
 * If any check fails, the function returns silently. Failed events
 * remain unsynced and will be retried on the next trigger.
 */
export async function triggerAutoSync(
  db: Database.Database,
  projectId: string,
): Promise<void> {
  const cloudConfig = loadCloudConfig();

  // 1. Check credentials exist — credentials are the implicit opt-in
  const credentials = loadCredentials();
  if (!credentials) return;

  // 2. Resolve server URL: env var takes priority, fall back to credentials
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl;
  if (!serverUrl) return;

  // 2a. If env var specifies a different server than credentials, skip
  //     (single-server binding: don't send credentials to wrong server)
  if (cloudConfig.serverUrl && credentials.serverUrl !== cloudConfig.serverUrl) {
    return;
  }

  // 3. Auto-sync is enabled by default when credentials exist.
  //    Only skip if explicitly disabled via ADIT_CLOUD_AUTO_SYNC=false
  //    or ADIT_CLOUD_ENABLED=false.
  if (process.env.ADIT_CLOUD_AUTO_SYNC === "false") return;
  if (process.env.ADIT_CLOUD_ENABLED === "false") return;

  // 4. Check sync triggers: time-based first (cheap), then count-based (expensive)
  const syncState = getSyncState(db, serverUrl);

  // 4a. Time-based trigger: if more than syncTimeoutHours since last successful sync,
  //     skip the expensive multi-table COUNT and trigger sync directly.
  //     Only applies when we have a previous sync timestamp (first sync uses count-based).
  const timeoutMs = cloudConfig.syncTimeoutHours * 60 * 60 * 1000;
  const timeTriggered =
    syncState?.lastSyncedAt != null &&
    Date.now() - new Date(syncState.lastSyncedAt).getTime() > timeoutMs;

  // 4b. Count-based trigger: only run the expensive count if time didn't trigger
  if (!timeTriggered) {
    const unsyncedCount = countUnsyncedRecords(
      db,
      syncState?.lastSyncedEventId ?? null,
      syncState?.lastSyncedAt ?? null,
      projectId,
    );

    if (unsyncedCount < cloudConfig.syncThreshold) {
      return;
    }
  }

  // 5. Attempt sync — CloudClient handles token refresh, retries,
  //    and reachability internally. Network errors are caught below.
  if (isTokenExpired(credentials)) {
    // Let CloudClient try to refresh — it will throw CloudAuthError if it can't
  }

  try {
    const client = new CloudClient(serverUrl, credentials);
    const engine = new SyncEngine(db, client, {
      projectId,
      batchSize: cloudConfig.batchSize,
      serverUrl,
      cloudClientId: credentials.clientId,
    });

    await engine.sync();
  } catch (error) {
    // Fail silently — this is fire-and-forget.
    // CloudNetworkError: server unreachable, will retry next trigger
    // CloudAuthError: credentials invalid, user needs to re-login
    // Any other error: unexpected, but still fail-open
    if (process.env.ADIT_DEBUG) {
      const msg =
        error instanceof CloudNetworkError
          ? `[adit-cloud] auto-sync skipped: server unreachable — ${error.message}`
          : error instanceof CloudAuthError
            ? `[adit-cloud] auto-sync skipped: auth failed — ${error.message}`
            : `[adit-cloud] auto-sync failed: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(msg + "\n");
    }
  }
}
