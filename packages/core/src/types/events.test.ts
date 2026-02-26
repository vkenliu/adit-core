import { describe, it, expect } from "vitest";
import { parseLabels, parseDiffStats, parseError } from "./events.js";

describe("Event type helpers", () => {
  describe("parseLabels", () => {
    it("parses valid JSON array", () => {
      expect(parseLabels('["a", "b"]')).toEqual(["a", "b"]);
    });

    it("returns empty array for null", () => {
      expect(parseLabels(null)).toEqual([]);
    });

    it("returns empty array for invalid JSON", () => {
      expect(parseLabels("not json")).toEqual([]);
    });
  });

  describe("parseDiffStats", () => {
    it("parses file stats", () => {
      const json = JSON.stringify([
        { path: "src/index.ts", status: "M", additions: 5, deletions: 2 },
      ]);
      const stats = parseDiffStats(json);
      expect(stats).toHaveLength(1);
      expect(stats[0].path).toBe("src/index.ts");
      expect(stats[0].additions).toBe(5);
    });

    it("returns empty for null", () => {
      expect(parseDiffStats(null)).toEqual([]);
    });
  });

  describe("parseError", () => {
    it("parses error object", () => {
      const json = JSON.stringify({
        category: "tool_failure",
        message: "Command failed",
      });
      const err = parseError(json);
      expect(err).not.toBeNull();
      expect(err!.category).toBe("tool_failure");
    });

    it("returns null for null input", () => {
      expect(parseError(null)).toBeNull();
    });
  });
});
