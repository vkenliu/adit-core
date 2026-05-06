import fs from "node:fs";
import type { CliAgentRelayEvent } from "./types.js";

interface TranscriptSession {
  id: string;
  startedAt: number;
  transcriptPath?: string;
  firstPromptAt?: number;
  seenKeys: Set<string>;
}

interface NoteHookInput {
  eventType: string;
  body: Record<string, unknown>;
  sessionId?: string | null;
}

const MAX_TEXT_LENGTH = 12_000;

export class ClaudeTranscriptSync {
  private readonly sessions = new Map<string, TranscriptSession>();

  noteHook(input: NoteHookInput): string | null {
    const sessionId = input.sessionId ?? readSessionId(input.body);
    if (!sessionId) return null;

    const session = this.ensureSession(sessionId);
    const transcriptPath = readString(input.body.transcript_path);
    if (transcriptPath) session.transcriptPath = transcriptPath;

    if (input.eventType === "SessionStart") {
      session.startedAt = Date.now();
    }

    if (input.eventType === "UserPromptSubmit" && !session.firstPromptAt) {
      session.firstPromptAt = Date.now();
    }

    return sessionId;
  }

  drainSession(sessionId: string | null | undefined): CliAgentRelayEvent[] {
    if (!sessionId) return [];
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return this.drainTranscript(session);
  }

  scheduleDrain(
    sessionId: string | null | undefined,
    pushEvent: (event: CliAgentRelayEvent) => void,
  ): void {
    if (!sessionId) return;
    const drain = () => {
      for (const event of this.drainSession(sessionId)) {
        pushEvent(event);
      }
    };
    drain();
    setTimeout(drain, 250);
    setTimeout(drain, 1000);
  }

  private ensureSession(id: string): TranscriptSession {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        startedAt: Date.now(),
        seenKeys: new Set<string>(),
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  private drainTranscript(session: TranscriptSession): CliAgentRelayEvent[] {
    if (!session.transcriptPath) return [];

    let text: string;
    try {
      text = fs.readFileSync(session.transcriptPath, "utf8");
    } catch {
      return [];
    }

    const captureAfter = session.firstPromptAt ?? session.startedAt;
    const events: CliAgentRelayEvent[] = [];

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;

      let obj: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) continue;
        obj = parsed;
      } catch {
        continue;
      }

      const lineTimestamp = parseTimestamp(obj.timestamp);
      if (lineTimestamp < captureAfter - 1000) continue;
      events.push(...this.transcriptObjectToEvents(session, obj, lineTimestamp));
    }

    return events;
  }

  private transcriptObjectToEvents(
    session: TranscriptSession,
    obj: Record<string, unknown>,
    timestamp: number,
  ): CliAgentRelayEvent[] {
    const type = readString(obj.type);
    if (type !== "assistant" && type !== "user") return [];

    const message = isRecord(obj.message) ? obj.message : null;
    const content = message?.content;
    const messageId = makeMessageId(obj, session.id);
    const modelId = readString(message?.model) ?? undefined;
    const events: CliAgentRelayEvent[] = [];

    if (type === "assistant" && typeof content === "string") {
      this.pushIfNew(
        session,
        obj,
        "assistant-text",
        0,
        content,
        events,
        assistantTextEvent(session.id, messageId, content, timestamp, modelId),
      );
      return events;
    }

    if (!Array.isArray(content)) return [];

    const assistantTextParts: string[] = [];
    const assistantTextIndexes: number[] = [];

    for (let index = 0; index < content.length; index++) {
      const part = content[index];
      if (!isRecord(part)) continue;

      const partType = readString(part.type);
      if (type === "assistant") {
        if (partType === "text") {
          const partText = readString(part.text);
          if (partText) {
            assistantTextParts.push(partText);
            assistantTextIndexes.push(index);
          }
          continue;
        }

        if (partType === "thinking") {
          const thinking = readString(part.thinking);
          if (!thinking) continue;
          this.pushIfNew(
            session,
            obj,
            "thinking",
            index,
            thinking,
            events,
            {
              type: "reasoning",
              payload: {
                sessionId: session.id,
                messageId,
                modelId,
                text: truncateText(thinking),
                createdAt: timestamp + index,
              },
            },
          );
          continue;
        }

        if (partType === "tool_use" || partType === "server_tool_use") {
          const toolName = readString(part.name) ?? "tool";
          const toolUseId = readString(part.id) ?? `tool-${hashText(`${messageId}:${index}`)}`;
          const input = asInputRecord(part.input);
          this.pushIfNew(
            session,
            obj,
            "tool-use",
            index,
            `${toolUseId}:${toolName}:${safeJson(input)}`,
            events,
            {
              type: "tool",
              payload: {
                sessionId: session.id,
                messageId,
                modelId,
                toolUseId,
                toolName,
                input,
                status: "running",
                createdAt: timestamp + index,
              },
            },
          );
          continue;
        }

        if (partType === "tool_result") {
          this.pushToolResult(session, obj, part, index, timestamp, events);
        }
      } else if (partType === "tool_result") {
        this.pushToolResult(session, obj, part, index, timestamp, events);
      }
    }

    if (assistantTextParts.length > 0) {
      const text = assistantTextParts.join("\n");
      this.pushIfNew(
        session,
        obj,
        "assistant-text",
        assistantTextIndexes[0] ?? 0,
        text,
        events,
        assistantTextEvent(session.id, messageId, text, timestamp, modelId),
      );
    }

    return events;
  }

  private pushToolResult(
    session: TranscriptSession,
    obj: Record<string, unknown>,
    part: Record<string, unknown>,
    index: number,
    timestamp: number,
    events: CliAgentRelayEvent[],
  ): void {
    const toolUseId = readString(part.tool_use_id) ??
      readString(part.toolUseID) ??
      `tool-${hashText(`${makeMessageId(obj, session.id)}:${index}`)}`;
    const message = isRecord(obj.message) ? obj.message : null;
    const modelId = readString(message?.model) ?? undefined;
    const output = formatToolResult(part, obj);
    const isError = part.is_error === true;
    this.pushIfNew(
      session,
      obj,
      "tool-result",
      index,
      `${toolUseId}:${output}:${isError ? "error" : "ok"}`,
      events,
      {
        type: "tool",
        payload: {
          sessionId: session.id,
          messageId: makeToolResultMessageId(obj, session.id),
          modelId,
          toolUseId,
          toolName: "tool",
          input: {},
          output: isError ? undefined : output,
          error: isError ? output || "Tool failed" : undefined,
          status: isError ? "error" : "completed",
          createdAt: timestamp + index,
        },
      },
    );
  }

  private pushIfNew(
    session: TranscriptSession,
    obj: Record<string, unknown>,
    kind: string,
    index: number,
    identity: string,
    events: CliAgentRelayEvent[],
    event: CliAgentRelayEvent,
  ): void {
    const key = transcriptKey(obj, kind, index, identity);
    if (session.seenKeys.has(key)) return;
    session.seenKeys.add(key);
    events.push(event);
  }
}

