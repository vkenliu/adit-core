/**
 * `adit init` — Initialize ADIT in the current project.
 *
 * Creates the .adit/ data directory, initializes the database,
 * and installs hooks for the detected AI platform via the adapter.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, openDatabase, closeDatabase, findGitRoot } from "@adit/core";
import { isGitRepo } from "@adit/engine";
import { detectPlatform, getAdapter, resolveAditHookBinary } from "@adit/hooks/adapters";

export async function initCommand(opts: { cwd?: string }): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  // Verify we're in a git repo
  if (!(await isGitRepo(cwd))) {
    console.error("Error: not a git repository. Run 'git init' first.");
    process.exit(1);
  }

  const config = loadConfig(cwd);

  // Create data directory
  mkdirSync(config.dataDir, { recursive: true });
  console.log(`Created data directory: ${config.dataDir}`);

  // Initialize database
  const db = openDatabase(config.dbPath);
  closeDatabase(db);
  console.log(`Initialized database: ${config.dbPath}`);

  // Add .adit/ to .gitignore if not already there
  const gitRoot = findGitRoot(cwd) ?? cwd;
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

  // Install hooks via the platform adapter
  const platform = detectPlatform();
  try {
    const adapter = getAdapter(platform);
    await adapter.installHooks(gitRoot, resolveAditHookBinary());
    console.log(`Installed ${adapter.displayName} hooks (${adapter.hookMappings.length} events)`);
  } catch {
    console.log(`Note: Could not install hooks for platform "${platform}". Run 'adit plugin install' manually.`);
  }

  console.log("\nADIT initialized successfully!");
  console.log("Run 'adit list' to view the timeline after your first prompt.");
}
