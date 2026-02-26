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
  /** JSON: {inDocker: bool, image?: string} */
  containerInfo: string | null;
  /** JSON: {rust?, go?, java?, ruby?, ...} */
  runtimeVersionsJson: string | null;
  /** JSON: {shell, version} */
  shellInfo: string | null;
  /** JSON: {arch, cpuModel, totalMem, freeMem, diskFree?} */
  systemResourcesJson: string | null;
  /** JSON: {name, version, globalVersion?} */
  packageManagerJson: string | null;
  capturedAt: string;
  /** Vector clock */
  vclockJson: string;
  /** Soft delete */
  deletedAt: string | null;
}

/** Structured diff between two environment snapshots */
export interface EnvDiff {
  changes: EnvChange[];
  severity: "none" | "info" | "warning" | "breaking";
}

/** A single field-level change in the environment */
export interface EnvChange {
  field: string;
  category: "git" | "dependency" | "runtime" | "system";
  oldValue: string | null;
  newValue: string | null;
  severity: "info" | "warning" | "breaking";
}
