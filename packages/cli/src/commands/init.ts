/**
 * `adit init` — Initialize ADIT in the current project.
 *
 * Creates the .adit/ data directory, initializes the database,
 * and optionally installs Claude Code hooks.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, openDatabase, closeDatabase, findGitRoot } from "@adit/core";
import { isGitRepo } from "@adit/engine";

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
    const content = await import("node:fs").then((fs) =>
      fs.readFileSync(gitignorePath, "utf-8"),
    );
    if (!content.includes(".adit/")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.adit/\n");
      console.log("Added .adit/ to .gitignore");
    }
  } else {
    writeFileSync(gitignorePath, ".adit/\n");
    console.log("Created .gitignore with .adit/");
  }

  // Install Claude Code hooks in .claude/settings.local.json
  const settingsLocalPath = join(gitRoot, ".claude", "settings.local.json");
  let needsHooks = true;
  if (existsSync(settingsLocalPath)) {
    try {
      const existing = JSON.parse(
        await import("node:fs").then((fs) =>
          fs.readFileSync(settingsLocalPath, "utf-8"),
        ),
      );
      if (existing.hooks) {
        needsHooks = false;
      }
    } catch {
      // parse error — overwrite
    }
  }
  if (needsHooks) {
    mkdirSync(join(gitRoot, ".claude"), { recursive: true });
    // Merge with existing settings if present
    let existingSettings: Record<string, unknown> = {};
    if (existsSync(settingsLocalPath)) {
      try {
        existingSettings = JSON.parse(
          await import("node:fs").then((fs) =>
            fs.readFileSync(settingsLocalPath, "utf-8"),
          ),
        );
      } catch {
        // ignore
      }
    }
    const settings = {
      ...existingSettings,
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: "adit-hook prompt-submit",
                timeout: 5000,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "adit-hook tool-use",
                timeout: 5000,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "adit-hook stop",
                timeout: 30000,
              },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsLocalPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("Installed hooks in .claude/settings.local.json");
  }

  console.log("\nADIT initialized successfully!");
  console.log("Run 'adit list' to view the timeline after your first prompt.");
}
