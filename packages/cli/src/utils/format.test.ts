/**
 * Tests for shared terminal formatting utilities.
 */

import { describe, it, expect } from "vitest";
import {
  padRight,
  padLeft,
  timeAgo,
  formatDateTime,
  horizontalRule,
  sectionHeader,
  statusDot,
  joinDim,
} from "./format.js";

describe("padRight", () => {
  it("pads short strings with spaces", () => {
    expect(padRight("abc", 6)).toBe("abc   ");
  });

  it("truncates strings longer than target", () => {
    expect(padRight("abcdef", 3)).toBe("abc");
  });

  it("returns string as-is when exact length", () => {
    expect(padRight("abc", 3)).toBe("abc");
  });
});

describe("padLeft", () => {
  it("pads short strings with leading spaces", () => {
    expect(padLeft("42", 5)).toBe("   42");
  });

  it("returns string as-is when longer than target", () => {
    expect(padLeft("abcdef", 3)).toBe("abcdef");
  });
});

describe("timeAgo", () => {
  it("returns 'just now' for recent timestamps", () => {
    const now = new Date();
    expect(timeAgo(now)).toBe("just now");
  });

  it("returns minutes for timestamps under an hour ago", () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    expect(timeAgo(thirtyMinAgo)).toBe("30m ago");
  });

  it("returns hours for timestamps under a day ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(timeAgo(threeHoursAgo)).toBe("3h ago");
  });

  it("returns days for timestamps over a day ago", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(timeAgo(twoDaysAgo)).toBe("2d ago");
  });

  it("accepts ISO string input", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(timeAgo(fiveMinAgo)).toBe("5m ago");
  });
});

describe("formatDateTime", () => {
  it("formats an ISO date into MM/DD HH:MM:SS", () => {
    // Use a fixed date to avoid locale issues
    const result = formatDateTime("2026-03-08T14:32:01.000Z");
    // The exact output depends on timezone, but it should contain a date and time
    expect(result).toMatch(/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it("handles malformed dates gracefully", () => {
    const result = formatDateTime("not-a-date");
    // Falls back to substring extraction
    expect(typeof result).toBe("string");
  });
});

describe("horizontalRule", () => {
  it("creates a line of box-drawing characters", () => {
    const rule = horizontalRule(10);
    // Contains ANSI codes from pc.dim + 10 horizontal line chars
    expect(rule).toContain("\u2500");
  });

  it("respects custom width", () => {
    const rule5 = horizontalRule(5);
    const rule20 = horizontalRule(20);
    expect(rule20.length).toBeGreaterThan(rule5.length);
  });
});

describe("sectionHeader", () => {
  it("includes the label text", () => {
    const header = sectionHeader("Session", 30);
    expect(header).toContain("Session");
  });

  it("includes box-drawing characters", () => {
    const header = sectionHeader("Git", 30);
    expect(header).toContain("\u2500");
  });
});

describe("statusDot", () => {
  it("returns a filled circle for active", () => {
    const dot = statusDot(true);
    expect(dot).toContain("\u25cf");
  });

  it("returns an outlined circle for inactive", () => {
    const dot = statusDot(false);
    expect(dot).toContain("\u25cb");
  });
});

describe("joinDim", () => {
  it("joins non-empty parts with a separator", () => {
    const result = joinDim(["a", "b", "c"]);
    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).toContain("c");
    // Contains the middle dot separator
    expect(result).toContain("\u00b7");
  });

  it("filters out falsy values", () => {
    const result = joinDim(["a", null, undefined, false, "b"]);
    expect(result).toContain("a");
    expect(result).toContain("b");
    // Should not contain extra separators for filtered values
    const separatorCount = (result.match(/\u00b7/g) ?? []).length;
    expect(separatorCount).toBe(1);
  });

  it("returns empty string for all-falsy input", () => {
    const result = joinDim([null, undefined, false]);
    expect(result).toBe("");
  });
});
