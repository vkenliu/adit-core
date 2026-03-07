/**
 * `adit snapshot revert [id]` — Revert working tree to a checkpoint.
 * `adit snapshot undo` — Revert to parent of last checkpoint.
 *
 * When called without an ID, presents an interactive picker listing
 * recent checkpoints for the user to select from.
 */

import { createInterface } from "node:readline";
import { loadConfig, openDatabase, closeDatabase, queryEvents } from "@adit/core";
import type { AditEvent } from "@adit/core";
import {
  createTimelineManager,
  hasUncommittedChanges,
  runGit,
  getHeadSha,
  shaExists,
} from "@adit/engine";
import { getEventSummary } from "../utils/summary.js";

/** Lock/dependency files to check for changes between checkpoints */
export const DEP_FILES = [
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
export async function checkDependencyChanges(
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

/** Warn about dependency changes and print the affected files */
export function printDependencyWarnings(depChanges: string[]): void {
  if (depChanges.length === 0) return;
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

// ---------------------------------------------------------------------------
// Revert by ID
// ---------------------------------------------------------------------------

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

    // Verify checkpoint SHA is still reachable
    const reachable = await shaExists(config.projectRoot, event.checkpointSha);
    if (!reachable) {
      console.error(
        `Checkpoint ${event.checkpointSha.substring(0, 8)} is no longer reachable in the git object store.`,
      );
      console.error("The checkpoint ref may have been deleted and the object garbage collected.");
      process.exit(1);
    }

    // Check for dependency file changes
    const headSha = await getHeadSha(config.projectRoot);
    if (headSha) {
      const depChanges = await checkDependencyChanges(
        config.projectRoot,
        headSha,
        event.checkpointSha,
      );
      printDependencyWarnings(depChanges);
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

// ---------------------------------------------------------------------------
// Interactive revert (no ID given)
// ---------------------------------------------------------------------------

/** Format a checkpoint event for display in the picker */
function formatCheckpointLine(event: AditEvent, index: number): string {
  const sha = event.checkpointSha?.substring(0, 8) ?? "????????";
  const time = event.startedAt
    ? new Date(event.startedAt).toLocaleString()
    : "unknown time";
  const summary = getEventSummary(event, 50);

  // Parse file stats for a quick overview
  let fileInfo = "";
  if (event.diffStatJson) {
    try {
      const stats = JSON.parse(event.diffStatJson) as Array<{ path?: string }>;
      fileInfo = ` (${stats.length} file${stats.length === 1 ? "" : "s"})`;
    } catch {
      // best-effort
    }
  }

  return `  ${String(index + 1).padStart(3)}. [${sha}] ${time}${fileInfo}\n       ${summary}`;
}

/**
 * Interactive revert: list checkpoints and let the user pick one.
 *
 * Uses a simple numbered-list approach for broad terminal compatibility
 * rather than requiring a TUI framework. Reads from stdin for selection.
 */
export async function interactiveRevertCommand(opts: {
  yes?: boolean;
  limit?: number;
}): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    // Fetch recent checkpoints
    const limit = opts.limit ?? 20;
    const checkpoints = queryEvents(db, {
      hasCheckpoint: true,
      limit,
    });

    if (checkpoints.length === 0) {
      console.log("No checkpoints found. Work with your AI agent to create checkpoints.");
      return;
    }

    // Display checkpoint list
    console.log("\nAvailable checkpoints:\n");
    for (let i = 0; i < checkpoints.length; i++) {
      console.log(formatCheckpointLine(checkpoints[i], i));
      if (i < checkpoints.length - 1) console.log();
    }
    console.log();

    // Prompt for selection
    const selectedIndex = await promptForSelection(checkpoints.length);
    if (selectedIndex === null) {
      console.log("Revert cancelled.");
      return;
    }

    const selected = checkpoints[selectedIndex];

    // Warn about dirty working tree
    if (!opts.yes) {
      const dirty = await hasUncommittedChanges(config.projectRoot);
      if (dirty) {
        console.log(
          "\nWarning: You have uncommitted changes. They will be lost on revert.",
        );
        const confirmed = await promptConfirm("Continue with revert?");
        if (!confirmed) {
          console.log("Revert cancelled.");
          return;
        }
      }
    }

    // Verify checkpoint SHA is still reachable
    if (selected.checkpointSha) {
      const reachable = await shaExists(config.projectRoot, selected.checkpointSha);
      if (!reachable) {
        console.error(
          `\nCheckpoint ${selected.checkpointSha.substring(0, 8)} is no longer reachable in the git object store.`,
        );
        console.error("The checkpoint ref may have been deleted and the object garbage collected.");
        return;
      }
    }

    // Check for dependency file changes
    const headSha = await getHeadSha(config.projectRoot);
    if (headSha && selected.checkpointSha) {
      const depChanges = await checkDependencyChanges(
        config.projectRoot,
        headSha,
        selected.checkpointSha,
      );
      printDependencyWarnings(depChanges);
    }

    // Perform the revert
    await timeline.revertTo(selected.id);

    // Record the revert event
    await timeline.recordEvent({
      sessionId: selected.sessionId,
      eventType: "revert",
      actor: "user",
      responseText: `Reverted to checkpoint ${selected.checkpointSha?.substring(0, 8) ?? "unknown"} (interactive)`,
    });

    console.log(
      `\nReverted to checkpoint ${selected.checkpointSha?.substring(0, 8)} (event ${selected.id.substring(0, 10)})`,
    );
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Undo (revert to parent of last checkpoint)
// ---------------------------------------------------------------------------

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
      const reachable = await shaExists(config.projectRoot, latestCheckpoint[0].checkpointSha);
      if (reachable) {
        const depChanges = await checkDependencyChanges(
          config.projectRoot,
          headSha,
          latestCheckpoint[0].checkpointSha,
        );
        printDependencyWarnings(depChanges);
      }
    }

    await timeline.undo();
    console.log("Undone to parent of last checkpoint.");
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Stdin helpers for interactive mode
// ---------------------------------------------------------------------------

/** Read a line from stdin */
function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    if (!process.stdin.isTTY) {
      resolve("");
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.question("", (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Prompt the user to select a checkpoint by number (1-based). Returns 0-based index or null. */
async function promptForSelection(count: number): Promise<number | null> {
  const answer = await readLine(`Select checkpoint (1-${count}) or 'q' to cancel: `);

  if (answer === "q" || answer === "Q" || answer === "") {
    return null;
  }

  const num = parseInt(answer, 10);
  if (isNaN(num) || num < 1 || num > count) {
    console.error(`Invalid selection: ${answer}. Enter a number between 1 and ${count}.`);
    return null;
  }

  return num - 1;
}

/** Prompt the user for a yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
  const answer = await readLine(`${message} (y/N): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
