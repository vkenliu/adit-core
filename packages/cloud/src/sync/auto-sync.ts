/**
 * Auto-sync trigger — fire-and-forget sync after hook events.
 *
 * Called from the hooks system via dynamic import. Fully fail-open:
 * any error is swallowed so it never blocks the AI agent.
 */

import type Database from "better-sqlite3";
import { loadCloudConfig } from "../config.js";
import { loadCredentials, isTokenExpired } from "../auth/credentials.js";
import { CloudClient } from "../http/client.js";
import { SyncEngine } from "./engine.js";

/**
 * Trigger a background sync if auto-sync is enabled and credentials exist.
 *
 * This function is designed to be called as fire-and-forget:
 *   triggerAutoSync(db, projectId).catch(() => {})
 *
 * It checks all preconditions before attempting sync:
 * - Cloud URL configured
 * - Auto-sync enabled
 * - Valid credentials present
 */
export async function triggerAutoSync(
  db: Database.Database,
  projectId: string,
): Promise<void> {
  const cloudConfig = loadCloudConfig();

  // Precondition checks
  if (!cloudConfig.serverUrl || !cloudConfig.enabled || !cloudConfig.autoSync) {
    return;
  }

  const credentials = loadCredentials();
  if (!credentials) return;

  // Skip if token is expired and we can't auto-refresh
  // (CloudClient handles refresh, but if refresh token is also expired, bail)
  if (isTokenExpired(credentials)) {
    // Let CloudClient try to refresh — it will handle the error
  }

  const client = new CloudClient(cloudConfig.serverUrl, credentials);
  const engine = new SyncEngine(db, client, {
    projectId,
    batchSize: cloudConfig.batchSize,
    serverUrl: cloudConfig.serverUrl,
    cloudClientId: credentials.clientId,
  });

  await engine.sync();
}
