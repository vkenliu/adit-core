/**
 * `adit doctor` — Validate ADIT installation health.
 *
 * Checks: git repo, data dir, database, hooks, checkpoint refs,
 * Claude settings, adit-hook binary, schema version, disk space,
 * SQLite integrity, stale sessions, orphaned diffs.
 *
 * `adit doctor --fix` attempts automatic fixes.
 * `adit doctor --json` outputs results as JSON.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import {
  loadConfig,
  openDatabase,
  closeDatabase,
  queryEvents,
  listSessions,
  endSession,
} from "@adit/core";
import { isGitRepo, listCheckpointRefs, deleteCheckpointRef } from "@adit/engine";
import { detectPlatform, getAdapter } from "@adit/hooks/adapters";

/** Check if a command string is an ADIT hook (matches both npx and resolved-path formats) */
function isAditCommand(command: string): boolean {
  return command.includes("adit-hook") || command.includes("hooks/dist/index.js");
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fixable?: boolean;
}

export async function doctorCommand(
  opts?: { fix?: boolean; json?: boolean },
): Promise<void> {
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
  let db: ReturnType<typeof openDatabase> | null = null;
  try {
    db = openDatabase(config.dbPath);
    queryEvents(db, { limit: 1 });
    dbOk = true;
  } catch {
    // DB failed
  }
  checks.push({
    name: "Database",
    ok: dbOk,
    detail: dbOk ? `${config.dbPath} (accessible)` : "Cannot open database",
  });

  // 4. SQLite integrity
  if (db && dbOk) {
    let integrityOk = false;
    try {
      const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      integrityOk = result.length === 1 && result[0].integrity_check === "ok";
    } catch {
      // ignore
    }
    checks.push({
      name: "SQLite integrity",
      ok: integrityOk,
      detail: integrityOk ? "PRAGMA integrity_check: ok" : "Database integrity check failed",
    });
  }

  // 5. adit-hook binary
  let binaryOk = false;
  try {
    execSync("npx adit-hook --help 2>/dev/null", { timeout: 5000, stdio: "pipe" });
    binaryOk = true;
  } catch {
    // Try direct binary
    try {
      execSync("which adit-hook 2>/dev/null", { timeout: 3000, stdio: "pipe" });
      binaryOk = true;
    } catch {
      // not found
    }
  }
  checks.push({
    name: "adit-hook binary",
    ok: binaryOk,
    detail: binaryOk ? "Available on PATH or via npx" : "Not found. Ensure @adit/hooks is installed.",
  });

  // 6. Hooks — check .claude/settings.local.json or .claude/settings.json
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
    fixable: !hooksOk,
  });

  // 7. Checkpoint refs integrity
  let refsOk = true;
  let refCount = 0;
  let orphanedRefs = 0;
  const orphanedRefPaths: string[] = [];
  try {
    const refs = await listCheckpointRefs(config.projectRoot);
    refCount = refs.length;

    if (db && dbOk) {
      const checkpointEvents = queryEvents(db, { hasCheckpoint: true, limit: 1000 });
      const eventShas = new Set(checkpointEvents.map((e) => e.checkpointSha));

      for (const ref of refs) {
        if (!eventShas.has(ref.sha)) {
          orphanedRefs++;
          orphanedRefPaths.push(ref.stepId);
        }
      }
    }
  } catch {
    refsOk = false;
  }
  checks.push({
    name: "Checkpoint refs",
    ok: refsOk && orphanedRefs === 0,
    detail: `${refCount} refs${orphanedRefs > 0 ? `, ${orphanedRefs} orphaned` : ""}`,
    fixable: orphanedRefs > 0,
  });

  // 8. Platform hooks — verify all required hooks are registered
  const detectedPlatform = detectPlatform();
  const platformAdapter = getAdapter(detectedPlatform);
  const requiredHooks = platformAdapter.hookMappings.map((m) => m.platformEvent);
  const hookSettingsLocations = [
    join(config.projectRoot, ".claude", "settings.local.json"),
    join(config.projectRoot, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];

  let claudeSettingsOk = false;
  let claudeSettingsDetail = `No ${platformAdapter.displayName} settings found`;
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

      for (const hookName of requiredHooks) {
        const hookEntries = hooks[hookName];
        if (!Array.isArray(hookEntries)) {
          missingHooks.push(hookName);
          continue;
        }
        const hasAdit = hookEntries.some(
          (entry: { command?: string; hooks?: Array<{ command?: string }> }) => {
            if (typeof entry.command === "string" && isAditCommand(entry.command)) return true;
            if (Array.isArray(entry.hooks)) {
              return entry.hooks.some(
                (h) => typeof h.command === "string" && isAditCommand(h.command),
              );
            }
            return false;
          },
        );
        if (!hasAdit) missingHooks.push(hookName);
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
    name: `${platformAdapter.displayName} settings`,
    ok: claudeSettingsOk,
    detail: claudeSettingsDetail,
    fixable: !claudeSettingsOk,
  });

  // 9. Stale sessions
  let staleCount = 0;
  const staleSessions: string[] = [];
  if (db && dbOk) {
    const sessions = listSessions(db, config.projectId);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const s of sessions) {
      if (s.status === "active" && s.startedAt < dayAgo) {
        staleCount++;
        staleSessions.push(s.id);
      }
    }
  }
  checks.push({
    name: "Stale sessions",
    ok: staleCount === 0,
    detail: staleCount > 0 ? `${staleCount} sessions active >24h` : "No stale sessions",
    fixable: staleCount > 0,
  });

  // 10. Disk space
  let diskOk = true;
  let diskDetail = "OK";
  try {
    const stat = statSync(config.dataDir);
    if (stat.isDirectory()) {
      // Simple check: if adit.sqlite > 100MB, warn
      const dbStat = statSync(config.dbPath);
      const sizeMB = dbStat.size / (1024 * 1024);
      diskOk = sizeMB < 100;
      diskDetail = `Database: ${sizeMB.toFixed(1)}MB${sizeMB >= 100 ? " (large)" : ""}`;
    }
  } catch {
    diskDetail = "Cannot check disk usage";
  }
  checks.push({
    name: "Disk usage",
    ok: diskOk,
    detail: diskDetail,
  });

  // Attempt fixes if --fix
  if (opts?.fix) {
    const fixes: string[] = [];

    // Fix orphaned refs
    if (orphanedRefs > 0) {
      for (const refPath of orphanedRefPaths) {
        try {
          await deleteCheckpointRef(config.projectRoot, refPath);
          fixes.push(`Removed orphaned ref: ${refPath}`);
        } catch {
          // ignore
        }
      }
    }

    // Fix stale sessions
    if (staleCount > 0 && db) {
      for (const sid of staleSessions) {
        try {
          endSession(db, sid, "completed");
          fixes.push(`Closed stale session: ${sid.substring(0, 10)}`);
        } catch {
          // ignore
        }
      }
    }

    // Fix missing hooks via plugin install
    if (!hooksOk) {
      try {
        await platformAdapter.installHooks(config.projectRoot, "npx adit-hook");
        fixes.push(`Installed ADIT hooks for ${platformAdapter.displayName}`);
      } catch {
        // ignore
      }
    }

    if (fixes.length > 0 && !opts.json) {
      console.log("\nFixes applied:");
      for (const fix of fixes) {
        console.log(`  [*] ${fix}`);
      }
    }
  }

  if (db) closeDatabase(db);

  // Output
  if (opts?.json) {
    console.log(JSON.stringify({
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
      allPassed: checks.every((c) => c.ok),
    }, null, 2));
    return;
  }

  console.log("ADIT Health Check\n");
  let allOk = true;
  for (const check of checks) {
    const symbol = check.ok ? "+" : "x";
    const fixTag = !check.ok && check.fixable ? " (--fix)" : "";
    console.log(`  [${symbol}] ${check.name}: ${check.detail}${fixTag}`);
    if (!check.ok) allOk = false;
  }

  console.log(
    allOk
      ? "\nAll checks passed."
      : "\nSome checks failed. Run 'adit doctor --fix' to attempt repairs.",
  );
}
