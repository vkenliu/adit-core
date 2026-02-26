/**
 * Conflict handler for sync responses.
 *
 * When the server detects concurrent modifications on mutable records
 * (sessions, plans), it returns conflict details with its resolution.
 * This module processes those responses.
 *
 * Design: Local-first. We log conflicts but don't overwrite local data.
 * The server is authoritative for the cloud view; the local DB remains
 * the user's working copy.
 */

export interface SyncConflict {
  type: "session" | "plan";
  id: string;
  resolution: string;
  reason: string;
}

/**
 * Process conflict responses from the server.
 *
 * Currently just logs conflicts. Future versions could:
 * - Fetch the server's version and store it separately
 * - Prompt the user to choose a resolution
 * - Apply server's version to local state
 */
export function handleConflicts(conflicts: SyncConflict[]): void {
  for (const conflict of conflicts) {
    // Structured log for debugging — not user-facing
    if (process.env.ADIT_DEBUG) {
      process.stderr.write(
        `[adit-cloud] sync conflict: ${conflict.type}/${conflict.id} — ${conflict.resolution}: ${conflict.reason}\n`,
      );
    }
  }
}
