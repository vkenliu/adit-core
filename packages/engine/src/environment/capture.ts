/**
 * Environment snapshot capture.
 *
 * Captures the execution context beyond just code:
 * git state, dependency versions, runtime versions, etc.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { platform, release } from "node:os";
import type Database from "better-sqlite3";
import {
  generateId,
  createClock,
  serialize,
  insertEnvSnapshot,
  type AditConfig,
} from "@adit/core";
import { getHeadSha, getCurrentBranch } from "../git/runner.js";
import { getChangedFiles } from "../detector/working-tree.js";

const execFileAsync = promisify(execFile);

/** Known lockfile names and their paths */
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Pipfile.lock",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
];

/** Safe environment variable prefixes to capture */
const SAFE_ENV_PREFIXES = [
  "NODE_",
  "NPM_",
  "PYTHON",
  "SHELL",
  "TERM",
  "LANG",
  "LC_",
  "HOME",
  "USER",
  "PATH",
];

/** Capture a full environment snapshot */
export async function captureEnvironment(
  db: Database.Database,
  config: AditConfig,
  sessionId: string,
): Promise<string> {
  const cwd = config.projectRoot;
  const id = generateId();

  const [branch, headSha, changes, nodeVersion, pythonVersion] =
    await Promise.all([
      getCurrentBranch(cwd),
      getHeadSha(cwd),
      getChangedFiles(cwd),
      getVersion("node", ["--version"]),
      getVersion("python3", ["--version"]),
    ]);

  const modifiedFiles = changes.map((c) => c.path);
  const lockfile = findLockfile(cwd);
  const safeEnvVars = captureSafeEnvVars();

  insertEnvSnapshot(db, {
    id,
    sessionId,
    gitBranch: branch ?? "unknown",
    gitHeadSha: headSha ?? "unknown",
    modifiedFiles: JSON.stringify(modifiedFiles),
    depLockHash: lockfile ? hashFile(join(cwd, lockfile)) : null,
    depLockPath: lockfile,
    envVarsJson: JSON.stringify(safeEnvVars),
    nodeVersion,
    pythonVersion,
    osInfo: `${platform()} ${release()}`,
    vclockJson: serialize(createClock(config.clientId)),
  });

  return id;
}

/** Get version string from a command */
async function getVersion(
  cmd: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Find the first matching lockfile in the project */
function findLockfile(cwd: string): string | null {
  for (const name of LOCKFILES) {
    if (existsSync(join(cwd, name))) return name;
  }
  return null;
}

/** Hash a file's contents */
function hashFile(path: string): string | null {
  try {
    const content = readFileSync(path);
    return createHash("sha256").update(content).digest("hex").substring(0, 16);
  } catch {
    return null;
  }
}

/** Capture safe environment variables (no secrets) */
function captureSafeEnvVars(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && SAFE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      result[key] = value;
    }
  }
  return result;
}
