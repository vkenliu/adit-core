/**
 * Git ref management for ADIT checkpoints.
 *
 * Checkpoints are stored under refs/adit/checkpoints/<id>
 * This keeps them entirely out of the branch history.
 */

import { runGit, runGitOrThrow } from "./runner.js";

const REF_PREFIX = "refs/adit/checkpoints";

/** Create or update a checkpoint ref */
export async function storeCheckpointRef(
  cwd: string,
  stepId: string,
  sha: string,
): Promise<void> {
  await runGitOrThrow(
    ["update-ref", `${REF_PREFIX}/${stepId}`, sha],
    { cwd },
  );
}

/** Resolve a checkpoint ref to its SHA */
export async function resolveCheckpointRef(
  cwd: string,
  stepId: string,
): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", `${REF_PREFIX}/${stepId}`],
    { cwd },
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Delete a checkpoint ref */
export async function deleteCheckpointRef(
  cwd: string,
  stepId: string,
): Promise<boolean> {
  const result = await runGit(
    ["update-ref", "-d", `${REF_PREFIX}/${stepId}`],
    { cwd },
  );
  return result.exitCode === 0;
}

/** List all checkpoint refs with their SHAs */
export async function listCheckpointRefs(
  cwd: string,
): Promise<Array<{ stepId: string; sha: string }>> {
  const result = await runGit(
    [
      "for-each-ref",
      `${REF_PREFIX}/`,
      "--format=%(refname)%00%(objectname)",
    ],
    { cwd },
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [refname, sha] = line.split("\0");
      const stepId = refname.replace(`${REF_PREFIX}/`, "");
      return { stepId, sha };
    })
    .filter((r) => r.stepId && r.sha);
}

/** Get parent SHA of a commit */
export async function getParentSha(
  cwd: string,
  sha: string,
): Promise<string | null> {
  const result = await runGit(["rev-parse", `${sha}^1`], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Get the ref prefix constant */
export function getRefPrefix(): string {
  return REF_PREFIX;
}
