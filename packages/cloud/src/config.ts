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
  };
}
