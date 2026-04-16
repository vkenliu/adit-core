/**
 * `adit db` — Database management commands.
 *
 * Subcommands:
 *   clear-events — Delete all events, sessions, diffs, and env snapshots
 */

import { loadConfig, openDatabase, closeDatabase, clearEvents, countEvents } from "@varveai/adit-core";

/**
 * `adit db clear-events` — Clear all local events and related data.
 *
 * Deletes events, diffs, env snapshots, sessions, and resets sync cursors
 * for the current project. This is irreversible.
 */
export async function dbClearEventsCommand(opts?: {
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const config = loadConfig();

  const db = openDatabase(config.dbPath);
  try {
    const eventCount = countEvents(db, config.projectId);

    if (eventCount === 0) {
      if (opts?.json) {
        console.log(JSON.stringify({ deleted: 0, message: "No events to clear." }));
      } else {
        console.log("No events to clear.");
      }
      return;
    }

    if (!opts?.yes) {
      console.log(
        `This will permanently delete ${eventCount} events and all associated data (diffs, sessions, env snapshots).`,
      );
      console.log("Sync cursors will also be reset.");
      console.log();
      console.log("Run with --yes to confirm, or pass --json for scripted use.");
      process.exitCode = 1;
      return;
    }

    const deleted = clearEvents(db, config.projectId);

    if (opts?.json) {
      console.log(JSON.stringify({ deleted, message: "Events cleared." }));
    } else {
      console.log(`Cleared ${deleted} events and all associated data.`);
    }
  } finally {
    closeDatabase(db);
  }
}
