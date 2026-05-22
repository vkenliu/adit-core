/**
 * `adit self-update` — Update ADIT to the latest version.
 *
 * Detects the installation directory (source-install via git clone),
 * pulls the latest changes, rebuilds, and re-registers commands.
 * Falls back to re-running the install script if the install dir
 * cannot be determined.
 */

import { execSync, type ExecSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { CLI_VERSION } from "../version.js";

/** Default install location used by install.sh */
const DEFAULT_INSTALL_DIR = resolve(
  process.env.ADIT_INSTALL_DIR ?? `${process.env.HOME ?? "~"}/.adit-core`,
);

/**
 * Resolve the adit-core install directory by walking up from the
 * running CLI entry point to find the monorepo root.
 */
function resolveInstallDir(): string | null {
  // Method 1: Walk up from the running script to find the monorepo root
  // The CLI runs from <root>/packages/cli/dist/index.js
  try {
    const cliDist = dirname(process.argv[1] ?? "");
    const candidate = resolve(cliDist, "../../..");
    if (
      existsSync(resolve(candidate, "package.json")) &&
      existsSync(resolve(candidate, ".git"))
    ) {
      return candidate;
    }
  } catch {
    /* best-effort */
  }

  // Method 2: Use the default install directory
  if (
    existsSync(resolve(DEFAULT_INSTALL_DIR, "package.json")) &&
    existsSync(resolve(DEFAULT_INSTALL_DIR, ".git"))
  ) {
    return DEFAULT_INSTALL_DIR;
  }

  return null;
}

/**
 * Read the version from a package.json file.
 */
function readVersionFromPackageJson(rootDir: string): string | null {
  try {
    const pkgPath = resolve(rootDir, "packages/cli/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export async function selfUpdateCommand(opts?: {
  check?: boolean;
}): Promise<void> {
  const installDir = resolveInstallDir();

  if (!installDir) {
    console.log("Installed via npm. To update:");
    console.log("  npm update -g @varveai/adit-cli");
    return;
  }

  const execOpts: ExecSyncOptions = {
    cwd: installDir,
    stdio: "pipe",
    encoding: "utf8" as const,
  };

  // Pull latest changes
  console.log(`Checking for updates in ${installDir} ...`);

  try {
    execSync("git fetch origin", { ...execOpts, stdio: "pipe" });
  } catch (e) {
    console.error("Failed to fetch from remote:", (e as Error).message);
    process.exitCode = 1;
    return;
  }

  // Check if there are upstream changes
  let behind = 0;
  try {
    const behindStr = execSync(
      "git rev-list --count HEAD..origin/main",
      execOpts,
    ) as unknown as string;
    behind = parseInt(String(behindStr).trim(), 10) || 0;
  } catch {
    // If we can't determine, proceed with update
    behind = -1;
  }

  if (behind === 0) {
    // Check version in case local changes were made
    const latestVer = readVersionFromPackageJson(installDir);
    if (latestVer === CLI_VERSION) {
      console.log(`Already up to date (v${CLI_VERSION}).`);
      return;
    }
  }

  if (opts?.check) {
    if (behind > 0) {
      const latestVer = readVersionFromPackageJson(installDir);
      console.log(
        `Update available: v${CLI_VERSION} -> v${latestVer ?? "unknown"} (${behind} commit${behind === 1 ? "" : "s"} behind)`,
      );
    } else if (behind === 0) {
      console.log(`Already up to date (v${CLI_VERSION}).`);
    }
    return;
  }

  // Perform the update
  const showExecOpts: ExecSyncOptions = {
    ...execOpts,
    stdio: "inherit",
  };

  console.log(`Updating from v${CLI_VERSION} ...`);
  console.log();

  // Step 1: Pull
  try {
    console.log("Pulling latest changes ...");
    execSync("git pull --ff-only origin main", showExecOpts);
  } catch {
    console.error(
      "Failed to pull latest changes. You may have local modifications.",
    );
    console.error("Try: git -C " + installDir + " stash && adit self-update");
    process.exitCode = 1;
    return;
  }

  // Step 2: Install dependencies
  try {
    console.log();
    console.log("Installing dependencies ...");
    execSync("pnpm install --frozen-lockfile", {
      ...showExecOpts,
      env: { ...process.env, COREPACK_ENABLE_STRICT: "0" },
    });
  } catch {
    // Retry without frozen lockfile
    try {
      execSync("pnpm install", {
        ...showExecOpts,
        env: { ...process.env, COREPACK_ENABLE_STRICT: "0" },
      });
    } catch {
      console.error("Failed to install dependencies.");
      process.exitCode = 1;
      return;
    }
  }

  // Step 3: Build
  try {
    console.log();
    console.log("Building ...");
    execSync("pnpm build", showExecOpts);
  } catch {
    console.error("Build failed.");
    process.exitCode = 1;
    return;
  }

  // Step 4: Report
  const newVer = readVersionFromPackageJson(installDir);
  console.log();
  console.log(
    `Updated successfully: v${CLI_VERSION} -> v${newVer ?? "unknown"}`,
  );
  console.log("Run `adit doctor` to verify your installation.");
}
