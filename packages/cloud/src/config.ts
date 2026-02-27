/**
 * Cloud sync configuration.
 *
 * Loaded from environment variables with sensible defaults.
 * Cloud sync is entirely optional — when serverUrl is null,
 * all cloud features are disabled.
 */

export interface CloudConfig {
  /** Cloud server URL (e.g., "https://cloud.adit.dev") */
  serverUrl: string | null;
  /** Whether cloud sync is enabled */
  enabled: boolean;
  /** Auto-sync after hook events (fire-and-forget) */
  autoSync: boolean;
  /** Max records per sync batch (server limit: 500) */
  batchSize: number;
  /** Minimum unsynced events before auto-sync triggers (default: 50) */
  syncThreshold: number;
}

/** Load cloud configuration from environment variables */
export function loadCloudConfig(): CloudConfig {
  const serverUrl = process.env.ADIT_CLOUD_URL ?? null;
  const enabled =
    process.env.ADIT_CLOUD_ENABLED !== undefined
      ? process.env.ADIT_CLOUD_ENABLED !== "false"
      : serverUrl !== null;

  return {
    serverUrl,
    enabled,
    autoSync: process.env.ADIT_CLOUD_AUTO_SYNC === "true",
    batchSize: Math.min(
      parseInt(process.env.ADIT_CLOUD_BATCH_SIZE ?? "500", 10) || 500,
      500, // Server hard limit
    ),
    syncThreshold: parseSyncThreshold(
      process.env.ADIT_CLOUD_SYNC_THRESHOLD,
    ),
  };
}

function parseSyncThreshold(raw: string | undefined): number {
  const DEFAULT = 50;
  if (raw === undefined) return DEFAULT;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT;
  return Math.max(parsed, 1);
}
