/**
 * `adit snapshot revert <id>` — Revert working tree to a checkpoint.
 * `adit snapshot undo` — Revert to parent of last checkpoint.
 */

import { loadConfig, openDatabase, closeDatabase } from "@adit/core";
import {
  createTimelineManager,
  hasUncommittedChanges,
  runGit,
  getHeadSha,
} from "@adit/engine";

/** Lock/dependency files to check for changes between checkpoints */
const DEP_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "requirements.txt",
  "Pipfile.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
  "Cargo.lock",
  "composer.lock",
];

/** Check if dependency files changed between two SHAs */
async function checkDependencyChanges(
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const result = await runGit(
    ["diff", "--name-only", fromSha, toSha, "--", ...DEP_FILES],
    { cwd },
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  return result.stdout.trim().split("\n").filter(Boolean);
}

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
      }
    }

    // Check for dependency file changes
    const headSha = await getHeadSha(config.projectRoot);
    if (headSha) {
      const depChanges = await checkDependencyChanges(
        config.projectRoot,
        headSha,
        event.checkpointSha,
      );
      if (depChanges.length > 0) {
        console.log(
          "\nWarning: Dependency files changed between current state and target checkpoint:",
        );
        for (const file of depChanges) {
          console.log(`  - ${file}`);
        }
        console.log(
          "You may need to re-install dependencies after reverting (e.g., pnpm install).\n",
        );
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

    // Check for dependency changes before undo
    const headSha = await getHeadSha(config.projectRoot);
    const latestCheckpoint = await timeline.list({
      hasCheckpoint: true,
      limit: 1,
    });
    if (headSha && latestCheckpoint[0]?.checkpointSha) {
      const depChanges = await checkDependencyChanges(
        config.projectRoot,
        headSha,
        latestCheckpoint[0].checkpointSha,
      );
      if (depChanges.length > 0) {
        console.log(
          "\nWarning: Dependency files changed. You may need to re-install dependencies after undo:",
        );
        for (const file of depChanges) {
          console.log(`  - ${file}`);
        }
        console.log();
      }
    }

    await timeline.undo();
    console.log("Undone to parent of last checkpoint.");
  } finally {
    closeDatabase(db);
  }
}
