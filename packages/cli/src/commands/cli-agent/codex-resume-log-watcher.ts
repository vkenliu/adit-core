import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

export interface CodexResumeLogWatcher {
  stop(): void;
}

export interface CodexResumeLogReadResult {
  lastLogId: number;
  threadIds: string[];
}

export interface CodexResumeLogReadOptions {
  cwd: string;
  afterLogId: number;
  codexHome?: string;
}

export interface CodexSavedThreadLookupOptions {
  cwd: string;
  threadId: string;
  codexHome?: string;
}

export interface StartCodexResumeLogWatcherOptions {
  cwd: string;
  onResume: (threadId: string) => void;
  codexHome?: string;
  pollIntervalMs?: number;
}

interface ResumeLogRow {
  id: number;
  thread_id: string | null;
}

interface ThreadCwdRow {
  cwd: string | null;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const THREAD_RESUME_MARKER = "%otel.name=\"thread/resume\"%";
const CODEX_TUI_MARKER = "%app_server.client_name=\"codex-tui\"%";

export function startCodexResumeLogWatcher(
  opts: StartCodexResumeLogWatcherOptions,
): CodexResumeLogWatcher {
  let stopped = false;
  let lastLogId = readMaxCodexLogId(opts.codexHome);

  const poll = () => {
    if (stopped) return;
    const result = readCodexResumeLogEvents({
      cwd: opts.cwd,
      codexHome: opts.codexHome,
      afterLogId: lastLogId,
    });
    lastLogId = Math.max(lastLogId, result.lastLogId);
    for (const threadId of result.threadIds) {
      opts.onResume(threadId);
    }
  };

  const timer = setInterval(poll, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();
  poll();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function readCodexResumeLogEvents(
  opts: CodexResumeLogReadOptions,
): CodexResumeLogReadResult {
  const codexHome = resolveCodexHome(opts.codexHome);
  const logsPath = join(codexHome, "logs_2.sqlite");
  const statePath = join(codexHome, "state_5.sqlite");
  if (!existsSync(logsPath) || !existsSync(statePath)) {
    return { lastLogId: opts.afterLogId, threadIds: [] };
  }

  let logsDb: Database.Database | null = null;
  let stateDb: Database.Database | null = null;
  try {
    logsDb = openReadonlyDatabase(logsPath);
    stateDb = openReadonlyDatabase(statePath);
    const rows = logsDb.prepare(`
      SELECT id, thread_id
      FROM logs
      WHERE id > ?
        AND thread_id IS NOT NULL
        AND feedback_log_body LIKE ?
        AND feedback_log_body LIKE ?
      ORDER BY id ASC
      LIMIT 50
    `).all(opts.afterLogId, THREAD_RESUME_MARKER, CODEX_TUI_MARKER) as ResumeLogRow[];

    let lastLogId = opts.afterLogId;
    const threadIds: string[] = [];
    const targetCwd = normalizePath(opts.cwd);
    const cwdForThread = stateDb.prepare("SELECT cwd FROM threads WHERE id = ? LIMIT 1");

    for (const row of rows) {
      const threadId = readString(row.thread_id);
      if (!threadId) continue;
      const thread = cwdForThread.get(threadId) as ThreadCwdRow | undefined;
      const threadCwd = readString(thread?.cwd);
      if (!threadCwd) continue;
      lastLogId = Math.max(lastLogId, row.id);
      if (normalizePath(threadCwd) === targetCwd) {
        threadIds.push(threadId);
      }
    }

    return { lastLogId, threadIds };
  } catch {
    return { lastLogId: opts.afterLogId, threadIds: [] };
  } finally {
    try {
      logsDb?.close();
    } catch {}
    try {
      stateDb?.close();
    } catch {}
  }
}

export function isCodexThreadSavedForCwd(opts: CodexSavedThreadLookupOptions): boolean {
  const threadId = readString(opts.threadId);
  if (!threadId) return false;
  const statePath = join(resolveCodexHome(opts.codexHome), "state_5.sqlite");
  if (!existsSync(statePath)) return false;

  let db: Database.Database | null = null;
  try {
    db = openReadonlyDatabase(statePath);
    const row = db.prepare("SELECT cwd FROM threads WHERE id = ? LIMIT 1").get(threadId) as
      | ThreadCwdRow
      | undefined;
    const threadCwd = readString(row?.cwd);
    return Boolean(threadCwd && normalizePath(threadCwd) === normalizePath(opts.cwd));
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function readMaxCodexLogId(codexHome?: string): number {
  const logsPath = join(resolveCodexHome(codexHome), "logs_2.sqlite");
  if (!existsSync(logsPath)) return 0;
  let db: Database.Database | null = null;
  try {
    db = openReadonlyDatabase(logsPath);
    const row = db.prepare("SELECT max(id) AS id FROM logs").get() as { id?: number | null };
    return typeof row.id === "number" ? row.id : 0;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function openReadonlyDatabase(filePath: string): Database.Database {
  return new Database(filePath, {
    fileMustExist: true,
    readonly: true,
  });
}

function resolveCodexHome(codexHome?: string): string {
  return codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function normalizePath(value: string): string {
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
