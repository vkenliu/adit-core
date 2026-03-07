/**
 * `adit snapshot resume [branch]` — Resume an AI development session.
 *
 * Restores the working tree to the latest checkpoint on a branch,
 * records a resume event, and prints platform-specific continue
 * commands so the user can pick up where they left off.
 *
 * Flow:
 *  1. Determine the target branch (argument or current branch)
 *  2. Switch branches if needed
 *  3. Find the latest checkpoint for that branch
 *  4. Warn about dirty working tree + dependency changes
 *  5. Restore files from the checkpoint
 *  6. Record a "resume" event in the timeline
 *  7. Print session context and agent-specific continue commands
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  getLatestCheckpointByBranch,
  getRecentCheckpointsExcludingBranch,
  getSessionById,
  getEventsBySession,
} from "@adit/core";
import type { AditEvent, AditSession } from "@adit/core";
import {
  createTimelineManager,
  hasUncommittedChanges,
  getCurrentBranch,
  getHeadSha,
  branchExists,
  shaExists,
  runGitOrThrow,
} from "@adit/engine";
import { listAdapters } from "@adit/hooks/adapters";
import { getEventSummary } from "../utils/summary.js";
import {
  checkDependencyChanges,
  printDependencyWarnings,
} from "./revert.js";

export interface ResumeOptions {
  yes?: boolean;
}

/**
 * Resume an AI development session from the latest checkpoint on a branch.
 *
 * When called without a branch argument, resumes from the latest checkpoint
 * on the current branch. When a branch is specified, switches to that branch
 * first (if not already on it) then restores the checkpoint.
 */
export async function resumeCommand(
  branch: string | undefined,
  opts: ResumeOptions,
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);
  const cwd = config.projectRoot;

  try {
    // 1. Determine target branch
    const currentBranch = await getCurrentBranch(cwd);
    const targetBranch = branch ?? currentBranch;

    if (!targetBranch) {
      console.error("Cannot determine target branch. Specify one: adit snapshot resume <branch>");
      process.exit(1);
    }

    // 2. Switch branches if needed
    if (branch && branch !== currentBranch) {
      if (!opts.yes) {
        const dirty = await hasUncommittedChanges(cwd);
        if (dirty) {
          console.error(
            "You have uncommitted changes. Commit or stash them before switching branches,\n" +
            "or use --yes to force (changes will be lost).",
          );
          process.exit(1);
        }
      }

      console.log(`Switching to branch: ${branch}`);
      await runGitOrThrow(["checkout", branch], { cwd });
    }

    // 3. Find latest checkpoint on the target branch.
    //    If none found, try a squash-merge fallback: search for checkpoints
    //    on branches that no longer exist locally (likely squash-merged into
    //    the current branch and then deleted).
    let checkpoint = getLatestCheckpointByBranch(db, targetBranch);
    let isSquashMergeResume = false;

    if (!checkpoint) {
      const candidates = getRecentCheckpointsExcludingBranch(db, targetBranch, 10);

      // Filter to candidates whose original branch no longer exists
      // (deleted after squash merge) and whose checkpoint SHA is still reachable
      for (const candidate of candidates) {
        if (!candidate.gitBranch || !candidate.checkpointSha) continue;

        const branchStillExists = await branchExists(cwd, candidate.gitBranch);
        if (branchStillExists) continue; // branch still exists — not a squash merge

        const shaReachable = await shaExists(cwd, candidate.checkpointSha);
        if (!shaReachable) continue; // checkpoint object was garbage collected

        checkpoint = candidate;
        isSquashMergeResume = true;
        break;
      }
    }

    if (!checkpoint) {
      console.error(`No checkpoints found on branch "${targetBranch}".`);
      console.error("Work with your AI agent to create checkpoints first.");
      process.exit(1);
    }

    if (isSquashMergeResume) {
      console.log(
        `No checkpoints on "${targetBranch}", but found one from merged branch "${checkpoint.gitBranch}".`,
      );
      console.log("Resuming from squash-merged branch checkpoint.\n");
    }

    // 4. Warn about dirty working tree
    if (!opts.yes) {
      const dirty = await hasUncommittedChanges(cwd);
      if (dirty) {
        console.log(
          "Warning: You have uncommitted changes. They will be overwritten on resume.",
        );
        console.log("Use --yes to skip this warning.\n");
      }
    }

    // 5. Verify checkpoint SHA is still reachable (protects against GC'd objects)
    if (checkpoint.checkpointSha) {
      const reachable = await shaExists(cwd, checkpoint.checkpointSha);
      if (!reachable) {
        console.error(
          `Checkpoint ${checkpoint.checkpointSha.substring(0, 8)} is no longer reachable in the git object store.`,
        );
        console.error("The checkpoint ref may have been deleted and the object garbage collected.");
        process.exit(1);
      }
    }

    // 6. Check dependency file changes
    const headSha = await getHeadSha(cwd);
    if (headSha && checkpoint.checkpointSha) {
      const depChanges = await checkDependencyChanges(
        cwd,
        headSha,
        checkpoint.checkpointSha,
      );
      printDependencyWarnings(depChanges);
    }

    // 7. Restore working tree from checkpoint
    await timeline.revertTo(checkpoint.id);

    // 8. Record a resume event in the timeline
    const resumeSource = isSquashMergeResume
      ? `Resumed from squash-merged branch "${checkpoint.gitBranch}" checkpoint ${checkpoint.checkpointSha?.substring(0, 8)}`
      : `Resumed from checkpoint ${checkpoint.checkpointSha?.substring(0, 8)} on branch ${targetBranch}`;
    await timeline.recordEvent({
      sessionId: checkpoint.sessionId,
      eventType: "revert",
      actor: "user",
      responseText: resumeSource,
    });

    // 9. Print resume summary
    printResumeSummary(checkpoint, targetBranch, cwd, isSquashMergeResume);

    // 10. Print session context (last few events from the original session)
    printSessionContext(db, checkpoint);

    // 11. Print platform-specific continue commands
    printContinueCommands(cwd, checkpoint);
  } finally {
    closeDatabase(db);
  }
}

