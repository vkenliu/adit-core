/**
 * Git metadata collection for project link.
 *
 * Collects remote URL, branches, commit logs, and default branch
 * using the existing @adit/engine git runner. All functions are
 * fail-safe — they throw on critical errors (no git repo, no remote)
 * but return empty arrays for non-critical failures.
 */

import { runGit, getRemoteUrl } from "@adit/engine";
import type { GitBranch, GitCommit } from "./types.js";

/** Collect the remote origin URL. Throws if no remote is configured. */
export async function collectRemoteUrl(cwd: string): Promise<string> {
  const url = await getRemoteUrl(cwd);
  if (!url) {
    throw new Error("No git remote 'origin' configured. Add one with: git remote add origin <url>");
  }
  return url;
}

/**
 * Detect the default branch name.
 *
 * Tries `git symbolic-ref refs/remotes/origin/HEAD` first (reliable
 * if the remote HEAD is set). Falls back to checking for `main` then
 * `master` branch existence.
 */
export async function collectDefaultBranch(cwd: string): Promise<string | null> {
  const result = await runGit(
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    { cwd },
  );

  if (result.exitCode === 0) {
    // Returns "origin/main" — strip the "origin/" prefix
    const ref = result.stdout.trim();
    return ref.replace(/^origin\//, "");
  }

  // Fallback: check if main or master exists
  for (const branch of ["main", "master"]) {
    const check = await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd });
    if (check.exitCode === 0) return branch;
  }

  return null;
}

/**
 * Get the currently checked-out branch name.
 *
 * Uses `git branch --show-current` which returns an empty string
 * in detached HEAD state. Returns null if not on a branch or if
 * the command fails.
 */
export async function collectCurrentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(["branch", "--show-current"], { cwd });
  if (result.exitCode !== 0) return null;

  const branch = result.stdout.trim();
  return branch || null;
}

/**
 * Collect all branches (local + remote) with their HEAD SHAs.
 *
 * Remote branches are included and deduplicated — if a local branch
 * name matches a remote tracking branch, the local version is kept.
 */
export async function collectBranches(cwd: string): Promise<GitBranch[]> {
  const result = await runGit(
    ["branch", "-a", "--format=%(refname:short)|%(objectname:short)"],
    { cwd },
  );

  if (result.exitCode !== 0) return [];

  const defaultBranch = await collectDefaultBranch(cwd);
  const seen = new Map<string, GitBranch>();

  for (const line of result.stdout.trim().split("\n")) {
    if (!line) continue;
    const [rawName, headSha] = line.split("|");
    if (!rawName || !headSha) continue;

    // Normalize remote branch names: "origin/main" → "main"
    let name = rawName.trim();
    if (name.startsWith("origin/")) {
      name = name.slice("origin/".length);
    }
    // Skip HEAD pointer
    if (name === "HEAD" || name.includes("->")) continue;

    // Local branches take priority over remote tracking branches
    if (!seen.has(name) || !rawName.startsWith("origin/")) {
      seen.set(name, {
        name,
        headSha: headSha.trim(),
        isDefault: name === defaultBranch,
      });
    }
  }

  return Array.from(seen.values());
}

/**
 * Options for collecting commit logs.
 */
export interface CollectCommitOptions {
  /** Only return commits after this SHA (incremental sync). */
  sinceCommitSha?: string | null;
  /** Branch name to tag on each returned commit (legacy — prefer resolveCommitBranches). */
  branch?: string | null;
}

/**
 * Collect commit logs, optionally since a specific commit SHA.
 *
 * When `sinceCommitSha` is provided, only commits after that SHA
 * are returned (incremental sync). Otherwise, all commits are returned.
 * Commits are ordered newest-first (git log default).
 *
 * When `branch` is provided, each returned commit will have its
 * `branch` field set to that value. For accurate per-commit branch
 * assignment, use `resolveCommitBranches()` after collecting commits
 * instead of this option.
 *
 * Format uses NUL (\x00) as record delimiter and SOH (\x01) as field
 * delimiter so that pipe characters and newlines inside commit messages
 * (%B = subject + body, multi-line) are preserved without ambiguity.
 */
