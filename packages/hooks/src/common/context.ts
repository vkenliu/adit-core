/**
 * Shared hook context — initializes DB, config, and session
 * for any hook handler.
 *
 * Fail-open design: if anything goes wrong during setup,
 * the hook exits silently (exit 0) so the AI agent is never blocked.
 */

import {
  loadConfig,
  openDatabase,
  getActiveSession,
  getSessionByPlatformSessionId,
  insertSession,
  generateId,
  createClock,
  serialize,
  type AditConfig,
  type AditSession,
} from "@adit/core";
import type Database from "better-sqlite3";
import { getCurrentBranch, getRemoteUrl } from "@adit/engine";

export interface HookContext {
  db: Database.Database;
  config: AditConfig;
  session: AditSession;
}

/** Initialize the hook context (DB + session) */
export async function initHookContext(
  cwd: string,
  platform: string = "claude-code",
  platformSessionId?: string,
): Promise<HookContext> {
  const config = loadConfig(cwd);
  const db = openDatabase(config.dbPath);

  // Get or create session — prefer platform session ID lookup
  let session: AditSession | null = null;
  if (platformSessionId) {
    session = getSessionByPlatformSessionId(db, platformSessionId);
  }
  if (!session) {
    session = getActiveSession(db, config.projectId, config.clientId);
  }
  if (!session) {
    const id = generateId();
    const now = new Date().toISOString();
    const branch = await getCurrentBranch(cwd);
    const remoteUrl = await getRemoteUrl(cwd);

    insertSession(db, {
      id,
      projectId: config.projectId,
      clientId: config.clientId,
      sessionType: "interactive",
      platform: platform as "claude-code",
      startedAt: now,
      metadataJson: JSON.stringify({
        gitBranch: branch ?? "unknown",
        gitRemoteUrl: remoteUrl ?? undefined,
        workingDirectory: cwd,
      }),
      vclockJson: serialize(createClock(config.clientId)),
      platformSessionId: platformSessionId ?? null,
    });

    // Re-fetch via platform session ID if available, else fall back
    if (platformSessionId) {
      session = getSessionByPlatformSessionId(db, platformSessionId)!;
    } else {
      session = getActiveSession(db, config.projectId, config.clientId)!;
    }
  }

  return { db, config, session };
}

/** Read hook input from stdin (Claude Code sends JSON) */
export async function readStdin(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;

    const finish = <T>(fn: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      try {
        finish(resolve, JSON.parse(data));
      } catch {
        finish(reject, new Error("Invalid JSON on stdin"));
      }
    });
    process.stdin.on("error", (err) => finish(reject, err));

    // Hard timeout — always fires after 3 seconds regardless of data state.
    // If data was received but stdin never closed (e.g. parent process didn't
    // close the pipe), try to parse whatever we have instead of hanging forever.
    setTimeout(() => {
      if (data) {
        try {
          finish(resolve, JSON.parse(data));
        } catch {
          finish(reject, new Error("Stdin timeout: incomplete JSON"));
        }
      } else {
        finish(reject, new Error("No stdin data received"));
      }
    }, 3000);
  });
}
