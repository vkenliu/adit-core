/**
 * Git command runner.
 *
 * Thin wrapper around child_process that handles timeouts,
 * error formatting, and environment variable injection
 * (especially GIT_INDEX_FILE for temp-index operations).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
}

const DEFAULT_TIMEOUT = 30_000;

/** Run a git command and return structured result */
export async function runGit(
  args: string[],
  opts: GitRunOptions,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: opts.timeout ?? DEFAULT_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const error = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(err),
      exitCode: typeof error.code === "number" ? error.code : 1,
    };
  }
}

/** Run git and throw if it fails */
export async function runGitOrThrow(
  args: string[],
  opts: GitRunOptions,
): Promise<string> {
  const result = await runGit(args, opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** Get the current HEAD SHA */
export async function getHeadSha(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "HEAD"], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Get the current branch name */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Get the remote URL for origin */
export async function getRemoteUrl(cwd: string): Promise<string | null> {
  const result = await runGit(["remote", "get-url", "origin"], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Check if a path is inside a git repository */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--git-dir"], { cwd });
  return result.exitCode === 0;
}
