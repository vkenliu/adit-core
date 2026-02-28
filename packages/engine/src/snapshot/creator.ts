/**
 * Snapshot creator using temporary Git index.
 *
 * Creates git commit snapshots WITHOUT touching the user's staging area.
 * This is the key technique from Rewindo: we set GIT_INDEX_FILE to a
 * temp file, stage all changes there, create a tree+commit, and store
 * it as a ref. The user's real index is never modified.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { runGit, runGitOrThrow } from "../git/runner.js";
import { getChangedFiles, type FileChange } from "../detector/working-tree.js";
import { getNumstat } from "../detector/working-tree.js";

export interface SnapshotResult {
  /** The commit SHA of the snapshot */
  sha: string;
  /** The ref path where it's stored */
  ref: string;
  /** Files included in the snapshot */
  files: Array<{
    path: string;
    status: string;
    additions?: number;
    deletions?: number;
  }>;
}

/** Create a snapshot of the current working tree state */
export async function createSnapshot(
  cwd: string,
  parentSha: string | null,
  message: string,
  refPath: string,
  preComputedChanges?: FileChange[],
): Promise<SnapshotResult | null> {
  // Reuse pre-computed changes when the caller already ran git status
  const changes = preComputedChanges ?? await getChangedFiles(cwd);
  if (changes.length === 0) return null;

  // Create temp index file
  const tempIndex = join(
    tmpdir(),
    `adit-index-${randomBytes(8).toString("hex")}`,
  );
  const env = { GIT_INDEX_FILE: tempIndex };

  try {
    // Start from HEAD's tree in the temp index
    await runGit(["read-tree", "HEAD"], { cwd, env });

    // Stage all changes into temp index
    await stageChanges(cwd, changes, env);

    // Write tree object
    const treeSha = await runGitOrThrow(["write-tree"], { cwd, env });

    // Create commit object
    const commitArgs = ["commit-tree", treeSha, "-m", message];
    if (parentSha) {
      commitArgs.splice(2, 0, "-p", parentSha);
    }
    const commitSha = await runGitOrThrow(commitArgs, { cwd, env });

    // Store as a ref
    await runGitOrThrow(["update-ref", refPath, commitSha], { cwd });

    // Get file stats
    const numstat = await getNumstat(cwd, parentSha ?? undefined);
    const files = changes.map((c) => {
      const stat = numstat.find((n) => n.path === c.path);
      return {
        path: c.path,
        status: c.status,
        additions: stat?.additions,
        deletions: stat?.deletions,
      };
    });

    return { sha: commitSha, ref: refPath, files };
  } finally {
    // Always clean up temp index
    if (existsSync(tempIndex)) {
      try {
        unlinkSync(tempIndex);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

/** Stage file changes into a (possibly temp) index */
async function stageChanges(
  cwd: string,
  changes: FileChange[],
  env: Record<string, string>,
): Promise<void> {
  // Batch into at most 2 git commands instead of N sequential spawns.
  const toDelete = changes.filter((c) => c.status === "D").map((c) => c.path);
  const toAdd = changes.filter((c) => c.status !== "D").map((c) => c.path);

  if (toDelete.length > 0) {
    await runGit(["rm", "--cached", "--", ...toDelete], { cwd, env });
  }
  if (toAdd.length > 0) {
    await runGit(["add", "--", ...toAdd], { cwd, env });
  }
}

/** Get the unified diff between a checkpoint and its parent */
export async function getCheckpointDiff(
  cwd: string,
  sha: string,
  parentSha?: string,
  filePath?: string,
): Promise<string> {
  const args = parentSha
    ? ["diff", parentSha, sha]
    : ["diff", `${sha}^`, sha];

  if (filePath) {
    args.push("--", filePath);
  }

  const result = await runGit(args, { cwd });
  return result.stdout;
}
