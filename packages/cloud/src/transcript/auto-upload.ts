/**
 * Auto-upload trigger — fire-and-forget transcript upload after hook events.
 *
 * Called from the hooks system via dynamic import. Fully fail-open:
 * any error is swallowed so it never blocks the AI agent.
 *
 * Designed to be called on every hook event. Internally deduplicates
 * by checking if there's actually new data to upload before doing work.
 */

import type Database from "better-sqlite3";
import { loadCloudConfig } from "../config.js";
import { loadCredentials, isTokenExpired } from "../auth/credentials.js";
import { CloudClient } from "../http/client.js";
import { CloudNetworkError, CloudAuthError } from "../http/errors.js";
import { registerTranscript, processTranscriptUploads } from "./manager.js";
import type { SyncUploadType } from "./uploader.js";

/**
 * Register a transcript and trigger pending uploads.
 *
 * Call this from hook handlers whenever a transcript_path is seen.
 * The function is idempotent — calling it multiple times with the
 * same path is safe and cheap.
 *
 * @param db - Open database connection
 * @param sessionId - Current session ID
 * @param transcriptPath - Absolute path to the transcript JSONL file
 * @param cli - CLI identifier (e.g. "claude-code", "cursor", "windsurf")
 * @param type - Upload type (default: "transcript")
 */
export async function triggerTranscriptUpload(
  db: Database.Database,
  sessionId: string,
  transcriptPath: string,
  cli: string = "claude-code",
  type: SyncUploadType = "transcript",
): Promise<void> {
  const cloudConfig = loadCloudConfig();

  // 1. Check transcript upload is enabled
  if (
    !cloudConfig.serverUrl ||
    !cloudConfig.enabled ||
    !cloudConfig.transcriptUpload.enabled
  ) {
    return;
  }

  // 2. Check credentials exist
  const credentials = loadCredentials();
  if (!credentials) return;

  // 3. Verify credentials belong to the configured server
  if (credentials.serverUrl !== cloudConfig.serverUrl) return;

  // 4. Register the transcript (idempotent)
  registerTranscript(
    db,
    sessionId,
    transcriptPath,
    cloudConfig.serverUrl,
  );

  // 5. Process any pending uploads
  if (isTokenExpired(credentials)) {
    // Let CloudClient try to refresh
  }

  try {
    const client = new CloudClient(cloudConfig.serverUrl, credentials);
    await processTranscriptUploads({
      db,
      client,
      config: cloudConfig.transcriptUpload,
      serverUrl: cloudConfig.serverUrl,
      type,
      cli,
    });
  } catch (error) {
    // Fail silently — this is fire-and-forget
    if (process.env.ADIT_DEBUG) {
      const msg =
        error instanceof CloudNetworkError
          ? `[adit-transcript] upload skipped: server unreachable — ${error.message}`
          : error instanceof CloudAuthError
            ? `[adit-transcript] upload skipped: auth failed — ${error.message}`
            : `[adit-transcript] upload failed: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(msg + "\n");
    }
  }
}
