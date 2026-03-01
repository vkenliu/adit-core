/**
 * `adit perf` — Performance stats for time-sensitive operations.
 *
 * Reads daily JSONL perf logs from .adit/perf-logs/ and generates
 * an aggregated stats report showing call counts, timing distributions,
 * and failure rates.
 */

import {
  loadConfig,
  readPerfLogs,
  generatePerfStats,
  clearPerfLogs,
  type PerfStatsReport,
} from "@adit/core";

/** Show performance stats report */
export function perfCommand(opts?: {
  from?: string;
  to?: string;
  category?: string;
  json?: boolean;
}): void {
  const config = loadConfig();
  const entries = readPerfLogs(config.dataDir, opts?.from, opts?.to);

  // Filter by category if specified
  const filtered = opts?.category
    ? entries.filter((e) => e.category === opts.category)
    : entries;

  const report = generatePerfStats(filtered);

  if (opts?.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}

/** Clear all performance logs */
export function perfClearCommand(opts?: { json?: boolean }): void {
  const config = loadConfig();
  const deleted = clearPerfLogs(config.dataDir);

  if (opts?.json) {
    console.log(JSON.stringify({ cleared: deleted }));
    return;
  }

  if (deleted === 0) {
    console.log("No performance logs to clear.");
  } else {
    console.log(`Cleared ${deleted} log file${deleted === 1 ? "" : "s"}.`);
  }
}

/** Print a formatted stats report to the terminal */
function printReport(report: PerfStatsReport): void {
  if (report.totalEntries === 0) {
    console.log("No performance data recorded yet.");
    console.log("Performance logs are automatically captured during hook events.");
    return;
  }

  console.log("ADIT Performance Report");
  console.log("=======================");
  console.log();
  console.log(`Period:      ${report.fromDate} to ${report.toDate}`);
  console.log(`Total calls: ${report.totalEntries}`);
  console.log();

  // Table header
  const colCategory = 12;
  const colOperation = 24;
  const colCount = 7;
  const colAvg = 10;
  const colMin = 10;
  const colMax = 10;
  const colP95 = 10;
  const colStddev = 10;
  const colFail = 6;

  const header = [
    padRight("Category", colCategory),
    padRight("Operation", colOperation),
    padLeft("Count", colCount),
    padLeft("Avg (ms)", colAvg),
    padLeft("Min (ms)", colMin),
    padLeft("Max (ms)", colMax),
    padLeft("P95 (ms)", colP95),
    padLeft("StdDev", colStddev),
    padLeft("Fail", colFail),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const op of report.operations) {
    const row = [
      padRight(op.category, colCategory),
      padRight(op.operation, colOperation),
      padLeft(String(op.count), colCount),
      padLeft(formatMs(op.avgMs), colAvg),
      padLeft(formatMs(op.minMs), colMin),
      padLeft(formatMs(op.maxMs), colMax),
      padLeft(formatMs(op.p95Ms), colP95),
      padLeft(formatMs(op.stddevMs), colStddev),
      padLeft(op.failures > 0 ? String(op.failures) : "-", colFail),
    ].join("  ");

    console.log(row);
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + " ".repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str : " ".repeat(len - str.length) + str;
}

function formatMs(ms: number): string {
  if (ms >= 1000) {
    return (ms / 1000).toFixed(2) + "s";
  }
  return ms.toFixed(2);
}
