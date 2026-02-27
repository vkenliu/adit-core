/**
 * Transcript incremental uploader.
 *
 * Reads a JSONL transcript file, detects new data since the last upload,
 * compresses the increment with gzip, and uploads it to the server.
 *
 * Key design decisions:
 * - Increments are split on newline boundaries to preserve JSONL format
 * - Gzip compression reduces bandwidth for large transcripts
 * - Server returns a version token for conflict detection
 * - Server can signal "resync" to request a full re-upload
 * - Max 3 consecutive failures per file before giving up
 */

import { statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import type { CloudClient } from "../http/client.js";
import { CloudApiError } from "../http/errors.js";

/** Response from the server after uploading a transcript chunk */
export interface TranscriptUploadResponse {
  /** Byte offset the server has confirmed receiving up to */
  confirmedOffset: number;
  /** Opaque version token (pass back on next upload) */
  serverVersion: string;
  /** If true, server requests a full re-upload from offset 0 */
  resyncRequired: boolean;
}

/** Response from the server for initial transcript registration */
export interface TranscriptInitResponse {
  /** Server-side transcript ID */
  transcriptId: string;
  /** Confirmed starting offset (0 for new, or last known for resume) */
  confirmedOffset: number;
  /** Opaque version token */
  serverVersion: string;
}

export interface UploadChunkParams {
  /** Session ID for this transcript */
  sessionId: string;
  /** Absolute path to the transcript file */
  transcriptPath: string;
  /** Byte offset to start reading from */
  offsetBytes: number;
  /** Current total file size */
  fileSizeBytes: number;
  /** Server version token from previous upload (null for first upload) */
  serverVersion: string | null;
}

/**
 * Read the increment from a transcript file starting at the given
 * byte offset, snapping to the nearest complete line boundary.
 *
 * Returns the raw bytes of complete JSONL lines after the offset.
 * If no complete new lines exist, returns null.
 */
export function readIncrement(
  transcriptPath: string,
  offsetBytes: number,
): { data: Buffer; newOffset: number } | null {
  if (!existsSync(transcriptPath)) return null;

  const stat = statSync(transcriptPath);
  if (stat.size <= offsetBytes) return null;

  // Read from the offset to end of file
  const fd = openSync(transcriptPath, "r");
  try {
    const remainingSize = stat.size - offsetBytes;
    const buf = Buffer.alloc(remainingSize);
    readSync(fd, buf, 0, remainingSize, offsetBytes);

    // Find the last newline to ensure we only send complete lines.
    // JSONL files have one JSON object per line, terminated by \n.
    let endPos = remainingSize;
    if (buf[endPos - 1] !== 0x0a) {
      // Last byte is not a newline — find the last complete line
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // No complete line in the new data yet
        return null;
      }
      endPos = lastNewline + 1;
    }

    const data = buf.subarray(0, endPos);
    return {
      data: Buffer.from(data), // Copy to avoid holding the full buffer
      newOffset: offsetBytes + endPos,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Compress a buffer with gzip.
 */
export async function compressGzip(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gzip = createGzip({ level: 6 });
    const input = Readable.from(data);

    input
      .pipe(gzip)
      .on("data", (chunk: Buffer) => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

/**
 * Upload an incremental chunk to the server.
 *
 * The chunk is gzip-compressed before sending. The server responds
 * with the confirmed byte offset and a version token.
 *
 * If the server returns a 409 with resyncRequired=true, the caller
 * should reset the upload state and re-upload from offset 0.
 */
export async function uploadTranscriptChunk(
  client: CloudClient,
  params: UploadChunkParams,
): Promise<TranscriptUploadResponse> {
  const increment = readIncrement(params.transcriptPath, params.offsetBytes);

  if (!increment) {
    // No new data — return current state
    return {
      confirmedOffset: params.offsetBytes,
      serverVersion: params.serverVersion ?? "",
      resyncRequired: false,
    };
  }

  // Compress the increment
  const compressed = await compressGzip(increment.data);

  // Build the upload payload
  const payload = {
    sessionId: params.sessionId,
    transcriptPath: params.transcriptPath,
    offsetBytes: params.offsetBytes,
    newOffsetBytes: increment.newOffset,
    fileSizeBytes: params.fileSizeBytes,
    serverVersion: params.serverVersion,
    encoding: "gzip" as const,
    // Base64-encode the compressed data for JSON transport
    data: compressed.toString("base64"),
    rawBytes: increment.data.length,
    compressedBytes: compressed.length,
  };

  try {
    return await client.post<TranscriptUploadResponse>(
      "/api/transcripts/upload",
      payload,
    );
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 409) {
      // Server detected corruption — needs full re-upload
      const body = error.body as { resyncRequired?: boolean } | undefined;
      if (body?.resyncRequired) {
        return {
          confirmedOffset: 0,
          serverVersion: "",
          resyncRequired: true,
        };
      }
    }
    throw error;
  }
}

/**
 * Upload the full transcript file from offset 0.
 * Used for initial upload or when server requests a resync.
 */
export async function uploadTranscriptFull(
  client: CloudClient,
  params: Omit<UploadChunkParams, "offsetBytes">,
): Promise<TranscriptUploadResponse> {
  return uploadTranscriptChunk(client, {
    ...params,
    offsetBytes: 0,
    serverVersion: null, // Reset server version on full upload
  });
}

/**
 * Get the current file size of a transcript, or 0 if it doesn't exist.
 */
export function getTranscriptFileSize(transcriptPath: string): number {
  if (!existsSync(transcriptPath)) return 0;
  return statSync(transcriptPath).size;
}
