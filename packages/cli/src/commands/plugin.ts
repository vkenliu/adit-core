/**
 * `adit plugin` — Platform plugin management commands.
 *
 * Install, uninstall, list, and validate ADIT integrations
 * for different AI platforms. All commands auto-detect which
 * platforms are present in the project (by checking for config
 * directories like .claude/ and .opencode/) when no explicit
 * platform argument is given.
 */

import { existsSync, rmSync } from "node:fs";
import { loadConfig, findGitRoot } from "@adit/core";
import {
  getAdapter,
  listAdapters,
  detectPlatforms,
  resolveAditHookBinary,
  type PlatformAdapter,
} from "@adit/hooks/adapters";
import type { Platform } from "@adit/core";

/**
 * Resolve the project root from config, preferring git root for
 * directory-based platform detection.
 */
function resolveProjectRoot(): string {
  const config = loadConfig();
  return findGitRoot(config.projectRoot) ?? config.projectRoot;
}

/** adit plugin install [platform] */
export async function pluginInstallCommand(
  platformArg?: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const projectRoot = resolveProjectRoot();
  const aditBinaryPath = resolveAditHookBinary();

  // If explicit platform, install just that one
  if (platformArg) {
    const platform = platformArg as Platform;
    const adapter = getAdapterSafe(platform);
    if (!adapter) return;
    await installSinglePlatform(adapter, config.projectRoot, aditBinaryPath, opts);
    return;
  }

  // Auto-detect all platforms present in the project
  const platforms = detectPlatforms(projectRoot);

  if (platforms.length === 0) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        action: "install",
        error: "No AI platforms detected",
        platforms: [],
      }));
    } else {
      console.log();
      console.log("  No AI platforms detected in this project.");
      console.log();
      console.log("  ADIT looks for platform config directories:");
      console.log("    Claude Code  →  .claude/");
      console.log("    OpenCode     →  .opencode/  or  opencode.json");
      console.log();
      console.log("  To install for a specific platform:");
      console.log("    adit plugin install claude-code");
      console.log("    adit plugin install opencode");
      console.log();
    }
    return;
  }

  // Install for all detected platforms
  const installed: string[] = [];
  const errors: string[] = [];

  if (!opts?.json) {
    console.log();
    console.log(`  Installing ADIT hooks (${platforms.length} platform${platforms.length > 1 ? "s" : ""} detected)`);
    console.log();
  }

  for (const platform of platforms) {
    const adapter = getAdapterSafe(platform);
    if (!adapter) continue;

    if (adapter.hookMappings.length === 0) {
      if (!opts?.json) {
        console.log(`  [-] ${adapter.displayName} — detected but not yet supported`);
      }
      continue;
    }

    try {
      await adapter.installHooks(config.projectRoot, aditBinaryPath);
      installed.push(adapter.displayName);

      if (!opts?.json) {
        console.log(`  [+] ${adapter.displayName} — ${adapter.hookMappings.length} hook events`);

        // Show validation checks
        const result = await adapter.validateInstallation(config.projectRoot);
        for (const check of result.checks) {
          const symbol = check.ok ? "+" : "x";
          console.log(`      [${symbol}] ${check.name}`);
        }
      }
    } catch (err) {
      errors.push(`${adapter.displayName}: ${(err as Error).message}`);
      if (!opts?.json) {
        console.log(`  [x] ${adapter.displayName} — ${(err as Error).message}`);
      }
    }
  }

  if (opts?.json) {
    console.log(JSON.stringify({
      ok: errors.length === 0 && installed.length > 0,
      action: "install",
      installed,
      errors: errors.length > 0 ? errors : undefined,
    }));
  } else {
    console.log();
    if (installed.length > 0) {
      console.log(`  Done! Installed for: ${installed.join(", ")}`);
    } else {
      console.log("  No hooks were installed.");
    }
    if (errors.length > 0) {
      for (const err of errors) {
        console.log(`  Error: ${err}`);
      }
    }
    console.log();
  }
}

