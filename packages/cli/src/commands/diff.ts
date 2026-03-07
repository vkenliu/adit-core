/**
 * `adit snapshot diff <id>` — Show the diff for a checkpoint event.
 * `adit prompt <id>` — Show the prompt text for an event.
 * `adit snapshot env` — Show/compare environment snapshots.
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  getEnvSnapshotById,
  getLatestEnvSnapshot,
  getActiveSession,
  listEnvSnapshots,
  type EnvSnapshot,
} from "@adit/core";
import { createTimelineManager, diffEnvironments } from "@adit/engine";

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

/** Show environment snapshot for a specific event (legacy command) */
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

    printEnvSnapshot(snap);
  } finally {
    closeDatabase(db);
  }
}

/** `adit env latest` — show the most recent env snapshot for the active session */
export async function envLatestCommand(opts?: { json?: boolean }): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  try {
    const session = getActiveSession(db, config.projectId, config.clientId);
    if (!session) {
      console.error("No active session. Run 'adit init' first.");
      process.exit(1);
    }

    const snap = getLatestEnvSnapshot(db, session.id);
    if (!snap) {
      console.error("No environment snapshots found for this session.");
      process.exit(1);
    }

    if (opts?.json) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      printEnvSnapshot(snap);
    }
  } finally {
    closeDatabase(db);
  }
}

/** `adit env diff <id1> <id2>` — compare two environment snapshots */
export async function envDiffCommand(
  id1: string,
  id2: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  try {
    const snap1 = getEnvSnapshotById(db, id1);
    const snap2 = getEnvSnapshotById(db, id2);

    if (!snap1) {
      console.error(`Snapshot not found: ${id1}`);
      process.exit(1);
    }
    if (!snap2) {
      console.error(`Snapshot not found: ${id2}`);
      process.exit(1);
    }

    const diff = diffEnvironments(snap1, snap2);

    if (opts?.json) {
      console.log(JSON.stringify(diff, null, 2));
      return;
    }

    if (diff.changes.length === 0) {
      console.log("No environment changes detected.");
      return;
    }

    console.log(`Environment Diff (${diff.severity}):\n`);
    for (const change of diff.changes) {
      const severityTag = change.severity === "breaking" ? "!!!" : change.severity === "warning" ? " !" : "  ";
      console.log(`  ${severityTag} [${change.category}] ${change.field}`);
      console.log(`       old: ${change.oldValue ?? "(none)"}`);
      console.log(`       new: ${change.newValue ?? "(none)"}`);
    }
  } finally {
    closeDatabase(db);
  }
}

/** `adit env history` — list env snapshots for the session */
export async function envHistoryCommand(
  opts?: { limit?: number; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  try {
    const session = getActiveSession(db, config.projectId, config.clientId);
    if (!session) {
      console.error("No active session. Run 'adit init' first.");
      process.exit(1);
    }

    const snapshots = listEnvSnapshots(db, session.id, opts?.limit ?? 20);

    if (snapshots.length === 0) {
      console.log("No environment snapshots found.");
      return;
    }

    if (opts?.json) {
      console.log(JSON.stringify(snapshots, null, 2));
      return;
    }

    console.log(`Environment Snapshots (${snapshots.length}):\n`);
    for (const snap of snapshots) {
      const id = snap.id.substring(0, 10);
      console.log(`  ${id}  ${snap.capturedAt}  ${snap.gitBranch} @ ${snap.gitHeadSha.substring(0, 7)}`);
      if (snap.nodeVersion) console.log(`           Node: ${snap.nodeVersion}`);
    }
  } finally {
    closeDatabase(db);
  }
}

/** Print a formatted env snapshot to the console */
function printEnvSnapshot(snap: EnvSnapshot): void {
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
  if (snap.containerInfo) {
    try {
      const info = JSON.parse(snap.containerInfo);
      console.log(`  Container:  ${info.inDocker ? "Docker" : "None"}${info.image ? ` (${info.image})` : ""}`);
    } catch { /* ignore */ }
  }
  if (snap.runtimeVersionsJson) {
    try {
      const versions = JSON.parse(snap.runtimeVersionsJson) as Record<string, string>;
      for (const [name, ver] of Object.entries(versions)) {
        console.log(`  ${name.charAt(0).toUpperCase() + name.slice(1)}:${" ".repeat(Math.max(1, 9 - name.length))}${ver}`);
      }
    } catch { /* ignore */ }
  }
  if (snap.shellInfo) {
    try {
      const info = JSON.parse(snap.shellInfo);
      console.log(`  Shell:      ${info.shell}${info.version ? ` (${info.version})` : ""}`);
    } catch { /* ignore */ }
  }
  if (snap.systemResourcesJson) {
    try {
      const res = JSON.parse(snap.systemResourcesJson);
      const totalGB = (res.totalMem / (1024 ** 3)).toFixed(1);
      const freeGB = (res.freeMem / (1024 ** 3)).toFixed(1);
      console.log(`  Arch:       ${res.arch}`);
      console.log(`  CPU:        ${res.cpuModel}`);
      console.log(`  Memory:     ${freeGB}GB free / ${totalGB}GB total`);
    } catch { /* ignore */ }
  }
  if (snap.packageManagerJson) {
    try {
      const pm = JSON.parse(snap.packageManagerJson);
      console.log(`  Pkg Mgr:    ${pm.name} v${pm.version}`);
    } catch { /* ignore */ }
  }
  if (snap.modifiedFiles) {
    try {
      const files = JSON.parse(snap.modifiedFiles) as string[];
      console.log(`  Modified:   ${files.length} files`);
      for (const f of files) {
        console.log(`    - ${f}`);
      }
    } catch { /* ignore */ }
  }
}
