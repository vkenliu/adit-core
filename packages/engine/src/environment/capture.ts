/**
 * Environment snapshot capture.
 *
 * Captures the execution context beyond just code:
 * git state, dependency versions, runtime versions,
 * container info, system resources, and more.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { platform, release, cpus, totalmem, freemem, arch } from "node:os";
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

/**
 * Cache for slow version-detection results that rarely change within a session.
 * Keyed by session ID, expires after 5 minutes to pick up mid-session changes.
 */
interface CachedVersions {
  nodeVersion: string | null;
  pythonVersion: string | null;
  containerInfo: { inDocker: boolean; image?: string } | null;
  runtimeVersions: Record<string, string> | null;
  shellInfo: { shell: string; version?: string } | null;
  packageManagerInfo: { name: string; version: string } | null;
  cachedAt: number;
}

const ENV_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const versionCache = new Map<string, CachedVersions>();

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

  // Use cached version data if available and fresh (within TTL).
  // Version detections (node, python, runtimes, shell, package manager, container)
  // rarely change within a session, so we cache them to avoid spawning
  // multiple child processes on every hook event.
  const now = Date.now();
  let cached = versionCache.get(sessionId);
  if (!cached || now - cached.cachedAt > ENV_CACHE_TTL_MS) {
    // Cache miss or expired — run all version detections in parallel
    const [nodeV, pythonV, container, runtimes, shell, pkgMgr] = await Promise.all([
      getVersion("node", ["--version"]),
      getVersion("python3", ["--version"]),
      detectContainer(),
      detectRuntimeVersions(),
      detectShellInfo(),
      detectPackageManager(cwd),
    ]);

    cached = {
      nodeVersion: nodeV,
      pythonVersion: pythonV,
      containerInfo: container,
      runtimeVersions: runtimes,
      shellInfo: shell,
      packageManagerInfo: pkgMgr,
      cachedAt: now,
    };
    versionCache.set(sessionId, cached);
  }

  // Always capture fresh git state and working tree (these change between events)
  const [branch, headSha, changes] = await Promise.all([
    getCurrentBranch(cwd),
    getHeadSha(cwd),
    getChangedFiles(cwd),
  ]);

  const modifiedFiles = changes.map((c) => c.path);
  const lockfile = findLockfile(cwd);
  const safeEnvVars = captureSafeEnvVars();
  const systemResources = captureSystemResources();

  insertEnvSnapshot(db, {
    id,
    sessionId,
    gitBranch: branch ?? "unknown",
    gitHeadSha: headSha ?? "unknown",
    modifiedFiles: JSON.stringify(modifiedFiles),
    depLockHash: lockfile ? hashFile(join(cwd, lockfile)) : null,
    depLockPath: lockfile,
    envVarsJson: JSON.stringify(safeEnvVars),
    nodeVersion: cached.nodeVersion,
    pythonVersion: cached.pythonVersion,
    osInfo: `${platform()} ${release()}`,
    containerInfo: cached.containerInfo ? JSON.stringify(cached.containerInfo) : null,
    runtimeVersionsJson: cached.runtimeVersions ? JSON.stringify(cached.runtimeVersions) : null,
    shellInfo: cached.shellInfo ? JSON.stringify(cached.shellInfo) : null,
    systemResourcesJson: JSON.stringify(systemResources),
    packageManagerJson: cached.packageManagerInfo ? JSON.stringify(cached.packageManagerInfo) : null,
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

/** Detect Docker/container environment */
async function detectContainer(): Promise<{ inDocker: boolean; image?: string } | null> {
  const inDocker = existsSync("/.dockerenv");
  if (inDocker) {
    return { inDocker: true };
  }

  // Check cgroup for container indicators
  try {
    const content = readFileSync("/proc/1/cgroup", "utf-8");
    if (content.includes("docker") || content.includes("containerd") || content.includes("kubepods")) {
      return { inDocker: true };
    }
  } catch {
    // Not in a container or no access to cgroup
  }

  return null;
}

/** Detect additional runtime versions */
async function detectRuntimeVersions(): Promise<Record<string, string> | null> {
  const checks = [
    { name: "rust", cmd: "rustc", args: ["--version"] },
    { name: "cargo", cmd: "cargo", args: ["--version"] },
    { name: "go", cmd: "go", args: ["version"] },
    { name: "java", cmd: "java", args: ["--version"] },
    { name: "ruby", cmd: "ruby", args: ["--version"] },
  ];

  const results: Record<string, string> = {};

  await Promise.allSettled(
    checks.map(async ({ name, cmd, args }) => {
      const version = await getVersion(cmd, args);
      if (version) results[name] = version;
    }),
  );

  return Object.keys(results).length > 0 ? results : null;
}

/** Detect shell information */
async function detectShellInfo(): Promise<{ shell: string; version?: string } | null> {
  const shell = process.env.SHELL;
  if (!shell) return null;

  const version = await getVersion(shell, ["--version"]);
  return { shell, version: version ?? undefined };
}

/** Capture system resource information */
function captureSystemResources(): {
  arch: string;
  cpuModel: string;
  totalMem: number;
  freeMem: number;
} {
  const cpuList = cpus();
  return {
    arch: arch(),
    cpuModel: cpuList[0]?.model ?? "unknown",
    totalMem: totalmem(),
    freeMem: freemem(),
  };
}

/** Detect package manager and version */
async function detectPackageManager(
  cwd: string,
): Promise<{ name: string; version: string } | null> {
  const lockfileMap: Record<string, { name: string; cmd: string }> = {
    "pnpm-lock.yaml": { name: "pnpm", cmd: "pnpm" },
    "yarn.lock": { name: "yarn", cmd: "yarn" },
    "bun.lockb": { name: "bun", cmd: "bun" },
    "package-lock.json": { name: "npm", cmd: "npm" },
  };

  for (const [lockfile, info] of Object.entries(lockfileMap)) {
    if (existsSync(join(cwd, lockfile))) {
      const version = await getVersion(info.cmd, ["--version"]);
      if (version) {
        return { name: info.name, version };
      }
    }
  }

  return null;
}
