import { describe, expect, it } from "vitest";
import { normalizeClaudeTodoWriteInput } from "./claude-code-provider.js";

describe("normalizeClaudeTodoWriteInput", () => {
  it("normalizes Claude TodoWrite input", () => {
    expect(
      normalizeClaudeTodoWriteInput({
        todos: [
          {
            id: "a",
            content: "Inspect auth flow",
            status: "in_progress",
            priority: "high",
            activeForm: "Inspecting auth flow",
          },
          {
            content: "Add regression test",
            status: "completed",
          },
        ],
      }),
    ).toEqual([
      {
        id: "a",
        content: "Inspect auth flow",
        status: "in_progress",
        priority: "high",
        activeForm: "Inspecting auth flow",
      },
      {
        id: "todo-1",
        content: "Add regression test",
        status: "completed",
      },
    ]);
  });

  it("distinguishes empty lists from malformed input", () => {
    expect(normalizeClaudeTodoWriteInput({ todos: [] })).toEqual([]);
    expect(normalizeClaudeTodoWriteInput({ todos: [{ status: "pending" }] })).toBeNull();
    expect(normalizeClaudeTodoWriteInput({})).toBeNull();
  });
});
