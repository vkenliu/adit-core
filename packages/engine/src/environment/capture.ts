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

  // Run all version checks in parallel for speed
  const [
    branch,
    headSha,
    changes,
    nodeVersion,
    pythonVersion,
    containerInfo,
    runtimeVersions,
    shellInfo,
    packageManagerInfo,
  ] = await Promise.all([
    getCurrentBranch(cwd),
    getHeadSha(cwd),
    getChangedFiles(cwd),
    getVersion("node", ["--version"]),
    getVersion("python3", ["--version"]),
    detectContainer(),
    detectRuntimeVersions(),
    detectShellInfo(),
    detectPackageManager(cwd),
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
    nodeVersion,
    pythonVersion,
    osInfo: `${platform()} ${release()}`,
    containerInfo: containerInfo ? JSON.stringify(containerInfo) : null,
    runtimeVersionsJson: runtimeVersions ? JSON.stringify(runtimeVersions) : null,
    shellInfo: shellInfo ? JSON.stringify(shellInfo) : null,
    systemResourcesJson: JSON.stringify(systemResources),
    packageManagerJson: packageManagerInfo ? JSON.stringify(packageManagerInfo) : null,
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
