/**
 * Environment snapshot types.
 *
 * Captures the execution context at a point in time —
 * not just code, but the world around it.
 */

export interface EnvSnapshot {
  /** ULID */
  id: string;
  sessionId: string;
  gitBranch: string;
  gitHeadSha: string;
  /** JSON array of modified file paths */
  modifiedFiles: string | null;
  /** Hash of the dependency lockfile */
  depLockHash: string | null;
  /** Which lockfile (package-lock.json, pnpm-lock.yaml, etc.) */
  depLockPath: string | null;
  /** Selected safe environment variables */
  envVarsJson: string | null;
  nodeVersion: string | null;
  pythonVersion: string | null;
  osInfo: string | null;
  capturedAt: string;
  /** Vector clock */
  vclockJson: string;
  /** Soft delete */
  deletedAt: string | null;
}