function assistantTextEvent(
  sessionId: string,
  messageId: string,
  text: string,
  createdAt: number,
  modelId?: string,
): CliAgentRelayEvent {
  return {
    type: "message",
    payload: {
      role: "assistant",
      sessionId,
      messageId,
      modelId,
      text: truncateText(text),
      createdAt,
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSessionId(body: Record<string, unknown>): string | null {
  return (
    readString(body.sessionId) ??
    readString(body.session_id) ??
    readString(body.transcript_path)?.match(/([0-9a-f-]{36})\.jsonl$/i)?.[1] ??
    null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string") return Date.now();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function makeMessageId(obj: Record<string, unknown>, sessionId: string): string {
  const message = isRecord(obj.message) ? obj.message : null;
  return (
    readString(message?.id) ??
    readString(obj.uuid) ??
    `claude-${sessionId}-${hashText(`${String(obj.timestamp ?? "")}:${String(obj.parentUuid ?? "")}`)}`
  );
}

function makeToolResultMessageId(
  obj: Record<string, unknown>,
  sessionId: string,
): string {
  return (
    readString(obj.sourceToolAssistantUUID) ??
    readString(obj.parentUuid) ??
    makeMessageId(obj, sessionId)
  );
}

function transcriptKey(
  obj: Record<string, unknown>,
  kind: string,
  index: number,
  identity: string,
): string {
  const message = isRecord(obj.message) ? obj.message : null;
  const base = readString(obj.uuid) ??
    readString(message?.id) ??
    `${String(obj.timestamp ?? "")}:${String(obj.parentUuid ?? "")}`;
  return `${base}:${kind}:${index}:${hashText(identity)}`;
}

function asInputRecord(value: unknown): Record<string, unknown> {
  const redacted = redactLargeFields(value);
  if (isRecord(redacted)) return redacted;
  if (Array.isArray(redacted)) return { value: redacted };
  return redacted === undefined ? {} : { value: redacted };
}

function formatToolResult(
  part: Record<string, unknown>,
  obj: Record<string, unknown>,
): string {
  if (part.content !== undefined) return formatContent(part.content);
  if (obj.toolUseResult !== undefined) return safeJson(obj.toolUseResult);
  return "";
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return truncateText(content);
  if (Array.isArray(content)) {
    return truncateText(
      content.map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return safeJson(item);
      }).join("\n"),
    );
  }
  return safeJson(content);
}

function safeJson(value: unknown): string {
  try {
    return truncateText(JSON.stringify(redactLargeFields(value), null, 2));
  } catch {
    return String(value);
  }
}

function redactLargeFields(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[max depth]";
  if (typeof value === "string") {
    if (value.length > 4000 && looksBinary(value)) return `[omitted ${value.length} chars]`;
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactLargeFields(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      child.length > 1000 &&
      /^(data|base64|image|source)$/i.test(key)
    ) {
      out[key] = `[omitted ${child.length} chars]`;
    } else {
      out[key] = redactLargeFields(child, depth + 1);
    }
  }
  return out;
}

function looksBinary(value: string): boolean {
  return /^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 4000;
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TEXT_LENGTH)}\n\n[truncated ${text.length - MAX_TEXT_LENGTH} chars]`;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return String(hash);
}
