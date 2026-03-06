/**
 * `adit status` — Show ADIT status for the current project.
 *
 * Quick overview of whether ADIT is active, hook configuration state,
 * active session info, and recent checkpoint count.
 */

import { existsSync } from "node:fs";
import {
  loadConfig,
  openDatabase,
  closeDatabase,
  getActiveSession,
  countEvents,
  queryEvents,
  getLatestCheckpointEvent,
  getSyncState,
  findGitRoot,
} from "@adit/core";
import {
  hasUncommittedChanges,
  getCurrentBranch,
  getHeadSha,
} from "@adit/engine";
import { detectPlatform, getAdapter, listAdapters } from "@adit/hooks/adapters";

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

  // 2. Check hook configuration via platform adapters
  //    Validate all implemented adapters (skip stubs with no hook mappings)
  const implementedAdapters = listAdapters().filter((a) => a.hookMappings.length > 0);
  const installedPlatforms: string[] = [];
  const missingPlatforms: string[] = [];

  for (const adapter of implementedAdapters) {
    const result = await adapter.validateInstallation(gitRoot);
    if (result.valid) {
      installedPlatforms.push(adapter.displayName);
    } else if (result.checks.some((c) => c.ok)) {
      // Partially installed — platform directory exists but hooks incomplete
      missingPlatforms.push(adapter.displayName);
    }
  }

  // Fall back to env-detected platform if nothing found
  if (installedPlatforms.length === 0 && missingPlatforms.length === 0) {
    const platform = detectPlatform();
    const adapter = getAdapter(platform);
    if (adapter.hookMappings.length > 0) {
      missingPlatforms.push(adapter.displayName);
    }
  }

  status.hooks = {
    installed: installedPlatforms,
    missing: missingPlatforms,
    allInstalled: missingPlatforms.length === 0 && installedPlatforms.length > 0,
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

    // Unsynced events — count events after the last sync cursor.
    // Resolve server URL the same way auto-sync does: env var → credentials.
    let syncServerUrl = process.env.ADIT_CLOUD_URL ?? null;
    if (!syncServerUrl) {
      try {
        const { loadCredentials } = await import("@adit/cloud");
        syncServerUrl = loadCredentials()?.serverUrl ?? null;
      } catch {
        // @adit/cloud not available
      }
    }
    const syncState = getSyncState(db, syncServerUrl ?? "");
    if (syncState?.lastSyncedEventId) {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE e.id > ? AND s.project_id = ?`,
      ).get(syncState.lastSyncedEventId, config.projectId) as { cnt: number };
      (status.events as Record<string, unknown>).unsynced = row.cnt;
    } else {
      // Never synced — all events are unsynced
      (status.events as Record<string, unknown>).unsynced = totalEvents;
    }

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
  const events = status.events as { total: number; checkpoints: number; unsynced: number };
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
    console.log(`Hooks:        ${hooksStatus.installed.join(", ")} installed`);
  } else if (hooksStatus.installed.length > 0) {
    console.log(`Hooks:        ${hooksStatus.installed.join(", ")} installed; missing: ${hooksStatus.missing.join(", ")}`);
  } else if (hooksStatus.missing.length > 0) {
    console.log(`Hooks:        Not installed (${hooksStatus.missing.join(", ")} detected but incomplete)`);
  } else {
    console.log("Hooks:        No platforms detected");
  }

  // Session
  if (session) {
    console.log(`Session:      ${session.id.substring(0, 10)}... (${session.platform}, started ${session.startedAt})`);
  } else {
    console.log("Session:      No active session");
  }

  // Events
  console.log(`Events:       ${events.total} total, ${events.checkpoints} checkpoints, ${events.unsynced} unsynced`);

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
