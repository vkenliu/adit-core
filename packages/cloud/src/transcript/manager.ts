/**
 * Transcript upload manager.
 *
 * Orchestrates the lifecycle of transcript uploads:
 * 1. Discovers transcripts from hook events (via registerTranscript)
 * 2. Periodically checks tracked transcripts for new data
 * 3. Uploads increments with compression
 * 4. Handles server resync requests (full re-upload)
 * 5. Respects max retry limits (3 per file)
 *
 * The manager is designed to be triggered from hook events
 * (fire-and-forget) rather than running as a persistent daemon.
 * Each invocation processes all pending uploads then exits.
 */

import type Database from "better-sqlite3";
import {
  generateId,
  getTranscriptUpload,
  upsertTranscriptUpload,
  listPendingTranscriptUploads,
  markTranscriptUploaded,
  markTranscriptUploadFailed,
  resetTranscriptUpload,
} from "@adit/core";
import type { CloudClient } from "../http/client.js";
import type { TranscriptUploadConfig } from "../config.js";
import {
  uploadChunk,
  getFileSize,
  type SyncUploadType,
} from "./uploader.js";

export interface TranscriptManagerOptions {
  db: Database.Database;
  client: CloudClient;
  config: TranscriptUploadConfig;
  serverUrl: string;
  /** Upload type discriminator (default: "transcript") */
  type?: SyncUploadType;
  /** CLI identifier (default: "claude-code") */
  cli?: string;
}

export interface TranscriptProcessResult {
  /** Number of transcripts processed */
  processed: number;
  /** Number of successful uploads */
  uploaded: number;
  /** Number of transcripts skipped (no new data) */
  skipped: number;
  /** Number of failed uploads */
  failed: number;
  /** Number of transcripts that triggered a full resync */
  resynced: number;
  /** Total bytes uploaded (before compression) */
  totalRawBytes: number;
  /** Total bytes uploaded (after compression) */
  totalCompressedBytes: number;
}

/**
 * Register a transcript path for tracking.
 *
 * Called from hook handlers when they see a transcript_path
 * in the hook event input. If the transcript is already tracked,
 * this is a no-op.
 */
export function registerTranscript(
  db: Database.Database,
  sessionId: string,
  transcriptPath: string,
  serverUrl: string,
): void {
  const existing = getTranscriptUpload(db, transcriptPath, serverUrl);
  if (existing) return; // Already tracked

  upsertTranscriptUpload(db, {
    id: generateId(),
    sessionId,
    transcriptPath,
    serverUrl,
  });
}

/**
 * Process all pending transcript uploads.
 *
 * Iterates through tracked transcripts, checks for new data,
 * and uploads increments. Respects maxConcurrent and maxRetries
 * from config.
 *
 * This function is safe to call concurrently — SQLite's WAL mode
 * and the upsert pattern prevent double-processing. However,
 * the caller should avoid redundant invocations for efficiency.
 */
export async function processTranscriptUploads(
  opts: TranscriptManagerOptions,
): Promise<TranscriptProcessResult> {
  const {
    db,
    client,
    config,
    serverUrl,
    type = "transcript",
    cli = "claude-code",
  } = opts;

  const result: TranscriptProcessResult = {
    processed: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    resynced: 0,
    totalRawBytes: 0,
    totalCompressedBytes: 0,
  };

  if (!config.enabled) return result;

  // Get all transcripts that need processing
  const pending = listPendingTranscriptUploads(db, serverUrl);
  if (pending.length === 0) return result;

  // Process up to maxConcurrent at a time
  // Use sequential processing to be kind to the network
  // and avoid overwhelming the server
  let activeCount = 0;

  for (const upload of pending) {
    if (activeCount >= config.maxConcurrent) break;

    result.processed++;

    // Check if the file has new data
    const currentSize = getFileSize(upload.transcriptPath);
    if (currentSize === 0) {
      result.skipped++;
      continue;
    }

    // Skip if no new data and already up to date
    const newDataBytes = currentSize - upload.uploadedBytes;
    if (newDataBytes < config.minIncrementBytes && upload.status === "up_to_date") {
      result.skipped++;
      continue;
    }

    // Skip if already at current file size
    if (upload.uploadedBytes >= currentSize) {
      result.skipped++;
      continue;
    }

    activeCount++;

    try {
      const response = await uploadChunk(client, {
        type,
        cli,
        sessionId: upload.sessionId,
        filePath: upload.transcriptPath,
        offsetBytes: upload.uploadedBytes,
        fileSizeBytes: currentSize,
        serverVersion: upload.serverVersion,
      });

      if (response.resyncRequired) {
        // Server needs full re-upload
        resetTranscriptUpload(db, upload.id);
        result.resynced++;

        // Immediately re-upload from offset 0
        const fullResponse = await uploadChunk(client, {
          type,
          cli,
          sessionId: upload.sessionId,
          filePath: upload.transcriptPath,
          offsetBytes: 0,
          fileSizeBytes: currentSize,
          serverVersion: null,
        });

        if (fullResponse.resyncRequired) {
          // Still failing after full re-upload — mark as failed
          markTranscriptUploadFailed(
            db,
            upload.id,
            "Server requested resync but full re-upload also failed",
          );
          result.failed++;
          continue;
        }

        markTranscriptUploaded(
          db,
          upload.id,
          fullResponse.confirmedOffset,
          currentSize,
          fullResponse.serverVersion,
        );
        result.uploaded++;
      } else {
        // Normal incremental upload succeeded
        markTranscriptUploaded(
          db,
          upload.id,
          response.confirmedOffset,
          currentSize,
          response.serverVersion,
        );
        result.uploaded++;
      }
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      markTranscriptUploadFailed(db, upload.id, errorMsg);
      result.failed++;

      if (process.env.ADIT_DEBUG) {
        process.stderr.write(
          `[adit-transcript] upload failed for ${upload.transcriptPath}: ${errorMsg}\n`,
        );
      }
    }
  }

  return result;
}
