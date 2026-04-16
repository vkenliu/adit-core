/**
 * Tests for `adit list` command utilities.
 */

import { describe, it, expect } from "vitest";
import { sortEvents, type SortField } from "./list.js";
import type { AditEvent } from "@varveai/adit-core";

function makeEvent(overrides: Partial<AditEvent>): AditEvent {
  return {
    id: "01HX000000000000000000000",
    sessionId: "01HX000000000000000000001",
    parentEventId: null,
    sequence: 1,
    eventType: "tool_call",
    actor: "tool",
    promptText: null,
    cotText: null,
    responseText: null,
    toolName: null,
    toolInputJson: null,
    toolOutputJson: null,
    checkpointSha: null,
    checkpointRef: null,
    diffStatJson: null,
    gitBranch: "main",
    gitHeadSha: "abc1234",
    envSnapshotId: null,
    startedAt: "2026-01-01T10:00:00.000Z",
    endedAt: null,
    status: "success",
    errorJson: null,
    labelsJson: null,
    planTaskId: null,
    vclockJson: '{"node1":1}',
    deletedAt: null,
    ...overrides,
  };
}

describe("sortEvents", () => {
  const events: AditEvent[] = [
    makeEvent({
      id: "01HX000000000000000000AAA",
      sequence: 3,
      actor: "user",
      startedAt: "2026-01-01T10:02:00.000Z",
    }),
    makeEvent({
      id: "01HX000000000000000000BBB",
      sequence: 1,
      actor: "assistant",
      startedAt: "2026-01-01T10:00:00.000Z",
    }),
    makeEvent({
      id: "01HX000000000000000000CCC",
      sequence: 2,
      actor: "tool",
      startedAt: "2026-01-01T10:01:00.000Z",
    }),
  ];

  it("sorts by TIME descending (default)", () => {
    const sorted = sortEvents(events, "TIME");
    expect(sorted[0].id).toBe("01HX000000000000000000AAA"); // latest
    expect(sorted[1].id).toBe("01HX000000000000000000CCC");
    expect(sorted[2].id).toBe("01HX000000000000000000BBB"); // earliest
  });

  it("sorts by SEQ descending", () => {
    const sorted = sortEvents(events, "SEQ");
    expect(sorted[0].sequence).toBe(3);
    expect(sorted[1].sequence).toBe(2);
    expect(sorted[2].sequence).toBe(1);
  });

  it("sorts by ACTOR ascending (alphabetical)", () => {
    const sorted = sortEvents(events, "ACTOR");
    expect(sorted[0].actor).toBe("assistant");
    expect(sorted[1].actor).toBe("tool");
    expect(sorted[2].actor).toBe("user");
  });

  it("does not mutate the original array", () => {
    const original = [...events];
    sortEvents(events, "SEQ");
    expect(events[0].id).toBe(original[0].id);
    expect(events[1].id).toBe(original[1].id);
    expect(events[2].id).toBe(original[2].id);
  });

  it("handles empty array", () => {
    const sorted = sortEvents([], "TIME");
    expect(sorted).toEqual([]);
  });

  it("handles single-element array", () => {
    const single = [events[0]];
    const sorted = sortEvents(single, "SEQ");
    expect(sorted).toHaveLength(1);
    expect(sorted[0].id).toBe(events[0].id);
  });
});
