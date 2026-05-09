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
});