/** Print the resume header with checkpoint info */
function printResumeSummary(
  checkpoint: AditEvent,
  branch: string,
  _cwd: string,
  isSquashMerge = false,
): void {
  const sha = checkpoint.checkpointSha?.substring(0, 8) ?? "????????";
  const time = checkpoint.startedAt
    ? new Date(checkpoint.startedAt).toLocaleString()
    : "unknown time";
  const summary = getEventSummary(checkpoint, 80);

  console.log("\n--- Session Resumed ---\n");
  console.log(`  Branch:     ${branch}`);
  if (isSquashMerge && checkpoint.gitBranch) {
    console.log(`  Merged from: ${checkpoint.gitBranch}`);
  }
  console.log(`  Checkpoint: ${sha}`);
  console.log(`  Time:       ${time}`);
  console.log(`  Summary:    ${summary}`);

  // File stats
  if (checkpoint.diffStatJson) {
    try {
      const stats = JSON.parse(checkpoint.diffStatJson) as Array<{ path?: string }>;
      console.log(`  Files:      ${stats.length} file${stats.length === 1 ? "" : "s"} restored`);
    } catch {
      // best-effort
    }
  }

  console.log();
}

/** Print recent events from the session for context */
function printSessionContext(
  db: ReturnType<typeof openDatabase>,
  checkpoint: AditEvent,
): void {
  const session = getSessionById(db, checkpoint.sessionId);
  if (!session) return;

  const events = getEventsBySession(db, checkpoint.sessionId, 100);
  if (events.length === 0) return;

  // Find the checkpoint's position and show the last few events before it
  const checkpointIdx = events.findIndex((e) => e.id === checkpoint.id);
  const contextStart = Math.max(0, checkpointIdx - 4);
  const contextEnd = checkpointIdx + 1;
  const contextEvents = events.slice(contextStart, contextEnd);

  if (contextEvents.length === 0) return;

  console.log("Recent session activity:");
  for (const event of contextEvents) {
    const marker = event.id === checkpoint.id ? " <-- resumed here" : "";
    const actor = event.actor === "assistant" ? "AI" : event.actor === "user" ? "You" : event.actor;
    const summary = getEventSummary(event, 60);
    console.log(`  [${actor}] ${summary}${marker}`);
  }
  console.log();

  // Print session platform info
  printSessionInfo(session);
}

/** Print session metadata (platform, duration) */
function printSessionInfo(session: AditSession): void {
  const platform = session.platform;
  const started = new Date(session.startedAt).toLocaleString();

  let metadata: { gitBranch?: string } | null = null;
  if (session.metadataJson) {
    try {
      metadata = JSON.parse(session.metadataJson);
    } catch {
      // best-effort
    }
  }

  console.log(`Session: ${session.id.substring(0, 10)}... (${platform})`);
  console.log(`  Started: ${started}`);
  if (metadata?.gitBranch) {
    console.log(`  Branch:  ${metadata.gitBranch}`);
  }
  console.log();
}

/** Detect installed platforms and print agent-specific continue commands */
function printContinueCommands(cwd: string, _checkpoint: AditEvent): void {
  const adapters = listAdapters();
  const commands: Array<{ platform: string; command: string }> = [];

  for (const adapter of adapters) {
    if (adapter.getResumeCommand) {
      const cmd = adapter.getResumeCommand(cwd);
      if (cmd) {
        commands.push({ platform: adapter.displayName, command: cmd });
      }
    }
  }

  if (commands.length === 0) {
    console.log("Start your AI agent to continue working.");
    return;
  }

  console.log("To continue, run one of:");
  for (const { platform, command } of commands) {
    console.log(`  ${platform}: ${command}`);
  }
  console.log();
}
