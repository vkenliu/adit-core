/**
 * Auto-sync trigger — fire-and-forget sync after hook events.
 *
 * Called from the hooks system via dynamic import. Fully fail-open:
 * any error is swallowed so it never blocks the AI agent.
 *
 * Sync is only triggered when the number of unsynced records meets
 * the configured threshold (ADIT_CLOUD_SYNC_THRESHOLD, default 50).
 * This avoids excessive HTTP calls for every single event while
 * ensuring data reaches the cloud regularly.
 *
 * Failed syncs are not retried immediately — they will be picked up
 * on the next trigger when the threshold is still met.
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
 * Trigger a background sync if auto-sync is enabled, credentials exist,
 * the server is reachable, and the unsynced record count meets the threshold.
 *
 * This function is designed to be called as fire-and-forget:
 *   triggerAutoSync(db, projectId).catch(() => {})
 *
 * Precondition checks (in order):
 * 1. Cloud URL configured and auto-sync enabled
 * 2. Valid credentials present (client is authenticated)
 * 3. Credentials belong to the configured server (single-server binding)
 * 4. Unsynced record count >= syncThreshold
 * 5. Server is reachable (tested via sync status endpoint)
 *
 * If any check fails, the function returns silently. Failed events
 * remain unsynced and will be retried on the next trigger.
 */
export async function triggerAutoSync(
  db: Database.Database,
  projectId: string,
): Promise<void> {
  const cloudConfig = loadCloudConfig();

  // 1. Check cloud is configured and auto-sync is enabled
  if (!cloudConfig.serverUrl || !cloudConfig.enabled || !cloudConfig.autoSync) {
    return;
  }

  // 2. Check credentials exist
  const credentials = loadCredentials();
  if (!credentials) return;

  // 3. Verify credentials belong to the configured server
  if (credentials.serverUrl !== cloudConfig.serverUrl) {
    return;
  }

  // 4. Check unsynced record count against threshold
  const syncState = getSyncState(db, cloudConfig.serverUrl);
  const unsyncedCount = countUnsyncedRecords(
    db,
    syncState?.lastSyncedEventId ?? null,
    syncState?.lastSyncedAt ?? null,
    projectId,
  );

  if (unsyncedCount < cloudConfig.syncThreshold) {
    return;
  }

  // 5. Attempt sync — CloudClient handles token refresh, retries,
  //    and reachability internally. Network errors are caught below.
  if (isTokenExpired(credentials)) {
    // Let CloudClient try to refresh — it will throw CloudAuthError if it can't
  }

  try {
    const client = new CloudClient(cloudConfig.serverUrl, credentials);
    const engine = new SyncEngine(db, client, {
      projectId,
      batchSize: cloudConfig.batchSize,
      serverUrl: cloudConfig.serverUrl,
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
