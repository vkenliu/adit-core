/**
 * `adit init` — Initialize ADIT in the current project.
 *
 * Creates the .adit/ data directory, initializes the database,
 * and installs hooks for detected (or specified) AI platforms via adapters.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, openDatabase, closeDatabase, findGitRoot } from "@adit/core";
import type { Platform } from "@adit/core";
import { isGitRepo } from "@adit/engine";
import { detectPlatform, getAdapter, resolveAditHookBinary } from "@adit/hooks/adapters";

/**
 * Detect which platforms are present in this project by checking
 * for their config directories. Falls back to env-based detection
 * if no platform directories are found.
 */
function detectPlatforms(projectRoot: string): Platform[] {
  const platforms = new Set<Platform>();

  // Check for Claude Code config directory
  if (existsSync(join(projectRoot, ".claude"))) {
    platforms.add("claude-code");
  }

  // Check for OpenCode config directory or config file
  if (
    existsSync(join(projectRoot, ".opencode")) ||
    existsSync(join(projectRoot, "opencode.json")) ||
    existsSync(join(projectRoot, "opencode.jsonc"))
  ) {
    platforms.add("opencode");
  }

  // If no platform directories found, fall back to env detection
  if (platforms.size === 0) {
    platforms.add(detectPlatform());
  }

  return Array.from(platforms);
}

export async function initCommand(opts: {
  cwd?: string;
  platform?: string;
  force?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  // Verify we're in a git repo
  if (!(await isGitRepo(cwd))) {
    console.error("Error: not a git repository. Run 'git init' first.");
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const gitRoot = findGitRoot(cwd) ?? cwd;

  // If --force, uninstall existing hooks first
  if (opts.force) {
    const { listAdapters: listAll } = await import("@adit/hooks/adapters");
    for (const adapter of listAll()) {
      if (adapter.hookMappings.length === 0) continue;
      try {
        const result = await adapter.validateInstallation(gitRoot);
        if (result.valid) {
          await adapter.uninstallHooks(gitRoot);
          console.log(`Removed existing ${adapter.displayName} hooks`);
        }
      } catch {
        // best-effort cleanup
      }
    }
  }

  // Create data directory
  mkdirSync(config.dataDir, { recursive: true });
  console.log(`Created data directory: ${config.dataDir}`);

  // Initialize database
  const db = openDatabase(config.dbPath);
  closeDatabase(db);
  console.log(`Initialized database: ${config.dbPath}`);

  // Add .adit/ to .gitignore if not already there
  const gitignorePath = join(gitRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".adit/")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.adit/\n");
      console.log("Added .adit/ to .gitignore");
    }
  } else {
    writeFileSync(gitignorePath, ".adit/\n");
    console.log("Created .gitignore with .adit/");
  }

  // Determine which platforms to install hooks for
  const aditBinaryPath = resolveAditHookBinary();

  if (opts.platform) {
    // Explicit platform specified
    const platform = opts.platform as Platform;
    try {
      const adapter = getAdapter(platform);
      await adapter.installHooks(gitRoot, aditBinaryPath);
      console.log(`Installed ${adapter.displayName} hooks (${adapter.hookMappings.length} events)`);
    } catch {
      console.log(`Note: Could not install hooks for platform "${platform}". Run 'adit plugin install ${platform}' manually.`);
    }
  } else {
    // Auto-detect: install hooks for all detected platforms
    const platforms = detectPlatforms(gitRoot);
    for (const platform of platforms) {
      try {
        const adapter = getAdapter(platform);
        // Skip stub adapters (no hook mappings)
        if (adapter.hookMappings.length === 0) continue;
        await adapter.installHooks(gitRoot, aditBinaryPath);
        console.log(`Installed ${adapter.displayName} hooks (${adapter.hookMappings.length} events)`);
      } catch {
        console.log(`Note: Could not install hooks for platform "${platform}". Run 'adit plugin install ${platform}' manually.`);
      }
    }
  }

  console.log("\nADIT initialized successfully!");
  console.log("Run 'adit list' to view the timeline after your first prompt.");
}
