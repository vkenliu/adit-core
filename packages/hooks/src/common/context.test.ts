/**
 * Tests for shared hook context session selection.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  closeDatabase,
  createClock,
  insertSession,
  loadConfig,
  openDatabase,
  serialize,
} from "@varveai/adit-core";
import type Database from "better-sqlite3";

vi.mock("@varveai/adit-engine", () => ({
  getCurrentBranch: vi.fn().mockResolvedValue("main"),
  getRemoteUrl: vi.fn().mockResolvedValue("git@example.com:repo.git"),
}));

async function loadContextModule(): Promise<typeof import("./context.js")> {
  vi.resetModules();
  return import("./context.js");
}

function tempDir(): string {
  const dir = join(tmpdir(), `adit-hook-context-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("initHookContext", () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let projectId: string;
  const clientId = "client-1";

  beforeEach(() => {
    dir = tempDir();
    dbPath = join(dir, "adit.sqlite");
    process.env.ADIT_PROJECT_ROOT = dir;
    process.env.ADIT_DATA_DIR = dir;
    process.env.ADIT_DB_PATH = dbPath;
    process.env.ADIT_CLIENT_ID = clientId;
    db = openDatabase(dbPath);
    projectId = loadConfig(dir).projectId;
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.ADIT_PROJECT_ROOT;
    delete process.env.ADIT_DATA_DIR;
    delete process.env.ADIT_DB_PATH;
    delete process.env.ADIT_CLIENT_ID;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("creates a new platform session instead of reusing another platform's active session", async () => {
    insertSession(db, {
      id: "claude-session",
      projectId,
      clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: "2026-05-11T02:00:00.000Z",
      vclockJson: serialize(createClock(clientId)),
      platformSessionId: "claude-platform-session",
    });

    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(dir, "codex", "codex-platform-session");

    expect(ctx.session.id).not.toBe("claude-session");
    expect(ctx.session.platform).toBe("codex");
    expect(ctx.session.platformSessionId).toBe("codex-platform-session");

    closeDatabase(ctx.db);
  });

  it("reuses active session only when no platform session id is available", async () => {
    insertSession(db, {
      id: "legacy-session",
      projectId,
      clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt: "2026-05-11T02:00:00.000Z",
      vclockJson: serialize(createClock(clientId)),
    });

    const { initHookContext } = await loadContextModule();
    const ctx = await initHookContext(dir, "claude-code");

    expect(ctx.session.id).toBe("legacy-session");

    closeDatabase(ctx.db);
  });
});
