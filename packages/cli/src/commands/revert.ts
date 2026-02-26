/**
 * `adit revert <id>` — Revert working tree to a checkpoint.
 * `adit undo` — Revert to parent of last checkpoint.
 */

import { loadConfig, openDatabase, closeDatabase } from "@adit/core";
import { createTimelineManager, hasUncommittedChanges } from "@adit/engine";

export async function revertCommand(
  eventId: string,
  opts: { yes?: boolean },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const event = await timeline.get(eventId);
    if (!event) {
      console.error(`Event not found: ${eventId}`);
      process.exit(1);
    }
    if (!event.checkpointSha) {
      console.error(`Event ${eventId} has no checkpoint to revert to.`);
      process.exit(1);
    }

    // Warn about dirty working tree
    if (!opts.yes) {
      const dirty = await hasUncommittedChanges(config.projectRoot);
      if (dirty) {
        console.log(
          "Warning: You have uncommitted changes. They will be lost on revert.",
        );
        console.log("Use --yes to skip this warning.");
        // In a real TUI we'd prompt for confirmation
        // For now, proceed anyway since we're non-interactive in hooks
      }
    }

    await timeline.revertTo(eventId);

    // Record the revert as an event
    await timeline.recordEvent({
      sessionId: event.sessionId,
      eventType: "revert",
      actor: "user",
      responseText: `Reverted to checkpoint ${event.checkpointSha.substring(0, 8)}`,
    });

    console.log(
      `Reverted to checkpoint ${event.checkpointSha.substring(0, 8)} (event ${eventId.substring(0, 10)})`,
    );
  } finally {
    closeDatabase(db);
  }
}

export async function undoCommand(opts: { yes?: boolean }): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    if (!opts.yes) {
      const dirty = await hasUncommittedChanges(config.projectRoot);
      if (dirty) {
        console.log(
          "Warning: You have uncommitted changes. They will be lost on undo.",
        );
      }
    }

    await timeline.undo();
    console.log("Undone to parent of last checkpoint.");
  } finally {
    closeDatabase(db);
  }
}
