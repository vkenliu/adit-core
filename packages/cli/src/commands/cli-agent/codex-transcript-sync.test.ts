import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodexRelayEventDeduper, CodexTranscriptSync } from "./codex-transcript-sync.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-transcript-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("CodexTranscriptSync", () => {
  it("drains assistant messages and tool calls from Codex jsonl transcripts", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019e0d36-9fd9-7c40-add5-01d6d8bc49d3.jsonl");
      const sync = new CodexTranscriptSync();
      const sessionId = "019e0d36-9fd9-7c40-add5-01d6d8bc49d3";

      sync.noteHook({
        eventType: "SessionStart",
        body: { session_id: sessionId, transcript_path: transcriptPath },
      });
      sync.noteHook({
        eventType: "UserPromptSubmit",
        body: { session_id: sessionId, transcript_path: transcriptPath, prompt: "check files" },
      });

      const timestamp = new Date(Date.now() + 50).toISOString();
      const lines = [
        {
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will inspect the files." }],
          },
        },
        {
          timestamp,
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call_list",
            arguments: JSON.stringify({ cmd: "ls", workdir: "/project" }),
          },
        },
        {
          timestamp,
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_list",
            output: "file-a\nfile-b",
          },
        },
        {
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }],
          },
        },
      ];
      writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"));

      const events = sync.drainSession(sessionId);

      expect(events.map((event) => event.type)).toEqual([
        "message",
        "tool",
        "tool",
        "message",
      ]);
      expect(events[0]?.payload).toMatchObject({
        role: "assistant",
        sessionId,
        text: "I will inspect the files.",
      });
      expect(events[1]?.payload).toMatchObject({
        sessionId,
        toolUseId: "call_list",
        toolName: "exec_command",
        input: { cmd: "ls", workdir: "/project" },
        status: "running",
      });
      expect(events[2]?.payload).toMatchObject({
        sessionId,
        toolUseId: "call_list",
        output: "file-a\nfile-b",
        status: "completed",
      });
      expect(events[3]?.payload).toMatchObject({
        role: "assistant",
        sessionId,
        text: "Done.",
      });
      expect(sync.drainSession(sessionId)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits todo snapshots from Codex update_plan transcript calls", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019e0d36-9fd9-7c40-add5-01d6d8bc49d3.jsonl");
      const sync = new CodexTranscriptSync();
      const sessionId = "019e0d36-9fd9-7c40-add5-01d6d8bc49d3";

      sync.noteHook({
        eventType: "SessionStart",
        body: { session_id: sessionId, transcript_path: transcriptPath },
      });
      sync.noteHook({
        eventType: "UserPromptSubmit",
        body: { session_id: sessionId, transcript_path: transcriptPath, prompt: "make a plan" },
      });

      const timestamp = new Date(Date.now() + 50).toISOString();
      writeFileSync(transcriptPath, `${JSON.stringify({
        timestamp,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "update_plan",
          call_id: "call_plan",
          arguments: JSON.stringify({
            plan: [
              { step: "Read docs", status: "completed" },
              { step: "Inspect files", status: "in_progress" },
              { step: "Summarize", status: "pending" },
            ],
            explanation: "Tracking project analysis.",
          }),
        },
      })}\n`);

      const events = sync.drainSession(sessionId);

      expect(events.map((event) => event.type)).toEqual(["tool", "todos.updated"]);
      expect(events[0]?.payload).toMatchObject({
        sessionId,
        toolUseId: "call_plan",
        toolName: "update_plan",
        status: "running",
      });
      expect(events[1]?.payload).toMatchObject({
        sessionId,
        messageId: `codex-local-tools-${sessionId}`,
        toolUseId: "call_plan",
        scopeId: "main",
        explanation: "Tracking project analysis.",
        todos: [
          { id: "plan-1", content: "Read docs", status: "completed" },
          { id: "plan-2", content: "Inspect files", status: "in_progress" },
          { id: "plan-3", content: "Summarize", status: "pending" },
        ],
      });
      expect(sync.drainSession(sessionId)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits todo snapshots from Codex update_plan hook fallback", () => {
    const sync = new CodexTranscriptSync();
    const sessionId = "019e0d36-9fd9-7c40-add5-01d6d8bc49d3";

    const events = sync.toolEvents(sessionId, {
      tool_name: "update_plan",
      tool_input: {
        plan: [
          { step: "Read docs", status: "pending" },
          { step: "Inspect files", status: "pending" },
        ],
      },
      tool_response: "Plan updated",
    });

    expect(events.map((event) => event.type)).toEqual(["tool", "todos.updated"]);
    expect(events[1]?.payload).toMatchObject({
      sessionId,
      scopeId: "main",
      todos: [
        { id: "plan-1", content: "Read docs", status: "pending" },
        { id: "plan-2", content: "Inspect files", status: "pending" },
      ],
    });
    expect(sync.toolEvents(sessionId, {
      tool_name: "update_plan",
      tool_input: {
        plan: [
          { step: "Read docs", status: "pending" },
          { step: "Inspect files", status: "pending" },
        ],
      },
      tool_response: "Plan updated",
    })).toEqual([]);
  });

  it("starts replaying from the transcript position captured at SessionStart", () => {
    const dir = tempDir();
    try {
      const transcriptPath = join(dir, "019e0d64-cd63-7a40-8305-10c38d9b48d6.jsonl");
      const sync = new CodexTranscriptSync();
      const sessionId = "019e0d64-cd63-7a40-8305-10c38d9b48d6";
      const timestamp = new Date().toISOString();

      writeFileSync(transcriptPath, `${JSON.stringify({
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Old answer" }],
        },
      })}\n`);

      sync.noteHook({
        eventType: "SessionStart",
        body: { session_id: sessionId, transcript_path: transcriptPath },
      });

      appendFileSync(transcriptPath, `${JSON.stringify({
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Fresh answer" }],
        },
      })}\n`);

      const events = sync.drainSession(sessionId);

      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        role: "assistant",
        sessionId,
        text: "Fresh answer",
      });
      expect(sync.drainSession(sessionId)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CodexRelayEventDeduper", () => {
  it("drops replayed assistant messages in the same user turn and rewrites usage to the kept message", () => {
    const deduper = new CodexRelayEventDeduper();
    const sessionId = "019e0d89-8aec-70f1-b6da-9a2a5ba78a47";

    expect(deduper.filter({
      type: "message",
      payload: { role: "user", sessionId, text: "hi" },
    })).not.toBeNull();

    const kept = deduper.filter({
      type: "message",
      payload: {
        role: "assistant",
        sessionId,
        messageId: "codex-local-answer",
        text: "Hi. What would you like to work on?",
      },
    });
    expect(kept).not.toBeNull();

    expect(deduper.filter({
      type: "message",
      payload: {
        role: "assistant",
        sessionId,
        messageId: "item-2",
        modelId: "gpt-5.5",
        text: "Hi. What would you like to work on?",
      },
    })).toBeNull();

    const usage = deduper.filter({
      type: "usage",
      payload: {
        sessionId,
        messageId: "item-2",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    });

    expect(usage?.payload).toMatchObject({
      sessionId,
      messageId: "codex-local-answer",
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    deduper.filter({
      type: "message",
      payload: { role: "user", sessionId, text: "hello" },
    });
    expect(deduper.filter({
      type: "message",
      payload: {
        role: "assistant",
        sessionId,
        messageId: "item-2",
        modelId: "gpt-5.5",
        text: "Hi. What would you like to work on?",
      },
    })).toBeNull();

    expect(deduper.filter({
      type: "message",
      payload: {
        role: "assistant",
        sessionId,
        messageId: "item-4",
        modelId: "gpt-5.5",
        text: "Hi. What would you like to work on?",
      },
    })).toBeNull();
  });

  it("allows identical assistant text in a later user turn", () => {
    const deduper = new CodexRelayEventDeduper();
    const sessionId = "019e0d89-8aec-70f1-b6da-9a2a5ba78a47";

    deduper.filter({ type: "message", payload: { role: "user", sessionId, text: "one" } });
    expect(deduper.filter({
      type: "message",
      payload: { role: "assistant", sessionId, messageId: "msg-1", text: "OK" },
    })).not.toBeNull();

    deduper.filter({ type: "message", payload: { role: "user", sessionId, text: "two" } });
    expect(deduper.filter({
      type: "message",
      payload: { role: "assistant", sessionId, messageId: "msg-2", text: "OK" },
    })).not.toBeNull();
  });

  it("drops duplicate todo snapshots and rewrites aliased message ids", () => {
    const deduper = new CodexRelayEventDeduper();
    const sessionId = "019e0d89-8aec-70f1-b6da-9a2a5ba78a47";
    const todos = [
      { id: "plan-1", content: "Read docs", status: "completed" },
      { id: "plan-2", content: "Summarize", status: "in_progress" },
    ];

    deduper.filter({ type: "message", payload: { role: "user", sessionId, text: "plan" } });
    expect(deduper.filter({
      type: "message",
      payload: {
        role: "assistant",
        sessionId,
        messageId: "codex-web-answer",
        text: "Working on it.",
      },
    })).not.toBeNull();
    expect(deduper.filter({
      type: "message",
      payload: {
        role: "assistant",
        sessionId,
        messageId: "item-2",
        text: "Working on it.",
      },
    })).toBeNull();

    const kept = deduper.filter({
      type: "todos.updated",
      payload: {
        sessionId,
        messageId: "item-2",
        scopeId: "main",
        todos,
      },
    });

    expect(kept?.payload).toMatchObject({
      sessionId,
      messageId: "codex-web-answer",
      scopeId: "main",
      todos,
    });
    expect(deduper.filter({
      type: "todos.updated",
      payload: {
        sessionId,
        messageId: "codex-web-answer",
        scopeId: "main",
        todos,
      },
    })).toBeNull();

    deduper.filter({ type: "message", payload: { role: "user", sessionId, text: "plan again" } });
    expect(deduper.filter({
      type: "todos.updated",
      payload: {
        sessionId,
        messageId: "codex-web-answer",
        scopeId: "main",
        todos,
      },
    })).not.toBeNull();
  });
});
