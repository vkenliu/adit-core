/**
 * `adit diff <id>` — Show the diff for a checkpoint event.
 * `adit prompt <id>` — Show the prompt text for an event.
 * `adit env <id>` — Show environment snapshot for an event.
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  getEnvSnapshotById,
} from "@adit/core";
import { createTimelineManager } from "@adit/engine";

export async function diffCommand(
  eventId: string,
  opts: { maxLines?: number; file?: string },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const diff = await timeline.getDiff(eventId, opts.maxLines);
    if (!diff) {
      console.error(`No diff found for event ${eventId}`);
      process.exit(1);
    }
    console.log(diff);
  } finally {
    closeDatabase(db);
  }
}

export async function promptCommand(eventId: string): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const event = await timeline.get(eventId);
    if (!event) {
      console.error(`Event not found: ${eventId}`);
      process.exit(1);
    }
    if (!event.promptText) {
      console.error(`No prompt text for event ${eventId}`);
      process.exit(1);
    }
    console.log(event.promptText);
  } finally {
    closeDatabase(db);
  }
}

export async function envCommand(eventId: string): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const event = await timeline.get(eventId);
    if (!event) {
      console.error(`Event not found: ${eventId}`);
      process.exit(1);
    }
    if (!event.envSnapshotId) {
      console.error(`No environment snapshot for event ${eventId}`);
      process.exit(1);
    }

    const snap = getEnvSnapshotById(db, event.envSnapshotId);
    if (!snap) {
      console.error(`Environment snapshot not found: ${event.envSnapshotId}`);
      process.exit(1);
    }

    console.log(`Environment Snapshot: ${snap.id}`);
    console.log(`  Branch:     ${snap.gitBranch}`);
    console.log(`  HEAD:       ${snap.gitHeadSha}`);
    console.log(`  Captured:   ${snap.capturedAt}`);
    if (snap.nodeVersion) console.log(`  Node:       ${snap.nodeVersion}`);
    if (snap.pythonVersion) console.log(`  Python:     ${snap.pythonVersion}`);
    if (snap.osInfo) console.log(`  OS:         ${snap.osInfo}`);
    if (snap.depLockPath) {
      console.log(`  Lock file:  ${snap.depLockPath}`);
      console.log(`  Lock hash:  ${snap.depLockHash ?? "-"}`);
    }
    if (snap.modifiedFiles) {
      const files = JSON.parse(snap.modifiedFiles);
      console.log(`  Modified:   ${files.length} files`);
      for (const f of files) {
        console.log(`    - ${f}`);
      }
    }
  } finally {
    closeDatabase(db);
  }
}
