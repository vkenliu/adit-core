import { describe, it, expect } from "vitest";
import { generateId, generateIdAt, extractTimestamp } from "./ulid.js";

describe("ULID", () => {
  it("generates a 26-character string", () => {
    const id = generateId();
    expect(id).toHaveLength(26);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it("generates monotonically increasing IDs", () => {
    const ids = Array.from({ length: 10 }, () => generateId());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it("generates ID at specific timestamp", () => {
    const timestamp = 1700000000000;
    const id = generateIdAt(timestamp);
    expect(id).toHaveLength(26);
    expect(extractTimestamp(id)).toBe(timestamp);
  });

  it("extracts timestamp from ULID", () => {
    const before = Date.now();
    const id = generateId();
    const after = Date.now();
    const ts = extractTimestamp(id);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
