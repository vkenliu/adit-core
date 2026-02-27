/**
 * `adit status` — Show ADIT status for the current project.
 *
 * Quick overview of whether ADIT is active, hook configuration state,
 * active session info, and recent checkpoint count.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  openDatabase,
  closeDatabase,
  getActiveSession,
  countEvents,
  queryEvents,
  getLatestCheckpointEvent,
  findGitRoot,
} from "@adit/core";
import {
  hasUncommittedChanges,
  getCurrentBranch,
  getHeadSha,
} from "@adit/engine";
import { detectPlatform, getAdapter } from "@adit/hooks/adapters";

export async function statusCommand(opts?: { json?: boolean }): Promise<void> {
  const config = loadConfig();
  const gitRoot = findGitRoot() ?? config.projectRoot;

  // Gather status info
  const status: Record<string, unknown> = {};

  // 1. Check if ADIT is initialized
  const dataExists = existsSync(config.dataDir);
  const dbExists = existsSync(config.dbPath);
  status.initialized = dataExists && dbExists;

  if (!status.initialized) {
    if (opts?.json) {
      console.log(JSON.stringify({ initialized: false }, null, 2));
    } else {
      console.log("ADIT is not initialized in this project.");
      console.log("Run 'adit init' to get started.");
    }
    return;
  }

  // 2. Check hook configuration — derive required hooks from adapter
  const platform = detectPlatform();
  const adapter = getAdapter(platform);
  const requiredHooks = adapter.hookMappings.map((m) => m.platformEvent);
  const installedHooks: string[] = [];

  const settingsPath = join(gitRoot, ".claude", "settings.local.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.hooks) {
        for (const hookName of requiredHooks) {
          const hookEntries = settings.hooks[hookName];
          if (Array.isArray(hookEntries)) {
            const hasAdit = hookEntries.some((entry: Record<string, unknown>) => {
              // Support both flat command string and nested hooks array format
              if (typeof entry.command === "string" && entry.command.includes("adit-hook")) {
                return true;
              }
              if (Array.isArray(entry.hooks)) {
                return entry.hooks.some(
                  (h: Record<string, unknown>) =>
                    typeof h.command === "string" && h.command.includes("adit-hook"),
                );
              }
              return false;
            });
            if (hasAdit) installedHooks.push(hookName);
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  status.hooks = {
    installed: installedHooks,
    missing: requiredHooks.filter((h) => !installedHooks.includes(h)),
    allInstalled: installedHooks.length === requiredHooks.length,
  };

  // 3. Database + session info
  const db = openDatabase(config.dbPath);
  try {
    // Active session
    const session = getActiveSession(db, config.projectId, config.clientId);
    status.session = session
      ? {
          id: session.id,
          platform: session.platform,
          startedAt: session.startedAt,
          status: session.status,
        }
      : null;

    // Event counts — use countEvents() for accurate total
    const totalEvents = countEvents(db, config.projectId);
    const checkpointEvents = queryEvents(db, { hasCheckpoint: true, limit: 10000 });
    status.events = {
      total: totalEvents,
      checkpoints: checkpointEvents.length,
    };

    // Latest checkpoint
    const latest = getLatestCheckpointEvent(db);
    status.latestCheckpoint = latest
      ? {
          eventId: latest.id,
          sha: latest.checkpointSha?.substring(0, 8),
          at: latest.startedAt,
        }
      : null;
  } finally {
    closeDatabase(db);
  }

  // 4. Git info
  const [branch, headSha, dirty] = await Promise.all([
    getCurrentBranch(config.projectRoot),
    getHeadSha(config.projectRoot),
    hasUncommittedChanges(config.projectRoot),
  ]);
  status.git = {
    branch,
    head: headSha?.substring(0, 8) ?? null,
    dirty,
  };

  // Output
  if (opts?.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const hooksStatus = status.hooks as {
    allInstalled: boolean;
    installed: string[];
    missing: string[];
  };
  const session = status.session as {
    id: string;
    platform: string;
    startedAt: string;
  } | null;
  const events = status.events as { total: number; checkpoints: number };
  const latestCp = status.latestCheckpoint as {
    eventId: string;
    sha: string;
    at: string;
  } | null;
  const git = status.git as {
    branch: string | null;
    head: string | null;
    dirty: boolean;
  };

  console.log("ADIT Status");
  console.log("===========");
  console.log();

  // Hooks
  if (hooksStatus.allInstalled) {
    console.log(`Hooks:        All ${requiredHooks.length} installed`);
  } else {
    console.log(`Hooks:        ${hooksStatus.installed.length}/${requiredHooks.length} installed, missing: ${hooksStatus.missing.join(", ")}`);
  }

  // Session
  if (session) {
    console.log(`Session:      ${session.id.substring(0, 10)}... (${session.platform}, started ${session.startedAt})`);
  } else {
    console.log("Session:      No active session");
  }

  // Events
  console.log(`Events:       ${events.total} total, ${events.checkpoints} checkpoints`);

  // Latest checkpoint
  if (latestCp) {
    console.log(`Last CP:      ${latestCp.sha} at ${latestCp.at}`);
  } else {
    console.log("Last CP:      None");
  }

  // Git
  console.log(`Branch:       ${git.branch ?? "detached"}`);
  console.log(`HEAD:         ${git.head ?? "unknown"}`);
  console.log(`Working tree: ${git.dirty ? "dirty" : "clean"}`);
}
