/**
 * Transcript upload tracking.
 *
 * Tracks which transcript files have been discovered, how much
 * has been uploaded (byte offset for incremental uploads), and
 * retry state (max 3 failures before giving up).
 */

import type Database from "better-sqlite3";

/** Status of a transcript upload */
export type TranscriptUploadStatus =
  | "pending"     // Discovered, not yet uploaded
  | "uploading"   // Upload in progress
  | "up_to_date"  // Fully uploaded (may have more data later)
  | "failed"      // Exceeded max retries
  | "disabled";   // Upload disabled by user

export interface TranscriptUpload {
  id: string;
  sessionId: string;
  transcriptPath: string;
  serverUrl: string;
  /** Number of bytes already confirmed uploaded to server */
  uploadedBytes: number;
  /** Current file size on disk */
  fileSizeBytes: number;
  status: TranscriptUploadStatus;
  /** Number of consecutive failures (resets on success) */
  failureCount: number;
  lastError: string | null;
  /** Opaque version token from server (for conflict detection) */
  serverVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTranscriptUploadInput {
  id: string;
  sessionId: string;
  transcriptPath: string;
  serverUrl: string;
  uploadedBytes?: number;
  fileSizeBytes?: number;
  status?: TranscriptUploadStatus;
  failureCount?: number;
  lastError?: string | null;
  serverVersion?: string | null;
}

const UPSERT_SQL = `
  INSERT INTO transcript_uploads (
    id, session_id, transcript_path, server_url,
    uploaded_bytes, file_size_bytes, status,
    failure_count, last_error, server_version,
    created_at, updated_at
  ) VALUES (
    @id, @sessionId, @transcriptPath, @serverUrl,
    @uploadedBytes, @fileSizeBytes, @status,
    @failureCount, @lastError, @serverVersion,
    @now, @now
  )
  ON CONFLICT(transcript_path, server_url) DO UPDATE SET
    uploaded_bytes = @uploadedBytes,
    file_size_bytes = @fileSizeBytes,
    status = @status,
    failure_count = @failureCount,
    last_error = @lastError,
    server_version = @serverVersion,
    updated_at = @now
`;

/** Insert or update a transcript upload record */
export function upsertTranscriptUpload(
  db: Database.Database,
  input: UpsertTranscriptUploadInput,
): void {
  const now = new Date().toISOString();
  db.prepare(UPSERT_SQL).run({
    id: input.id,
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    serverUrl: input.serverUrl,
    uploadedBytes: input.uploadedBytes ?? 0,
    fileSizeBytes: input.fileSizeBytes ?? 0,
    status: input.status ?? "pending",
    failureCount: input.failureCount ?? 0,
    lastError: input.lastError ?? null,
    serverVersion: input.serverVersion ?? null,
    now,
  });
}

/** Get a transcript upload by path and server */
export function getTranscriptUpload(
  db: Database.Database,
  transcriptPath: string,
  serverUrl: string,
): TranscriptUpload | null {
  const row = db
    .prepare(
      `SELECT * FROM transcript_uploads
       WHERE transcript_path = ? AND server_url = ?`,
    )
    .get(transcriptPath, serverUrl) as TranscriptUploadRow | undefined;

  return row ? mapRow(row) : null;
}

/** Get a transcript upload by ID */
export function getTranscriptUploadById(
  db: Database.Database,
  id: string,
): TranscriptUpload | null {
  const row = db
    .prepare("SELECT * FROM transcript_uploads WHERE id = ?")
    .get(id) as TranscriptUploadRow | undefined;

  return row ? mapRow(row) : null;
}

/** List transcript uploads that need processing (pending or have new data) */
export function listPendingTranscriptUploads(
  db: Database.Database,
  serverUrl: string,
): TranscriptUpload[] {
  const rows = db
    .prepare(
      `SELECT * FROM transcript_uploads
       WHERE server_url = ?
         AND status IN ('pending', 'uploading', 'up_to_date')
         AND failure_count < 3
       ORDER BY updated_at ASC`,
    )
    .all(serverUrl) as TranscriptUploadRow[];

  return rows.map(mapRow);
}

/** Mark a transcript upload as successfully uploaded up to a byte offset */
export function markTranscriptUploaded(
  db: Database.Database,
  id: string,
  uploadedBytes: number,
  fileSizeBytes: number,
  serverVersion: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE transcript_uploads
     SET uploaded_bytes = ?,
         file_size_bytes = ?,
         status = CASE WHEN ? >= ? THEN 'up_to_date' ELSE 'uploading' END,
         failure_count = 0,
         last_error = NULL,
         server_version = COALESCE(?, server_version),
         updated_at = ?
     WHERE id = ?`,
  ).run(uploadedBytes, fileSizeBytes, uploadedBytes, fileSizeBytes, serverVersion, now, id);
}

/** Record a failed upload attempt */
export function markTranscriptUploadFailed(
  db: Database.Database,
  id: string,
  error: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE transcript_uploads
     SET failure_count = failure_count + 1,
         last_error = ?,
         status = CASE WHEN failure_count + 1 >= 3 THEN 'failed' ELSE status END,
         updated_at = ?
     WHERE id = ?`,
  ).run(error, now, id);
}

/** Reset a transcript for full re-upload (server requested) */
export function resetTranscriptUpload(
  db: Database.Database,
  id: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE transcript_uploads
     SET uploaded_bytes = 0,
         status = 'pending',
         failure_count = 0,
         last_error = NULL,
         server_version = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(now, id);
}

/** Count active transcript uploads for a server */
export function countActiveTranscriptUploads(
  db: Database.Database,
  serverUrl: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM transcript_uploads
       WHERE server_url = ?
         AND status NOT IN ('failed', 'disabled')`,
    )
    .get(serverUrl) as { count: number };

  return row.count;
}

// Internal row mapping

interface TranscriptUploadRow {
  id: string;
  session_id: string;
  transcript_path: string;
  server_url: string;
  uploaded_bytes: number;
  file_size_bytes: number;
  status: string;
  failure_count: number;
  last_error: string | null;
  server_version: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: TranscriptUploadRow): TranscriptUpload {
  return {
    id: row.id,
    sessionId: row.session_id,
    transcriptPath: row.transcript_path,
    serverUrl: row.server_url,
    uploadedBytes: row.uploaded_bytes,
    fileSizeBytes: row.file_size_bytes,
    status: row.status as TranscriptUploadStatus,
    failureCount: row.failure_count,
    lastError: row.last_error,
    serverVersion: row.server_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
