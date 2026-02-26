import { describe, it, expect } from "vitest";
import {
  createClock,
  tick,
  merge,
  compare,
  serialize,
  deserialize,
} from "./vclock.js";

describe("VectorClock", () => {
  it("creates a new clock with initial tick", () => {
    const clock = createClock("client-a");
    expect(clock).toEqual({ "client-a": 1 });
  });

  it("increments the correct client counter", () => {
    const clock = createClock("client-a");
    const ticked = tick(clock, "client-a");
    expect(ticked).toEqual({ "client-a": 2 });
  });

  it("adds a new client on tick", () => {
    const clock = createClock("client-a");
    const ticked = tick(clock, "client-b");
    expect(ticked).toEqual({ "client-a": 1, "client-b": 1 });
  });

  it("merges two clocks taking max of each", () => {
    const a = { "client-a": 3, "client-b": 1 };
    const b = { "client-a": 1, "client-b": 5, "client-c": 2 };
    const merged = merge(a, b);
    expect(merged).toEqual({ "client-a": 3, "client-b": 5, "client-c": 2 });
  });

  describe("compare", () => {
    it("returns 1 when a > b", () => {
      const a = { "client-a": 3, "client-b": 2 };
      const b = { "client-a": 1, "client-b": 1 };
      expect(compare(a, b)).toBe(1);
    });

    it("returns -1 when a < b", () => {
      const a = { "client-a": 1 };
      const b = { "client-a": 3 };
      expect(compare(a, b)).toBe(-1);
    });

    it("returns 0 for concurrent clocks", () => {
      const a = { "client-a": 2, "client-b": 1 };
      const b = { "client-a": 1, "client-b": 2 };
      expect(compare(a, b)).toBe(0);
    });

    it("returns 0 for equal clocks", () => {
      const a = { "client-a": 2, "client-b": 2 };
      const b = { "client-a": 2, "client-b": 2 };
      expect(compare(a, b)).toBe(0);
    });

    it("handles missing keys correctly", () => {
      const a = { "client-a": 1 };
      const b = { "client-b": 1 };
      expect(compare(a, b)).toBe(0); // concurrent
    });
  });

  it("round-trips through serialize/deserialize", () => {
    const clock = { "client-a": 5, "client-b": 3 };
    const json = serialize(clock);
    const restored = deserialize(json);
    expect(restored).toEqual(clock);
  });

  it("deserialize handles invalid JSON", () => {
    expect(deserialize("not json")).toEqual({});
  });
});
