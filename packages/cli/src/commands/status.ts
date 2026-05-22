/**
 * `adit status` — Show ADIT status for the current project.
 *
 * Displays a styled overview with session cards, git state, sync info,
 * and hook configuration. Inspired by Entire CLI's v0.4.6 session card
 * format but adapted for ADIT's richer event model.
 */

import { existsSync } from "node:fs";
import pc from "picocolors";
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
} from "@varveai/adit-core";
import {
  hasUncommittedChanges,
  getCurrentBranch,
  getHeadSha,
} from "@varveai/adit-engine";
import { detectPlatform, getAdapter, listAdapters } from "@varveai/adit-hooks/adapters";
import { statusDot, joinDim, sectionHeader, horizontalRule, timeAgo } from "../utils/format.js";
import { truncate } from "../utils/summary.js";

/** Display-name map for platforms (matches adapter displayName but avoids import) */
const platformLabel: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  copilot: "Copilot",
  opencode: "OpenCode",
  codex: "Codex",
  gemini: "Gemini",
};

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
      console.log();
      console.log(`${statusDot(false)} ${pc.bold("Not initialized")}`);
      console.log();
      console.log(pc.dim("Run 'adit init' to get started."));
      console.log();
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
  let latestPromptText: string | null = null;

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

    // Fetch latest prompt text for the session card
    if (session) {
      const latestPrompts = queryEvents(db, {
        sessionId: session.id,
        eventType: "prompt_submit",
        limit: 1,
      });
      latestPromptText = latestPrompts[0]?.promptText ?? null;
    }

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
        const { loadCredentials } = await import("@varveai/adit-cloud");
        syncServerUrl = loadCredentials()?.serverUrl ?? null;
      } catch {
        // @varveai/adit-cloud not available
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

  // ──────────────────────────────────────────────
  // Output
  // ──────────────────────────────────────────────

  if (opts?.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const ruleWidth = 50;
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

  // ── Status line ──────────────────────────────
  console.log();
  const isActive = session !== null;
  const hooksList = hooksStatus.installed.length > 0
    ? hooksStatus.installed.join(", ")
    : null;
  const branchLabel = git.branch ? pc.cyan(git.branch) : pc.yellow("detached");

  console.log(
    joinDim([
      `${statusDot(isActive)} ${pc.bold(isActive ? "Active" : "Idle")}`,
      hooksList,
      `branch ${branchLabel}`,
    ]),
  );

  // ── Session card ─────────────────────────────
  console.log();
  console.log(sectionHeader("Session", ruleWidth));
  console.log();

  if (session) {
    const label = platformLabel[session.platform] ?? session.platform;
    const shortId = session.id.substring(0, 12);
    console.log(joinDim([pc.bold(label), pc.dim(shortId)]));

    // Latest prompt (Entire-style quoted line)
    if (latestPromptText) {
      const cleaned = latestPromptText.replace(/\n/g, " ").trim();
      console.log(pc.dim("> ") + `"${truncate(cleaned, 60)}"`);
    }

    // Stats line
    const statsLine = joinDim([
      `started ${timeAgo(session.startedAt)}`,
      `${events.total} events`,
      `${events.checkpoints} checkpoints`,
    ]);
    console.log(pc.dim(statsLine));
  } else {
    console.log(pc.dim("No active session"));
  }

  // ── Git ──────────────────────────────────────
  console.log();
  console.log(sectionHeader("Git", ruleWidth));
  console.log();

  const headShort = git.head ?? "unknown";
  const treeStatus = git.dirty
    ? pc.yellow("dirty")
    : pc.green("clean");
  console.log(joinDim([
    `branch ${branchLabel}`,
    headShort,
    treeStatus,
  ]));

  if (latestCp) {
    console.log(pc.dim(`last checkpoint ${latestCp.sha} ${timeAgo(latestCp.at)}`));
  }

  // ── Sync ─────────────────────────────────────
  console.log();
  console.log(sectionHeader("Sync", ruleWidth));
  console.log();

  if (events.unsynced === 0) {
    console.log(pc.green("all events synced"));
  } else {
    console.log(pc.yellow(`${events.unsynced} events unsynced`));
  }

  // ── Hooks warnings (only if issues) ──────────
  if (missingPlatforms.length > 0) {
    console.log();
    console.log(sectionHeader("Warnings", ruleWidth));
    console.log();
    console.log(pc.yellow(`hooks incomplete: ${missingPlatforms.join(", ")}`));
  }

  // ── Footer ───────────────────────────────────
  console.log();
  console.log(horizontalRule(ruleWidth));
  console.log();
}
