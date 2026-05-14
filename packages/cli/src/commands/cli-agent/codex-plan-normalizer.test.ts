import { describe, expect, it } from "vitest";
import { normalizeCodexUpdatePlanInput, parseCodexToolInput } from "./codex-plan-normalizer.js";

describe("normalizeCodexUpdatePlanInput", () => {
  it("normalizes Codex update_plan input", () => {
    expect(
      normalizeCodexUpdatePlanInput({
        plan: [
          { step: "Read project docs", status: "completed" },
          { step: "Inspect main files", status: "in_progress", priority: "high" },
          { step: "Summarize project type", status: "pending" },
        ],
        explanation: "Checking the project shape.",
      }),
    ).toEqual({
      todos: [
        {
          id: "plan-1",
          content: "Read project docs",
          status: "completed",
        },
        {
          id: "plan-2",
          content: "Inspect main files",
          status: "in_progress",
          priority: "high",
        },
        {
          id: "plan-3",
          content: "Summarize project type",
          status: "pending",
        },
      ],
      explanation: "Checking the project shape.",
    });
  });

  it("accepts JSON string arguments and status aliases", () => {
    expect(
      normalizeCodexUpdatePlanInput(JSON.stringify({
        plan: [
          { id: "a", step: "One", status: "done" },
          { id: "b", step: "Two", status: "doing", activeForm: "Doing two" },
          { id: "c", step: "Three", status: "not-started" },
        ],
      })),
    ).toEqual({
      todos: [
        { id: "a", content: "One", status: "completed" },
        { id: "b", content: "Two", status: "in_progress", activeForm: "Doing two" },
        { id: "c", content: "Three", status: "pending" },
      ],
    });
  });

  it("ignores malformed update_plan inputs", () => {
    expect(normalizeCodexUpdatePlanInput({ plan: [] })).toBeNull();
    expect(normalizeCodexUpdatePlanInput({ plan: [{ status: "pending" }] })).toBeNull();
    expect(normalizeCodexUpdatePlanInput({ plan: [{ step: "Missing status" }] })).toBeNull();
    expect(normalizeCodexUpdatePlanInput({})).toBeNull();
  });
});

describe("parseCodexToolInput", () => {
  it("parses object and JSON string tool input", () => {
    expect(parseCodexToolInput({ plan: [] })).toEqual({ plan: [] });
    expect(parseCodexToolInput("{\"plan\":[]}")).toEqual({ plan: [] });
    expect(parseCodexToolInput("raw")).toEqual({ value: "raw" });
  });
});
