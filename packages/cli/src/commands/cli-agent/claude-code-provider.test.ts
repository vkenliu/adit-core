import { describe, expect, it } from "vitest";
import {
  buildClaudeCloudRelayEnv,
  normalizeClaudeTodoWriteInput,
} from "./claude-code-provider.js";

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

describe("buildClaudeCloudRelayEnv", () => {
  it("disables inherited ADIT cloud side effects for relay-managed Claude hooks", () => {
    const env = buildClaudeCloudRelayEnv({
      TERM: "screen-256color",
      ADIT_CLOUD_AUTO_SYNC: "true",
      ADIT_PROJECT_LINK_AUTO_SYNC: "true",
      ADIT_TRANSCRIPT_UPLOAD: "true",
    });

    expect(env.TERM).toBe("screen-256color");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.ADIT_CLOUD_AUTO_SYNC).toBe("false");
    expect(env.ADIT_PROJECT_LINK_AUTO_SYNC).toBe("false");
    expect(env.ADIT_TRANSCRIPT_UPLOAD).toBe("false");
  });

  it("keeps color defaults for Claude child processes", () => {
    const env = buildClaudeCloudRelayEnv({});

    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.FORCE_COLOR).toBe("3");
  });
});
