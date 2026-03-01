/**
 * Performance logging for time-sensitive operations.
 *
 * Records call timing for hook handlers, git operations, network calls,
 * and other time-sensitive operations. Logs are stored as daily JSONL files
 * in .adit/perf-logs/ and auto-pruned after 7 days.
 */

import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

/** A single performance log entry */
export interface PerfEntry {
  /** ISO timestamp of when the call started */
  timestamp: string;
  /** Category of the call (e.g. "hook", "git", "network", "snapshot") */
  category: string;
  /** Name of the operation (e.g. "dispatchHook:stop", "runGit:status") */
  operation: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the operation succeeded */
  success: boolean;
  /** Optional error message on failure */
  error?: string;
}

/** Aggregated stats for a single operation */
export interface PerfOperationStats {
  /** Category of the call */
  category: string;
  /** Name of the operation */
  operation: string;
  /** Total number of calls */
  count: number;
  /** Average duration in ms */
  avgMs: number;
  /** Minimum duration in ms */
  minMs: number;
  /** Maximum duration in ms */
  maxMs: number;
  /** p95 duration in ms */
  p95Ms: number;
  /** Standard deviation in ms (measures jitter) */
  stddevMs: number;
  /** Number of failures */
  failures: number;
}

/** Full stats report */
export interface PerfStatsReport {
  /** When the report was generated */
  generatedAt: string;
  /** Date range covered */
  fromDate: string;
  toDate: string;
  /** Total number of entries analyzed */
  totalEntries: number;
  /** Per-operation stats, sorted by call count descending */
  operations: PerfOperationStats[];
}

const RETENTION_DAYS = 7;
const PERF_LOG_DIR = "perf-logs";

/** Get the perf log directory path */
function getPerfLogDir(dataDir: string): string {
  return join(dataDir, PERF_LOG_DIR);
}

/** Get today's date string (YYYY-MM-DD) */
function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get the log file path for a given date */
function logFilePath(dataDir: string, dateStr: string): string {
  return join(getPerfLogDir(dataDir), `${dateStr}.jsonl`);
}

/**
 * Prune log files older than the retention period.
 * Called on each write to keep the directory clean.
 */
export function pruneOldLogs(dataDir: string): void {
  const dir = getPerfLogDir(dataDir);
  if (!existsSync(dir)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const dateStr = file.replace(".jsonl", "");
      if (dateStr < cutoffStr) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          // Best effort
        }
      }
    }
  } catch {
    // Best effort
  }
}

/**
 * Record a performance log entry.
 *
 * @param dataDir - The ADIT data directory (.adit/)
 * @param entry - The performance entry to record
 */
export function recordPerf(dataDir: string, entry: PerfEntry): void {
  try {
    const dir = getPerfLogDir(dataDir);
    mkdirSync(dir, { recursive: true });

    const filePath = logFilePath(dataDir, todayDateStr());
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(filePath, line, "utf-8");

    // Prune old logs (best effort, non-blocking)
    pruneOldLogs(dataDir);
  } catch {
    // Fail-open: never let perf logging break the application
  }
}

/**
 * Wrap an async function with performance logging.
 *
 * @param dataDir - The ADIT data directory (.adit/)
 * @param category - Category of the operation
 * @param operation - Name of the operation
 * @param fn - The async function to measure
 * @returns The result of the function
 */
export async function withPerf<T>(
  dataDir: string,
  category: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const timestamp = new Date().toISOString();
  try {
    const result = await fn();
    recordPerf(dataDir, {
      timestamp,
      category,
      operation,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
      success: true,
    });
    return result;
  } catch (err) {
    recordPerf(dataDir, {
      timestamp,
      category,
      operation,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Wrap a sync function with performance logging.
 */
export function withPerfSync<T>(
  dataDir: string,
  category: string,
  operation: string,
  fn: () => T,
): T {
  const start = performance.now();
  const timestamp = new Date().toISOString();
  try {
    const result = fn();
    recordPerf(dataDir, {
      timestamp,
      category,
      operation,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
      success: true,
    });
    return result;
  } catch (err) {
    recordPerf(dataDir, {
      timestamp,
      category,
      operation,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Read all perf log entries within the retention window.
 *
 * @param dataDir - The ADIT data directory (.adit/)
 * @param fromDate - Optional start date (YYYY-MM-DD). Defaults to 7 days ago.
 * @param toDate - Optional end date (YYYY-MM-DD). Defaults to today.
 * @returns Array of perf entries
 */
export function readPerfLogs(
  dataDir: string,
  fromDate?: string,
  toDate?: string,
): PerfEntry[] {
  const dir = getPerfLogDir(dataDir);
  if (!existsSync(dir)) return [];

  const today = todayDateStr();
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - RETENTION_DAYS);
  const from = fromDate ?? defaultFrom.toISOString().slice(0, 10);
  const to = toDate ?? today;

  const entries: PerfEntry[] = [];

  try {
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      const dateStr = file.replace(".jsonl", "");
      if (dateStr < from || dateStr > to) continue;

      const content = readFileSync(join(dir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as PerfEntry);
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch {
    // Return whatever we collected
  }

  return entries;
}

/**
 * Generate a stats report from perf log entries.
 *
 * @param entries - Array of perf entries to analyze
 * @returns Stats report with per-operation aggregations
 */
export function generatePerfStats(entries: PerfEntry[]): PerfStatsReport {
  const now = new Date().toISOString();

  if (entries.length === 0) {
    return {
      generatedAt: now,
      fromDate: "",
      toDate: "",
      totalEntries: 0,
      operations: [],
    };
  }

  // Find date range
  const timestamps = entries.map((e) => e.timestamp).sort();
  const fromDate = timestamps[0].slice(0, 10);
  const toDate = timestamps[timestamps.length - 1].slice(0, 10);

  // Group by category:operation
  const groups = new Map<string, PerfEntry[]>();
  for (const entry of entries) {
    const key = `${entry.category}:${entry.operation}`;
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  // Compute per-operation stats
  const operations: PerfOperationStats[] = [];
  for (const [, group] of groups) {
    const durations = group.map((e) => e.durationMs).sort((a, b) => a - b);
    const totalMs = durations.reduce((sum, d) => sum + d, 0);
    const avgMs = totalMs / group.length;
    const p95Index = Math.min(
      Math.ceil(durations.length * 0.95) - 1,
      durations.length - 1,
    );

    // Standard deviation
    const variance =
      group.length > 1
        ? durations.reduce((sum, d) => sum + (d - avgMs) ** 2, 0) /
          (group.length - 1)
        : 0;
    const stddevMs = Math.round(Math.sqrt(variance) * 100) / 100;

    operations.push({
      category: group[0].category,
      operation: group[0].operation,
      count: group.length,
      avgMs: Math.round(avgMs * 100) / 100,
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
      p95Ms: durations[p95Index],
      stddevMs,
      failures: group.filter((e) => !e.success).length,
    });
  }

  // Sort by call count descending
  operations.sort((a, b) => b.count - a.count);

  return {
    generatedAt: now,
    fromDate,
    toDate,
    totalEntries: entries.length,
    operations,
  };
}

/**
 * Clear all performance logs.
 *
 * @param dataDir - The ADIT data directory (.adit/)
 * @returns Number of files deleted
 */
export function clearPerfLogs(dataDir: string): number {
  const dir = getPerfLogDir(dataDir);
  if (!existsSync(dir)) return 0;

  let count = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        unlinkSync(join(dir, file));
        count++;
      } catch {
        // Best effort
      }
    }
  } catch {
    // Best effort
  }

  return count;
}
