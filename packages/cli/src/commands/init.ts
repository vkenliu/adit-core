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

  // Create hooks directory for Claude Code if not present
  const hooksDir = join(gitRoot, ".claude", "hooks");
  if (!existsSync(join(gitRoot, "hooks", "hooks.json"))) {
    mkdirSync(join(gitRoot, "hooks"), { recursive: true });
    writeFileSync(
      join(gitRoot, "hooks", "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                matcher: "",
                hook_type: "command",
                command: "npx adit-hook prompt-submit",
                timeout: 5000,
              },
            ],
            PostToolUse: [
              {
                matcher: "",
                hook_type: "command",
                command: "npx adit-hook tool-use",
                timeout: 5000,
              },
            ],
            Stop: [
              {
                matcher: "",
                hook_type: "command",
                command: "npx adit-hook stop",
                timeout: 30000,
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    console.log("Created hooks/hooks.json for Claude Code");
  }

  console.log("\nADIT initialized successfully!");
  console.log("Run 'adit list' to view the timeline after your first prompt.");
}
