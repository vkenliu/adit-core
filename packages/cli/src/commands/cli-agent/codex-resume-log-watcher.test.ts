import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  isCodexThreadSavedForCwd,
  readCodexResumeLogEvents,
} from "./codex-resume-log-watcher.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-resume-log-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupCodexDatabases(codexHome: string): void {
  const logs = new Database(join(codexHome, "logs_2.sqlite"));
  logs.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL DEFAULT 0,
      ts_nanos INTEGER NOT NULL DEFAULT 0,
      level TEXT NOT NULL DEFAULT 'TRACE',
      target TEXT NOT NULL DEFAULT 'log',
      feedback_log_body TEXT,
      thread_id TEXT,
      process_uuid TEXT
    );
  `);
  logs.close();

  const state = new Database(join(codexHome, "state_5.sqlite"));
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL
    );
  `);
  state.close();
}

function insertThread(codexHome: string, id: string, cwd: string): void {
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.prepare("INSERT INTO threads (id, cwd) VALUES (?, ?)").run(id, cwd);
  db.close();
}

function insertLog(codexHome: string, threadId: string | null, body: string): number {
  const db = new Database(join(codexHome, "logs_2.sqlite"));
  const result = db.prepare(`
    INSERT INTO logs (feedback_log_body, thread_id)
    VALUES (?, ?)
  `).run(body, threadId);
  db.close();
  return Number(result.lastInsertRowid);
}

describe("readCodexResumeLogEvents", () => {
  it("returns only Codex TUI resume events for the current project cwd", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-current", "/tmp/project");
      insertThread(codexHome, "thread-other", "/tmp/other");

      insertLog(codexHome, "thread-current", "app_server.request otel.name=\"thread/start\" app_server.client_name=\"codex-tui\"");
      insertLog(codexHome, "thread-other", "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"");
      const expectedId = insertLog(codexHome, "thread-current", "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"");
      insertLog(codexHome, "thread-current", "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"other-client\"");

      const result = readCodexResumeLogEvents({
        codexHome,
        cwd: "/tmp/project",
        afterLogId: 0,
      });

      expect(result.threadIds).toEqual(["thread-current"]);
      expect(result.lastLogId).toBeGreaterThanOrEqual(expectedId);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("ignores resume events already behind the log watermark", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-current", "/tmp/project");
      const logId = insertLog(codexHome, "thread-current", "app_server.request otel.name=\"thread/resume\" app_server.client_name=\"codex-tui\"");

      const result = readCodexResumeLogEvents({
        codexHome,
        cwd: "/tmp/project",
        afterLogId: logId,
      });

      expect(result.threadIds).toEqual([]);
      expect(result.lastLogId).toBe(logId);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe("isCodexThreadSavedForCwd", () => {
  it("returns true when a thread is saved for the current project cwd", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-current", "/tmp/project");

      expect(isCodexThreadSavedForCwd({
        codexHome,
        cwd: "/tmp/project",
        threadId: "thread-current",
      })).toBe(true);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("returns false for missing threads and threads from other projects", () => {
    const codexHome = tempDir();
    try {
      setupCodexDatabases(codexHome);
      insertThread(codexHome, "thread-other", "/tmp/other");

      expect(isCodexThreadSavedForCwd({
        codexHome,
        cwd: "/tmp/project",
        threadId: "thread-missing",
      })).toBe(false);
      expect(isCodexThreadSavedForCwd({
        codexHome,
        cwd: "/tmp/project",
        threadId: "thread-other",
      })).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
