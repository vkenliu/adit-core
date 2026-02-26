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
  opts: { maxLines?: number; offsetLines?: number; file?: string },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    let diff = await timeline.getDiff(eventId, opts.maxLines, opts.offsetLines);
    if (!diff) {
      console.error(`No diff found for event ${eventId}`);
      process.exit(1);
    }

    // Filter to a specific file if requested
    if (opts.file) {
      diff = filterDiffByFile(diff, opts.file);
      if (!diff.trim()) {
        console.error(`No changes found for file: ${opts.file}`);
        process.exit(1);
      }
    }

    console.log(diff);
  } finally {
    closeDatabase(db);
  }
}

/** Extract diff hunks for a specific file from a unified diff */
function filterDiffByFile(diff: string, filePath: string): string {
  const lines = diff.split("\n");
  const result: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      // Check if this diff section matches the requested file
      capturing =
        line.includes(`a/${filePath}`) || line.includes(`b/${filePath}`);
    }
    if (capturing) {
      result.push(line);
    }
  }

  return result.join("\n");
}

export async function promptCommand(
  eventId: string,
  opts?: { maxChars?: number; offset?: number },
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
    if (!event.promptText) {
      console.error(`No prompt text for event ${eventId}`);
      process.exit(1);
    }

    let text = event.promptText;
    const start = opts?.offset ?? 0;
    if (start > 0 || opts?.maxChars) {
      const end = opts?.maxChars ? start + opts.maxChars : text.length;
      text = text.slice(start, end);
      if (end < event.promptText.length) {
        text += `\n... (truncated, ${event.promptText.length - end} chars remaining)`;
      }
    }

    console.log(text);
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