/** Install hooks for a single explicit platform */
async function installSinglePlatform(
  adapter: PlatformAdapter,
  projectRoot: string,
  aditBinaryPath: string,
  opts?: { json?: boolean },
): Promise<void> {
  try {
    await adapter.installHooks(projectRoot, aditBinaryPath);

    if (opts?.json) {
      console.log(JSON.stringify({
        ok: true,
        platform: adapter.platform,
        action: "install",
      }));
    } else {
      console.log();
      console.log(`  [+] Installed ADIT hooks for ${adapter.displayName}`);
      console.log();

      // Validate after install
      const result = await adapter.validateInstallation(projectRoot);
      for (const check of result.checks) {
        const symbol = check.ok ? "+" : "x";
        console.log(`      [${symbol}] ${check.name}: ${check.detail}`);
      }
      console.log();
    }
  } catch (err) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        platform: adapter.platform,
        action: "install",
        error: (err as Error).message,
      }));
    } else {
      console.error(`  [x] Failed to install hooks for ${adapter.displayName}: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

/** adit plugin uninstall [platform] */
export async function pluginUninstallCommand(
  platformArg?: string,
  opts?: { json?: boolean; all?: boolean; clean?: boolean },
): Promise<void> {
  const config = loadConfig();
  const projectRoot = resolveProjectRoot();

  // --all: uninstall every installed platform (legacy behavior preserved)
  if (opts?.all) {
    await uninstallAll(config.projectRoot, config.dataDir, opts);
    return;
  }

  // Explicit platform: uninstall just that one
  if (platformArg) {
    const platform = platformArg as Platform;
    const adapter = getAdapterSafe(platform);
    if (!adapter) return;
    await uninstallSinglePlatform(adapter, config.projectRoot, config.dataDir, opts);
    return;
  }

  // No arg, no --all: auto-detect and uninstall all detected/installed platforms
  // First check which platforms are actually installed
  const detectedPlatforms = detectPlatforms(projectRoot);
  const allAdapters = listAdapters().filter((a) => a.hookMappings.length > 0);

  // Combine: check detected platforms + any currently-installed platform
  const toCheck = new Map<string, PlatformAdapter>();
  for (const p of detectedPlatforms) {
    const adapter = getAdapterSafe(p);
    if (adapter && adapter.hookMappings.length > 0) {
      toCheck.set(adapter.platform, adapter);
    }
  }
  for (const adapter of allAdapters) {
    if (!toCheck.has(adapter.platform)) {
      try {
        const result = await adapter.validateInstallation(config.projectRoot);
        if (result.valid) {
          toCheck.set(adapter.platform, adapter);
        }
      } catch {
        // ignore
      }
    }
  }

  if (toCheck.size === 0) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: true,
        action: "uninstall",
        uninstalled: [],
      }));
    } else {
      console.log();
      console.log("  No ADIT hooks found to remove.");
      console.log();
    }
    return;
  }

  const uninstalled: string[] = [];
  const errors: string[] = [];

  if (!opts?.json) {
    console.log();
  }

  for (const adapter of toCheck.values()) {
    try {
      const result = await adapter.validateInstallation(config.projectRoot);
      if (result.valid) {
        await adapter.uninstallHooks(config.projectRoot);
        uninstalled.push(adapter.displayName);
        if (!opts?.json) {
          console.log(`  [~] Removed ${adapter.displayName} hooks`);
        }
      }
    } catch (err) {
      errors.push(`${adapter.displayName}: ${(err as Error).message}`);
    }
  }

  // Optionally remove .adit/ data directory
  let dataRemoved = false;
  if (opts?.clean && existsSync(config.dataDir)) {
    try {
      rmSync(config.dataDir, { recursive: true, force: true });
      dataRemoved = true;
    } catch (err) {
      errors.push(`Failed to remove data directory: ${(err as Error).message}`);
    }
  }

  if (opts?.json) {
    console.log(JSON.stringify({
      ok: errors.length === 0,
      action: "uninstall",
      uninstalled,
      dataRemoved,
      errors: errors.length > 0 ? errors : undefined,
    }));
  } else {
    if (uninstalled.length === 0) {
      console.log("  No ADIT hooks found to remove.");
    }
    if (dataRemoved) {
      console.log(`  [~] Removed data directory: ${config.dataDir}`);
    }
    for (const err of errors) {
      console.error(`  [x] ${err}`);
    }
    console.log();
  }
}

/** Uninstall hooks for ALL installed platforms (--all flag) */
async function uninstallAll(
  projectRoot: string,
  dataDir: string,
  opts?: { json?: boolean; clean?: boolean },
): Promise<void> {
  const uninstalled: string[] = [];
  const errors: string[] = [];

  if (!opts?.json) {
    console.log();
  }

  for (const adapter of listAdapters()) {
    if (adapter.hookMappings.length === 0) continue;
    try {
      const result = await adapter.validateInstallation(projectRoot);
      if (result.valid) {
        await adapter.uninstallHooks(projectRoot);
        uninstalled.push(adapter.displayName);
        if (!opts?.json) {
          console.log(`  [~] Removed ${adapter.displayName} hooks`);
        }
      }
    } catch (err) {
      errors.push(`${adapter.platform}: ${(err as Error).message}`);
    }
  }

  // Optionally remove .adit/ data directory
  let dataRemoved = false;
  if (opts?.clean && existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      dataRemoved = true;
    } catch (err) {
      errors.push(`Failed to remove data directory: ${(err as Error).message}`);
    }
  }

  if (opts?.json) {
    console.log(JSON.stringify({
      ok: errors.length === 0,
      action: "uninstall",
      uninstalled,
      dataRemoved,
      errors: errors.length > 0 ? errors : undefined,
    }));
  } else {
    if (uninstalled.length === 0) {
      console.log("  No ADIT hooks found to remove.");
    }
    if (dataRemoved) {
      console.log(`  [~] Removed data directory: ${dataDir}`);
    }
    for (const err of errors) {
      console.error(`  [x] ${err}`);
    }
    console.log();
  }
}

/** Uninstall hooks for a single explicit platform */
async function uninstallSinglePlatform(
  adapter: PlatformAdapter,
  projectRoot: string,
  dataDir: string,
  opts?: { json?: boolean; clean?: boolean },
): Promise<void> {
  try {
    await adapter.uninstallHooks(projectRoot);

    // Optionally remove .adit/ data directory
    let dataRemoved = false;
    if (opts?.clean && existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
      dataRemoved = true;
    }

    if (opts?.json) {
      console.log(JSON.stringify({
        ok: true,
        platform: adapter.platform,
        action: "uninstall",
        dataRemoved,
      }));
    } else {
      console.log();
      console.log(`  [~] Removed ${adapter.displayName} hooks`);
      if (dataRemoved) {
        console.log(`  [~] Removed data directory: ${dataDir}`);
      }
      console.log();
    }
  } catch (err) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        platform: adapter.platform,
        action: "uninstall",
        error: (err as Error).message,
      }));
    } else {
      console.error(`  [x] Failed to remove hooks for ${adapter.displayName}: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}

/** adit plugin list */
export async function pluginListCommand(
  opts?: { json?: boolean },
): Promise<void> {
  const adapters = listAdapters();
  const projectRoot = resolveProjectRoot();

  if (opts?.json) {
    const results = [];
    for (const a of adapters) {
      const isImplemented = a.hookMappings.length > 0;
      let isInstalled = false;
      if (isImplemented) {
        try {
          const result = await a.validateInstallation(projectRoot);
          isInstalled = result.valid;
        } catch {
          // ignore
        }
      }
      results.push({
        platform: a.platform,
        displayName: a.displayName,
        implemented: isImplemented,
        installed: isInstalled,
        hooks: a.hookMappings.map((m) => m.platformEvent),
      });
    }
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log();
  console.log("  Available Platforms");
  console.log("  ------------------");
  console.log();

  for (const adapter of adapters) {
    const isImplemented = adapter.hookMappings.length > 0;
    let status = "not yet supported";

    if (isImplemented) {
      try {
        const result = await adapter.validateInstallation(projectRoot);
        status = result.valid ? "installed" : "available";
      } catch {
        status = "available";
      }
    }

    const statusIcon =
      status === "installed" ? "+" :
      status === "available" ? " " : "-";

    console.log(`  [${statusIcon}] ${adapter.displayName} (${adapter.platform})`);
    if (isImplemented) {
      console.log(`      ${adapter.hookMappings.length} hook events: ${adapter.hookMappings.map((m) => m.platformEvent).join(", ")}`);
    } else {
      console.log(`      Stub — contributions welcome`);
    }
  }

  console.log();
  console.log("  [+] installed  [ ] available  [-] not yet supported");
  console.log();
}

/** adit plugin validate [platform] */
export async function pluginValidateCommand(
  platformArg?: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const projectRoot = resolveProjectRoot();

  // If explicit platform, validate just that one
  if (platformArg) {
    const platform = platformArg as Platform;
    const adapter = getAdapterSafe(platform);
    if (!adapter) return;
    await validateSinglePlatform(adapter, config.projectRoot, opts);
    return;
  }

  // Auto-detect and validate all detected platforms
  const platforms = detectPlatforms(projectRoot);
  if (platforms.length === 0) {
    if (opts?.json) {
      console.log(JSON.stringify({ platforms: [], valid: false }));
    } else {
      console.log();
      console.log("  No AI platforms detected in this project.");
      console.log("  Run 'adit plugin validate <platform>' for a specific platform.");
      console.log();
    }
    return;
  }

  const results: Array<{
    platform: string;
    displayName: string;
    valid: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  }> = [];

  if (!opts?.json) {
    console.log();
  }

  for (const platform of platforms) {
    const adapter = getAdapterSafe(platform);
    if (!adapter) continue;
    if (adapter.hookMappings.length === 0) continue;

    const result = await adapter.validateInstallation(config.projectRoot);
    results.push({
      platform: adapter.platform,
      displayName: adapter.displayName,
      valid: result.valid,
      checks: result.checks,
    });

    if (!opts?.json) {
      console.log(`  ${adapter.displayName}`);
      for (const check of result.checks) {
        const symbol = check.ok ? "+" : "x";
        console.log(`    [${symbol}] ${check.name}: ${check.detail}`);
      }
      console.log(result.valid ? "    All checks passed." : "    Some checks failed.");
      console.log();
    }
  }

  if (opts?.json) {
    const allValid = results.every((r) => r.valid);
    console.log(JSON.stringify({ platforms: results, valid: allValid }, null, 2));
  }
}

/** Validate a single platform */
async function validateSinglePlatform(
  adapter: PlatformAdapter,
  projectRoot: string,
  opts?: { json?: boolean },
): Promise<void> {
  const result = await adapter.validateInstallation(projectRoot);

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log();
  console.log(`  Plugin validation: ${adapter.displayName}`);
  console.log();
  for (const check of result.checks) {
    const symbol = check.ok ? "+" : "x";
    console.log(`  [${symbol}] ${check.name}: ${check.detail}`);
  }
  console.log(result.valid ? "\n  All checks passed." : "\n  Some checks failed.");
  console.log();
}

function getAdapterSafe(platform: Platform): PlatformAdapter | null {
  try {
    return getAdapter(platform);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
