/**
 * Diff storage operations.
 *
 * Large diffs are stored separately from events for efficiency.
 */

import type Database from "better-sqlite3";

export interface DiffRecord {
  id: string;
  eventId: string;
  diffText: string;
  fileFilter: string | null;
  createdAt: string;
}

export function insertDiff(
  db: Database.Database,
  input: { id: string; eventId: string; diffText: string; fileFilter?: string },
): void {
  db.prepare(`
    INSERT INTO diffs (id, event_id, diff_text, file_filter, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(input.id, input.eventId, input.diffText, input.fileFilter ?? null);
}

export function getDiffByEventId(
  db: Database.Database,
  eventId: string,
): DiffRecord | null {
  const row = db
    .prepare("SELECT * FROM diffs WHERE event_id = ? LIMIT 1")
    .get(eventId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: row.id as string,
    eventId: row.event_id as string,
    diffText: row.diff_text as string,
    fileFilter: (row.file_filter as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function getDiffText(
  db: Database.Database,
  eventId: string,
  maxLines?: number,
  offsetLines?: number,
): string | null {
  const record = getDiffByEventId(db, eventId);
  if (!record) return null;

  if (!maxLines && !offsetLines) return record.diffText;

  const lines = record.diffText.split("\n");
  const start = offsetLines ?? 0;
  const end = maxLines ? start + maxLines : lines.length;
  return lines.slice(start, end).join("\n");
}
