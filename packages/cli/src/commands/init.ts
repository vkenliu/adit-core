/**
 * `adit init` — Initialize ADIT in the current project.
 *
 * Creates the .adit/ data directory, initializes the database,
 * and installs hooks for detected (or specified) AI platforms via adapters.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, openDatabase, closeDatabase, findGitRoot } from "@varveai/adit-core";
import type { Platform } from "@varveai/adit-core";
import { isGitRepo } from "@varveai/adit-engine";
import {
  getAdapter,
  listAdapters,
  detectPlatforms,
  resolveAditHookBinary,
} from "@varveai/adit-hooks/adapters";

export async function initCommand(opts: {
  cwd?: string;
  platform?: string;
  force?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  console.log();
  console.log("  ADIT — AI Development Intent Tracker");
  console.log("  =====================================");
  console.log();

  // Verify we're in a git repo
  if (!(await isGitRepo(cwd))) {
    console.error("  [x] Not a git repository. Run 'git init' first.");
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const gitRoot = findGitRoot(cwd) ?? cwd;

  // --- Step 1: Clean up if --force ---
  if (opts.force) {
    console.log("  Removing existing hooks (--force)...");
    for (const adapter of listAdapters()) {
      if (adapter.hookMappings.length === 0) continue;
      try {
        const result = await adapter.validateInstallation(gitRoot);
        if (result.valid) {
          await adapter.uninstallHooks(gitRoot);
          console.log(`    [~] Removed ${adapter.displayName} hooks`);
        }
      } catch {
        // best-effort cleanup
      }
    }
    console.log();
  }

  // --- Step 2: Data directory & database ---
  console.log("  Setup");
  console.log("  -----");

  mkdirSync(config.dataDir, { recursive: true });
  console.log(`  [+] Data directory: ${config.dataDir}`);

  const db = openDatabase(config.dbPath);
  closeDatabase(db);
  console.log(`  [+] Database: ${config.dbPath}`);

  // Add .adit/ to .gitignore if not already there
  const gitignorePath = join(gitRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".adit/")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.adit/\n");
      console.log("  [+] Added .adit/ to .gitignore");
    } else {
      console.log("  [+] .gitignore already includes .adit/");
    }
  } else {
    writeFileSync(gitignorePath, ".adit/\n");
    console.log("  [+] Created .gitignore with .adit/");
  }

  // --- Step 3: Platform detection & hook installation ---
  console.log();
  console.log("  Platforms");
  console.log("  ---------");

  const aditBinaryPath = resolveAditHookBinary();
  const installed: string[] = [];
  const skipped: string[] = [];

  if (opts.platform) {
    // Explicit platform specified
    const platform = opts.platform as Platform;
    try {
      const adapter = getAdapter(platform);
      await adapter.installHooks(gitRoot, aditBinaryPath);
      installed.push(adapter.displayName);
      console.log(`  [+] ${adapter.displayName} — ${adapter.hookMappings.length} hook events installed`);
    } catch (err) {
      skipped.push(platform);
      console.log(`  [x] ${platform} — install failed: ${(err as Error).message}`);
    }
  } else {
    // Auto-detect: install hooks for all detected platforms
    const platforms = detectPlatforms(gitRoot);
    if (platforms.length === 0) {
      console.log("  [ ] No AI platforms detected in this project.");
      console.log("      Supported: Claude Code (.claude/), OpenCode (.opencode/)");
      console.log("      Run 'adit plugin install <platform>' to add one manually.");
    } else {
      for (const platform of platforms) {
        try {
          const adapter = getAdapter(platform);
          // Skip stub adapters (no hook mappings)
          if (adapter.hookMappings.length === 0) {
            skipped.push(adapter.displayName);
            console.log(`  [-] ${adapter.displayName} — detected but not yet supported`);
            continue;
          }
          await adapter.installHooks(gitRoot, aditBinaryPath);
          installed.push(adapter.displayName);
          console.log(`  [+] ${adapter.displayName} — ${adapter.hookMappings.length} hook events installed`);
        } catch (err) {
          skipped.push(platform);
          console.log(`  [x] ${platform} — install failed: ${(err as Error).message}`);
        }
      }
    }
  }

  // --- Summary ---
  console.log();
  if (installed.length > 0) {
    console.log("  Done! ADIT is ready.");
    console.log();
    console.log(`  Installed for: ${installed.join(", ")}`);
    console.log("  Run 'adit list' to view the timeline after your first prompt.");
  } else {
    console.log("  Done! ADIT data directory is ready.");
    console.log();
    console.log("  No platform hooks were installed.");
    console.log("  Run 'adit plugin install <platform>' when you're ready to add one.");
  }
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.join(", ")}`);
  }
  console.log();
}