export async function collectCommitLogs(
  cwd: string,
  sinceCommitShaOrOptions?: string | null | CollectCommitOptions,
): Promise<GitCommit[]> {
  // Support both the old positional signature and the new options object.
  // Old: collectCommitLogs(cwd, sinceCommitSha)
  // New: collectCommitLogs(cwd, { sinceCommitSha, branch })
  let sinceCommitSha: string | null | undefined;
  let branch: string | null | undefined;

  if (
    sinceCommitShaOrOptions !== null &&
    sinceCommitShaOrOptions !== undefined &&
    typeof sinceCommitShaOrOptions === "object"
  ) {
    sinceCommitSha = sinceCommitShaOrOptions.sinceCommitSha;
    branch = sinceCommitShaOrOptions.branch;
  } else {
    sinceCommitSha = sinceCommitShaOrOptions;
  }
  // %H  = full SHA
  // %an = author name
  // %ae = author email
  // %aI = author date (ISO 8601 strict)
  // %B  = subject + body (may contain newlines)
  // %x01 = SOH field delimiter, %x00 = NUL record delimiter
  const args = ["log", "--format=%H%x01%an%x01%ae%x01%aI%x01%B%x00"];

  if (sinceCommitSha) {
    // Verify the SHA still exists (could have been force-pushed away)
    const exists = await runGit(["cat-file", "-t", sinceCommitSha], { cwd });
    if (exists.exitCode === 0) {
      args.push(`${sinceCommitSha}..HEAD`);
    }
    // If SHA doesn't exist, fall through to full log
  }

  const result = await runGit(args, { cwd, timeout: 30_000 });
  if (result.exitCode !== 0) return [];

  const commits: GitCommit[] = [];

  // Split on NUL to get individual commit records.
  // %B includes a trailing newline; we trim each record to strip it.
  for (const record of result.stdout.split("\0")) {
    const trimmed = record.trim();
    if (!trimmed) continue;

    const fields = trimmed.split("\x01");
    if (fields.length < 5) continue;

    commits.push({
      sha: fields[0],
      authorName: fields[1],
      authorEmail: fields[2],
      date: fields[3],
      // %B may contain SOH-free multi-line text; everything after the 4th
      // SOH is the message (rejoin in case of unexpected extra SOH chars).
      message: fields.slice(4).join("\x01").trim(),
      branch: branch ?? undefined,
    });
  }

  return commits;
}

/**
 * Resolve per-commit branch assignments for a set of commits.
 *
 * For each known branch, runs `git log <branch> --format=%H` to collect
 * the SHAs reachable from that branch. Commits are assigned to the most
 * specific branch (non-default branches take priority over the default
 * branch, so a commit on `feature/x` that was later merged into `main`
 * is attributed to `feature/x`).
 *
 * Only SHAs present in `commitShas` are assigned — this avoids building
 * a map for the entire repository history when doing incremental sync.
 *
 * Mutates the `branch` field of each commit in `commits` in-place and
 * also returns the same array for chaining convenience.
 */
export async function resolveCommitBranches(
  cwd: string,
  commits: GitCommit[],
  branches: GitBranch[],
  defaultBranch: string | null,
): Promise<GitCommit[]> {
  if (commits.length === 0 || branches.length === 0) return commits;

  // Build a set of SHAs we care about for fast lookup
  const targetShas = new Set(commits.map((c) => c.sha));

  // Map from SHA → branch name. Non-default branches are processed first
  // so their assignments take priority (a commit reachable from both
  // `feature/x` and `main` should be attributed to `feature/x`).
  const shaToBranch = new Map<string, string>();

  // Sort branches: default branch last so non-default branches win
  const sorted = [...branches].sort((a, b) => {
    const aIsDefault = a.name === defaultBranch ? 1 : 0;
    const bIsDefault = b.name === defaultBranch ? 1 : 0;
    return aIsDefault - bIsDefault;
  });

  for (const branch of sorted) {
    const result = await runGit(
      ["log", branch.name, "--format=%H"],
      { cwd, timeout: 30_000 },
    );
    if (result.exitCode !== 0) continue;

    for (const line of result.stdout.trim().split("\n")) {
      const sha = line.trim();
      if (!sha || !targetShas.has(sha)) continue;

      // Only assign if not already claimed by a non-default branch
      if (!shaToBranch.has(sha)) {
        shaToBranch.set(sha, branch.name);
      }
    }
  }

  // Apply resolved branches to commits
  for (const commit of commits) {
    const resolved = shaToBranch.get(commit.sha);
    if (resolved) {
      commit.branch = resolved;
    }
  }

  return commits;
}

/** Count total commits reachable from HEAD. */
export async function collectCommitCount(cwd: string): Promise<number> {
  const result = await runGit(["rev-list", "--count", "HEAD"], { cwd });
  if (result.exitCode !== 0) return 0;
  return parseInt(result.stdout.trim(), 10) || 0;
}

/**
 * Extract a project name from a git remote URL.
 *
 * Examples:
 *   "https://github.com/user/my-repo.git" → "my-repo"
 *   "git@github.com:user/my-repo.git"     → "my-repo"
 *   "https://github.com/user/my-repo"     → "my-repo"
 */
export function projectNameFromRemoteUrl(url: string): string {
  // Strip trailing .git
  const cleaned = url.replace(/\.git$/, "");

  // Handle SSH: git@host:user/repo → take last segment
  if (cleaned.includes(":") && !cleaned.includes("://")) {
    const afterColon = cleaned.split(":").pop() ?? "";
    return afterColon.split("/").pop() ?? cleaned;
  }

  // Handle HTTPS: https://host/user/repo → take last path segment
  try {
    const parsed = new URL(cleaned);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.pop() ?? cleaned;
  } catch {
    // Fallback: just take the last path segment
    return cleaned.split("/").pop() ?? cleaned;
  }
}
