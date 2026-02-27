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
  /** Hours since last successful sync before auto-sync triggers regardless of count (default: 12) */
  syncTimeoutHours: number;
  /** Transcript upload configuration */
  transcriptUpload: TranscriptUploadConfig;
}

export interface TranscriptUploadConfig {
  /** Whether transcript upload is enabled (default: true) */
  enabled: boolean;
  /** Interval in seconds between upload checks (default: 30) */
  pollIntervalSec: number;
  /** Max concurrent uploads (default: 2) */
  maxConcurrent: number;
  /** Max consecutive failures per file before giving up (default: 3) */
  maxRetries: number;
  /** Minimum bytes of new data before uploading an increment (default: 1024) */
  minIncrementBytes: number;
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
    syncTimeoutHours: parseSyncTimeoutHours(
      process.env.ADIT_CLOUD_SYNC_TIMEOUT_HOURS,
    ),
    transcriptUpload: loadTranscriptUploadConfig(),
  };
}

function loadTranscriptUploadConfig(): TranscriptUploadConfig {
  return {
    enabled: process.env.ADIT_TRANSCRIPT_UPLOAD !== "false",
    pollIntervalSec: parsePositiveInt(
      process.env.ADIT_TRANSCRIPT_POLL_INTERVAL,
      30,
    ),
    maxConcurrent: parsePositiveInt(
      process.env.ADIT_TRANSCRIPT_MAX_CONCURRENT,
      2,
    ),
    maxRetries: parsePositiveInt(
      process.env.ADIT_TRANSCRIPT_MAX_RETRIES,
      3,
    ),
    minIncrementBytes: parsePositiveInt(
      process.env.ADIT_TRANSCRIPT_MIN_INCREMENT,
      1024,
    ),
  };
}

function parseSyncTimeoutHours(raw: string | undefined): number {
  const DEFAULT = 12;
  if (raw === undefined) return DEFAULT;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT;
  return parsed;
}

function parseSyncThreshold(raw: string | undefined): number {
  const DEFAULT = 50;
  if (raw === undefined) return DEFAULT;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT;
  return Math.max(parsed, 1);
}

function parsePositiveInt(raw: string | undefined, defaultVal: number): number {
  if (raw === undefined) return defaultVal;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return defaultVal;
  return parsed;
}
