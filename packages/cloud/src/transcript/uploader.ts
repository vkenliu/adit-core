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
 *
 * The upload API is generic (/api/sync/upload) and uses `type` + `cli`
 * fields so the server can handle different file types from different
 * AI coding tools (Claude Code, Cursor, Windsurf, etc.).
 */

import { statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import type { CloudClient } from "../http/client.js";
import { CloudApiError } from "../http/errors.js";

// ── Types ────────────────────────────────────────────────────────────────

/** Upload type discriminator — extensible for future file types */
export type SyncUploadType = "transcript" | "plan" | "log";

/** Response from POST /api/sync/upload */
export interface SyncUploadResponse {
  /** Server-assigned upload ID (stable across increments) */
  uploadId: string;
  /** Byte offset the server has confirmed receiving up to */
  confirmedOffset: number;
  /** Opaque version token (pass back on next upload) */
  serverVersion: string;
  /** If true, server requests a full re-upload from offset 0 */
  resyncRequired: boolean;
}

/**
 * Upload status parsed from HEAD response headers.
 *
 * All status is conveyed via standard + custom HTTP headers,
 * with no JSON body — keeping status checks as cheap as possible.
 */
export interface SyncUploadStatus {
  uploadId: string;
  confirmedOffset: number;
  serverVersion: string;
  type: string;
  cli: string;
  totalStoredBytes: number;
  lastModified: string | null;
}

/** Parameters for uploading a chunk */
export interface UploadChunkParams {
  /** Upload type (e.g. "transcript") */
  type: SyncUploadType;
  /** CLI identifier (e.g. "claude-code") */
  cli: string;
  /** Session ID for this file */
  sessionId: string;
  /** Absolute path to the file on the client */
  filePath: string;
  /** Byte offset to start reading from */
  offsetBytes: number;
  /** Current total file size */
  fileSizeBytes: number;
  /** Server version token from previous upload (null for first upload) */
  serverVersion: string | null;
}

// ── File reading ─────────────────────────────────────────────────────────

/**
 * Read the increment from a transcript file starting at the given
 * byte offset, snapping to the nearest complete line boundary.
 *
 * Returns the raw bytes of complete JSONL lines after the offset.
 * If no complete new lines exist, returns null.
 */
export function readIncrement(
  filePath: string,
  offsetBytes: number,
): { data: Buffer; newOffset: number } | null {
  if (!existsSync(filePath)) return null;

  const stat = statSync(filePath);
  if (stat.size <= offsetBytes) return null;

  // Read from the offset to end of file
  const fd = openSync(filePath, "r");
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

// ── Compression ──────────────────────────────────────────────────────────

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

// ── Upload ───────────────────────────────────────────────────────────────

/**
 * Upload an incremental chunk to the server.
 *
 * Posts to `/api/sync/upload` with `type` and `cli` fields so the server
 * can route to the correct handler regardless of which CLI/file-type
 * produced the data.
 *
 * The chunk is gzip-compressed before sending. The server responds
 * with the confirmed byte offset and a version token.
 *
 * If the server returns a 409 with resyncRequired=true, the caller
 * should reset the upload state and re-upload from offset 0.
 */
export async function uploadChunk(
  client: CloudClient,
  params: UploadChunkParams,
): Promise<SyncUploadResponse> {
  const increment = readIncrement(params.filePath, params.offsetBytes);

  if (!increment) {
    // No new data — return current state
    return {
      uploadId: "",
      confirmedOffset: params.offsetBytes,
      serverVersion: params.serverVersion ?? "",
      resyncRequired: false,
    };
  }

  // Compress the increment
  const compressed = await compressGzip(increment.data);

  // Build the upload payload
  const payload = {
    type: params.type,
    cli: params.cli,
    sessionId: params.sessionId,
    filePath: params.filePath,
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
    return await client.post<SyncUploadResponse>(
      "/api/sync/upload",
      payload,
    );
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 409) {
      // Server detected corruption — needs full re-upload
      const body = error.body as { resyncRequired?: boolean } | undefined;
      if (body?.resyncRequired) {
        return {
          uploadId: "",
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
 * Upload the full file from offset 0.
 * Used for initial upload or when server requests a resync.
 */
export async function uploadFull(
  client: CloudClient,
  params: Omit<UploadChunkParams, "offsetBytes">,
): Promise<SyncUploadResponse> {
  return uploadChunk(client, {
    ...params,
    offsetBytes: 0,
    serverVersion: null, // Reset server version on full upload
  });
}

// ── Status check ─────────────────────────────────────────────────────────

/**
 * Check upload status via HEAD /api/sync/upload/{uploadId}.
 *
 * All status is returned in standard HTTP headers — no JSON body.
 * This is the only status check method; there is no GET-by-ID endpoint.
 *
 * Header mapping:
 *   X-Upload-Id          → uploadId
 *   X-Confirmed-Offset   → confirmedOffset
 *   ETag                 → serverVersion
 *   X-Upload-Type        → type
 *   X-Upload-Cli         → cli
 *   Content-Length        → totalStoredBytes
 *   Last-Modified         → lastModified
 *
 * Returns null if the upload is not found (404).
 */
export async function checkUploadStatus(
  client: CloudClient,
  uploadId: string,
): Promise<SyncUploadStatus | null> {
  try {
    const h = await client.head(
      `/api/sync/upload/${encodeURIComponent(uploadId)}`,
    );
    return parseStatusHeaders(h);
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Look up an upload by its original file path.
 *
 * Uses GET /api/sync/upload?lookup=by-path&type=...&cli=...&...
 * The response has no JSON body — status comes from headers only,
 * same as HEAD.
 *
 * Returns null if not found (404).
 */
export async function lookupUploadByPath(
  client: CloudClient,
  params: {
    type: SyncUploadType;
    cli: string;
    sessionId: string;
    filePath: string;
  },
): Promise<SyncUploadStatus | null> {
  const qs = new URLSearchParams({
    lookup: "by-path",
    type: params.type,
    cli: params.cli,
    sessionId: params.sessionId,
    filePath: params.filePath,
  });
  try {
    // We use head() here because the GET response also has no JSON body —
    // it returns the same headers. The server treats GET and HEAD
    // identically for this lookup route (both return headers-only).
    const h = await client.head(`/api/sync/upload?${qs.toString()}`);
    return parseStatusHeaders(h);
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** Parse upload status from HTTP response headers. */
function parseStatusHeaders(
  h: Record<string, string>,
): SyncUploadStatus {
  return {
    uploadId: h["x-upload-id"] ?? "",
    confirmedOffset: parseInt(h["x-confirmed-offset"] ?? "0", 10),
    serverVersion: h["etag"] ?? "",
    type: h["x-upload-type"] ?? "",
    cli: h["x-upload-cli"] ?? "",
    totalStoredBytes: parseInt(h["content-length"] ?? "0", 10),
    lastModified: h["last-modified"] ?? null,
  };
}

// ── Utilities ────────────────────────────────────────────────────────────

/**
 * Get the current file size, or 0 if the file doesn't exist.
 */
export function getFileSize(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return statSync(filePath).size;
}
