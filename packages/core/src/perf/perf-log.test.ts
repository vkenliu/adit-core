import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
  recordPerf,
  withPerf,
  withPerfSync,
  readPerfLogs,
  generatePerfStats,
  clearPerfLogs,
  pruneOldLogs,
  type PerfEntry,
} from "./perf-log.js";

function tempDataDir(): string {
  const dir = join(tmpdir(), `adit-perf-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Performance Logging", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = tempDataDir();
  });

  afterEach(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  describe("recordPerf", () => {
    it("creates perf-logs directory and writes entry", () => {
      const entry: PerfEntry = {
        timestamp: new Date().toISOString(),
        category: "hook",
        operation: "prompt-submit",
        durationMs: 42.5,
        success: true,
      };

      recordPerf(dataDir, entry);

      const logDir = join(dataDir, "perf-logs");
      expect(existsSync(logDir)).toBe(true);

      const files = readdirSync(logDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

      const content = readFileSync(join(logDir, files[0]), "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.category).toBe("hook");
      expect(parsed.operation).toBe("prompt-submit");
      expect(parsed.durationMs).toBe(42.5);
      expect(parsed.success).toBe(true);
    });

    it("appends multiple entries to the same file", () => {
      recordPerf(dataDir, {
        timestamp: new Date().toISOString(),
        category: "hook",
        operation: "stop",
        durationMs: 100,
        success: true,
      });

      recordPerf(dataDir, {
        timestamp: new Date().toISOString(),
        category: "git",
        operation: "getChangedFiles",
        durationMs: 200,
        success: true,
      });

      const logDir = join(dataDir, "perf-logs");
      const files = readdirSync(logDir);
      expect(files).toHaveLength(1);

      const lines = readFileSync(join(logDir, files[0]), "utf-8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(2);
    });

    it("records error entries", () => {
      recordPerf(dataDir, {
        timestamp: new Date().toISOString(),
        category: "network",
        operation: "cloud-sync",
        durationMs: 5000,
        success: false,
        error: "Connection timeout",
      });

      const entries = readPerfLogs(dataDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].success).toBe(false);
      expect(entries[0].error).toBe("Connection timeout");
    });
  });

  describe("withPerf", () => {
    it("records timing for successful async operation", async () => {
      const result = await withPerf(dataDir, "hook", "test-op", async () => {
        return 42;
      });

      expect(result).toBe(42);

      const entries = readPerfLogs(dataDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].category).toBe("hook");
      expect(entries[0].operation).toBe("test-op");
      expect(entries[0].success).toBe(true);
      expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("records timing for failed async operation and re-throws", async () => {
      await expect(
        withPerf(dataDir, "git", "fail-op", async () => {
          throw new Error("test error");
        }),
      ).rejects.toThrow("test error");

      const entries = readPerfLogs(dataDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].success).toBe(false);
      expect(entries[0].error).toBe("test error");
    });
  });

  describe("withPerfSync", () => {
    it("records timing for successful sync operation", () => {
      const result = withPerfSync(dataDir, "snapshot", "sync-op", () => {
        return "hello";
      });

      expect(result).toBe("hello");

      const entries = readPerfLogs(dataDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].category).toBe("snapshot");
      expect(entries[0].success).toBe(true);
    });

    it("records timing for failed sync operation and re-throws", () => {
      expect(() =>
        withPerfSync(dataDir, "git", "fail-sync", () => {
          throw new Error("sync error");
        }),
      ).toThrow("sync error");

      const entries = readPerfLogs(dataDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].success).toBe(false);
      expect(entries[0].error).toBe("sync error");
    });
  });

  describe("readPerfLogs", () => {
    it("returns empty array when no logs exist", () => {
      const entries = readPerfLogs(dataDir);
      expect(entries).toEqual([]);
    });

    it("reads entries from multiple day files", () => {
      const logDir = join(dataDir, "perf-logs");
      mkdirSync(logDir, { recursive: true });

      const today = new Date().toISOString().slice(0, 10);
      const entry1: PerfEntry = {
        timestamp: new Date().toISOString(),
        category: "hook",
        operation: "op1",
        durationMs: 10,
        success: true,
      };

      writeFileSync(
        join(logDir, `${today}.jsonl`),
        JSON.stringify(entry1) + "\n",
      );

      const entries = readPerfLogs(dataDir);
      expect(entries).toHaveLength(1);
    });

    it("filters by date range", () => {
      const logDir = join(dataDir, "perf-logs");
      mkdirSync(logDir, { recursive: true });

      const entry: PerfEntry = {
        timestamp: "2025-01-15T12:00:00Z",
        category: "hook",
        operation: "op1",
        durationMs: 10,
        success: true,
      };

      writeFileSync(
        join(logDir, "2025-01-15.jsonl"),
        JSON.stringify(entry) + "\n",
      );
      writeFileSync(
        join(logDir, "2025-01-16.jsonl"),
        JSON.stringify({ ...entry, timestamp: "2025-01-16T12:00:00Z" }) + "\n",
      );

      const filtered = readPerfLogs(dataDir, "2025-01-16", "2025-01-16");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].timestamp).toContain("2025-01-16");
    });

    it("skips malformed lines", () => {
      const logDir = join(dataDir, "perf-logs");
      mkdirSync(logDir, { recursive: true });

      const today = new Date().toISOString().slice(0, 10);
      const goodEntry: PerfEntry = {
        timestamp: new Date().toISOString(),
        category: "hook",
        operation: "op1",
        durationMs: 10,
        success: true,
      };

      writeFileSync(
        join(logDir, `${today}.jsonl`),
        JSON.stringify(goodEntry) + "\nnot-valid-json\n" + JSON.stringify(goodEntry) + "\n",
      );

      const entries = readPerfLogs(dataDir);
      expect(entries).toHaveLength(2);
    });
  });

  describe("generatePerfStats", () => {
    it("returns empty report for no entries", () => {
      const report = generatePerfStats([]);
      expect(report.totalEntries).toBe(0);
      expect(report.operations).toEqual([]);
    });

    it("computes correct stats for single operation", () => {
      const entries: PerfEntry[] = [
        { timestamp: "2025-01-15T12:00:00Z", category: "hook", operation: "stop", durationMs: 100, success: true },
        { timestamp: "2025-01-15T12:01:00Z", category: "hook", operation: "stop", durationMs: 200, success: true },
        { timestamp: "2025-01-15T12:02:00Z", category: "hook", operation: "stop", durationMs: 300, success: false, error: "timeout" },
      ];

      const report = generatePerfStats(entries);

      expect(report.totalEntries).toBe(3);
      expect(report.operations).toHaveLength(1);

      const op = report.operations[0];
      expect(op.category).toBe("hook");
      expect(op.operation).toBe("stop");
      expect(op.count).toBe(3);
      expect(op.avgMs).toBe(200);
      expect(op.minMs).toBe(100);
      expect(op.maxMs).toBe(300);
      expect(op.totalMs).toBe(600);
      expect(op.failures).toBe(1);
    });

    it("computes stats for multiple operations sorted by total time", () => {
      const entries: PerfEntry[] = [
        { timestamp: "2025-01-15T12:00:00Z", category: "hook", operation: "stop", durationMs: 100, success: true },
        { timestamp: "2025-01-15T12:00:00Z", category: "git", operation: "getChangedFiles", durationMs: 500, success: true },
        { timestamp: "2025-01-15T12:00:00Z", category: "git", operation: "getChangedFiles", durationMs: 600, success: true },
      ];

      const report = generatePerfStats(entries);

      expect(report.operations).toHaveLength(2);
      // git:getChangedFiles should be first (higher total time)
      expect(report.operations[0].operation).toBe("getChangedFiles");
      expect(report.operations[0].totalMs).toBe(1100);
      expect(report.operations[1].operation).toBe("stop");
    });

    it("computes p95 correctly", () => {
      // 20 entries with values 1..20
      const entries: PerfEntry[] = Array.from({ length: 20 }, (_, i) => ({
        timestamp: "2025-01-15T12:00:00Z",
        category: "hook",
        operation: "op",
        durationMs: i + 1,
        success: true,
      }));

      const report = generatePerfStats(entries);
      expect(report.operations[0].p95Ms).toBe(19);
    });
  });

  describe("clearPerfLogs", () => {
    it("returns 0 when no logs exist", () => {
      const count = clearPerfLogs(dataDir);
      expect(count).toBe(0);
    });

    it("deletes all log files", () => {
      // Create some log files
      recordPerf(dataDir, {
        timestamp: new Date().toISOString(),
        category: "hook",
        operation: "op1",
        durationMs: 10,
        success: true,
      });

      const logDir = join(dataDir, "perf-logs");
      expect(readdirSync(logDir).length).toBeGreaterThan(0);

      const count = clearPerfLogs(dataDir);
      expect(count).toBe(1);
      expect(readdirSync(logDir).filter(f => f.endsWith(".jsonl"))).toHaveLength(0);
    });
  });

  describe("pruneOldLogs", () => {
    it("removes files older than 7 days", () => {
      const logDir = join(dataDir, "perf-logs");
      mkdirSync(logDir, { recursive: true });

      // Create a file for 10 days ago
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const oldDateStr = oldDate.toISOString().slice(0, 10);
      writeFileSync(join(logDir, `${oldDateStr}.jsonl`), '{"test":true}\n');

      // Create a file for today
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(join(logDir, `${today}.jsonl`), '{"test":true}\n');

      pruneOldLogs(dataDir);

      const remaining = readdirSync(logDir);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toBe(`${today}.jsonl`);
    });

    it("keeps files within retention window", () => {
      const logDir = join(dataDir, "perf-logs");
      mkdirSync(logDir, { recursive: true });

      // Create a file for 3 days ago (within 7-day window)
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 3);
      const recentDateStr = recentDate.toISOString().slice(0, 10);
      writeFileSync(join(logDir, `${recentDateStr}.jsonl`), '{"test":true}\n');

      pruneOldLogs(dataDir);

      const remaining = readdirSync(logDir);
      expect(remaining).toHaveLength(1);
    });
  });
});
