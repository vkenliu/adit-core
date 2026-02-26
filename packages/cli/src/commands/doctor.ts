/**
 * `adit doctor` — Validate ADIT installation health.
 *
 * Checks:
 * - Git repo exists
 * - .adit/ directory exists
 * - Database is accessible
 * - Hooks are configured in Claude Code settings
 * - Checkpoint refs are consistent
 * - Claude Code settings have all 3 required hooks registered
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadConfig,
  openDatabase,
  closeDatabase,
  queryEvents,
} from "@adit/core";
import { isGitRepo, listCheckpointRefs } from "@adit/engine";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [];
  const config = loadConfig();

  // 1. Git repo
  const gitOk = await isGitRepo(config.projectRoot);
  checks.push({
    name: "Git repository",
    ok: gitOk,
    detail: gitOk ? config.projectRoot : "Not a git repository",
  });

  // 2. Data directory
  const dataDirOk = existsSync(config.dataDir);
  checks.push({
    name: "Data directory",
    ok: dataDirOk,
    detail: dataDirOk ? config.dataDir : "Run 'adit init' first",
  });

  // 3. Database
  let dbOk = false;
  try {
    const db = openDatabase(config.dbPath);
    queryEvents(db, { limit: 1 });
    dbOk = true;
    closeDatabase(db);
  } catch (e) {
    // DB failed
  }
  checks.push({
    name: "Database",
    ok: dbOk,
    detail: dbOk ? `${config.dbPath} (accessible)` : "Cannot open database",
  });

  // 4. Hooks — check .claude/settings.local.json or .claude/settings.json
  const settingsLocalPath = join(config.projectRoot, ".claude", "settings.local.json");
  const settingsJsonPath = join(config.projectRoot, ".claude", "settings.json");
  let hooksOk = false;
  let hooksDetail = "No hooks found in .claude/settings.local.json or .claude/settings.json";
  for (const p of [settingsLocalPath, settingsJsonPath]) {
    if (existsSync(p)) {
      try {
        const content = JSON.parse(readFileSync(p, "utf-8"));
        if (content.hooks) {
          hooksOk = true;
          hooksDetail = p;
          break;
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  checks.push({
    name: "Hooks config",
    ok: hooksOk,
    detail: hooksDetail,
  });

  // 5. Checkpoint refs integrity
  let refsOk = true;
  let refCount = 0;
  let orphanedRefs = 0;
  try {
    const refs = await listCheckpointRefs(config.projectRoot);
    refCount = refs.length;

    if (dbOk) {
      const db = openDatabase(config.dbPath);
      const checkpointEvents = queryEvents(db, { hasCheckpoint: true, limit: 1000 });
      const eventShas = new Set(checkpointEvents.map((e) => e.checkpointSha));

      for (const ref of refs) {
        if (!eventShas.has(ref.sha)) {
          orphanedRefs++;
        }
      }
      closeDatabase(db);
    }
  } catch {
    refsOk = false;
  }
  checks.push({
    name: "Checkpoint refs",
    ok: refsOk && orphanedRefs === 0,
    detail: `${refCount} refs${orphanedRefs > 0 ? `, ${orphanedRefs} orphaned` : ""}`,
  });

  // 6. Claude Code settings — verify all 3 required hooks are registered
  const requiredHooks = ["UserPromptSubmit", "PostToolUse", "Stop"] as const;
  const hookSettingsLocations = [
    join(config.projectRoot, ".claude", "settings.local.json"),
    join(config.projectRoot, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];

  let claudeSettingsOk = false;
  let claudeSettingsDetail = "No Claude Code settings found";
  const missingHooks: string[] = [];

  for (const hookSettingsPath of hookSettingsLocations) {
    if (!existsSync(hookSettingsPath)) continue;
    try {
      const raw = readFileSync(hookSettingsPath, "utf-8");
      const settings = JSON.parse(raw);
      const hooks = settings.hooks;
      if (!hooks) {
        claudeSettingsDetail = `${hookSettingsPath} found but has no hooks configuration`;
        break;
      }

      // Check each required hook for an adit-hook command
      // Supports both flat format ({command: "..."}) and nested format ({hooks: [{command: "..."}]})
      for (const hookName of requiredHooks) {
        const hookEntries = hooks[hookName];
        if (!Array.isArray(hookEntries)) {
          missingHooks.push(hookName);
          continue;
        }
        const hasAdit = hookEntries.some(
          (entry: { command?: string; hooks?: Array<{ command?: string }> }) => {
            if (typeof entry.command === "string" && entry.command.includes("adit-hook")) {
              return true;
            }
            if (Array.isArray(entry.hooks)) {
              return entry.hooks.some(
                (h) => typeof h.command === "string" && h.command.includes("adit-hook"),
              );
            }
            return false;
          },
        );
        if (!hasAdit) {
          missingHooks.push(hookName);
        }
      }

      claudeSettingsOk = missingHooks.length === 0;
      claudeSettingsDetail = claudeSettingsOk
        ? `All hooks registered in ${hookSettingsPath}`
        : `Missing hooks in ${hookSettingsPath}: ${missingHooks.join(", ")}`;
      break;
    } catch {
      claudeSettingsDetail = `Failed to parse ${hookSettingsPath}`;
    }
  }

  checks.push({
    name: "Claude Code settings",
    ok: claudeSettingsOk,
    detail: claudeSettingsDetail,
  });

  // Print results
  console.log("ADIT Health Check\n");
  let allOk = true;
  for (const check of checks) {
    const symbol = check.ok ? "+" : "x";
    console.log(`  [${symbol}] ${check.name}: ${check.detail}`);
    if (!check.ok) allOk = false;
  }

  console.log(
    allOk
      ? "\nAll checks passed."
      : "\nSome checks failed. Run 'adit init' to fix.",
  );
}
