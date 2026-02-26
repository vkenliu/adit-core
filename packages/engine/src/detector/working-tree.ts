/**
 * Working tree change detection.
 *
 * Detects modified, added, deleted, and untracked files
 * relative to HEAD or a specified base SHA.
 */

import { runGit } from "../git/runner.js";

export interface FileChange {
  path: string;
  status: "M" | "A" | "D" | "R" | "??";
  /** For renames, the original path */
  oldPath?: string;
}

export interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
}

/** Get all changed files in the working tree (staged + unstaged + untracked) */
export async function getChangedFiles(cwd: string): Promise<FileChange[]> {
  const result = await runGit(["status", "--porcelain", "-z"], { cwd });
  if (result.exitCode !== 0 || !result.stdout) return [];

  const changes: FileChange[] = [];
  const parts = result.stdout.split("\0");

  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry || entry.length < 3) {
      i++;
      continue;
    }

    const xy = entry.substring(0, 2);
    const path = entry.substring(3);

    // Rename entries have the old path as the next null-separated field
    if (xy.includes("R")) {
      const oldPath = parts[i + 1];
      changes.push({ path, status: "R", oldPath });
      i += 2;
      continue;
    }

    let status: FileChange["status"];
    if (xy === "??") {
      status = "??";
    } else if (xy.includes("D")) {
      status = "D";
    } else if (xy.includes("A")) {
      status = "A";
    } else {
      status = "M";
    }

    changes.push({ path, status });
    i++;
  }

  return changes;
}

/** Check if working tree has any uncommitted changes */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const changes = await getChangedFiles(cwd);
  return changes.length > 0;
}

/** Get line-level change stats (additions/deletions per file) */
export async function getNumstat(
  cwd: string,
  baseSha?: string,
): Promise<NumstatEntry[]> {
  const args = baseSha
    ? ["diff", "--numstat", baseSha]
    : ["diff", "--numstat"];

  const result = await runGit(args, { cwd });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [add, del, path] = line.split("\t");
      return {
        path: path ?? "",
        additions: add === "-" ? 0 : parseInt(add, 10) || 0,
        deletions: del === "-" ? 0 : parseInt(del, 10) || 0,
      };
    })
    .filter((e) => e.path);
}

/** Get a human-readable summary of changes */
export async function getChangesSummary(cwd: string): Promise<string> {
  const changes = await getChangedFiles(cwd);
  if (changes.length === 0) return "No changes";

  const counts = { M: 0, A: 0, D: 0, R: 0, "??": 0 };
  for (const c of changes) {
    counts[c.status]++;
  }

  const parts: string[] = [];
  if (counts.M) parts.push(`${counts.M} modified`);
  if (counts.A) parts.push(`${counts.A} added`);
  if (counts.D) parts.push(`${counts.D} deleted`);
  if (counts.R) parts.push(`${counts.R} renamed`);
  if (counts["??"]) parts.push(`${counts["??"]} untracked`);

  return `${changes.length} files changed: ${parts.join(", ")}`;
}

/** Check if working tree differs from a specific SHA */
export async function isDirtyFrom(
  cwd: string,
  baseSha: string,
): Promise<boolean> {
  const result = await runGit(["diff", "--stat", baseSha], { cwd });
  if (result.exitCode !== 0) return true;
  if (result.stdout.trim()) return true;

  // Also check for untracked files
  const untracked = await runGit(
    ["ls-files", "--others", "--exclude-standard"],
    { cwd },
  );
  return untracked.stdout.trim().length > 0;
}
