import fs from "node:fs";
import type { CliAgentRelayEvent } from "./types.js";

interface NoteHookInput {
  eventType: string;
  body: Record<string, unknown>;
  sessionId?: string | null;
}

interface CodexSessionState {
  id: string;
  transcriptPath?: string;
  transcriptOffset: number;
  pendingTranscriptLine: string;
  seenKeys: Set<string>;
  lastAssistantMessageId?: string;
  seenAssistantStops: Set<string>;
  seenHookToolResults: Set<string>;
}

const MAX_TEXT_LENGTH = 12_000;

export class CodexTranscriptSync {
  private readonly sessions = new Map<string, CodexSessionState>();

  noteHook(input: NoteHookInput): string | null {
    const sessionId = input.sessionId ?? readSessionId(input.body);
    if (!sessionId) return null;

    const session = this.ensureSession(sessionId);
    const transcriptPath = readString(input.body.transcript_path);
    const isNewTranscript = Boolean(transcriptPath && transcriptPath !== session.transcriptPath);
    if (transcriptPath) {
      session.transcriptPath = transcriptPath;
      if (isNewTranscript) {
        session.transcriptOffset = 0;
        session.pendingTranscriptLine = "";
      }
    }

    if (input.eventType === "SessionStart") {
      this.primeTranscript(session);
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

  stopEvents(sessionId: string | null | undefined, body: Record<string, unknown>): CliAgentRelayEvent[] {
    if (!sessionId) return [];
    const text = readString(body.last_assistant_message);
    if (!text) return [];
    const session = this.ensureSession(sessionId);
    const key = hashText(text);
    if (session.seenAssistantStops.has(key)) return [];
    session.seenAssistantStops.add(key);
    const createdAt = Date.now();
    return [{
      type: "message",
      payload: {
        role: "assistant",
        sessionId,
        messageId: `codex-local-${sessionId}-${createdAt}`,
        modelId: readString(body.model) ?? undefined,
        text: truncateText(text),
        createdAt,
      },
    }];
  }

  toolEvents(sessionId: string | null | undefined, body: Record<string, unknown>): CliAgentRelayEvent[] {
    if (!sessionId) return [];
    const toolName = readString(body.tool_name) ?? "tool";
    const toolInput = asRecord(body.tool_input) ?? {};
    const toolResponse = body.tool_response;
    const key = `${toolName}:${safeJson(toolInput)}:${safeJson(toolResponse)}`;
    const session = this.ensureSession(sessionId);
    if (session.seenHookToolResults.has(key)) return [];
    session.seenHookToolResults.add(key);
    const createdAt = Date.now();
    return [{
      type: "tool",
      payload: {
        sessionId,
        messageId: session.lastAssistantMessageId ?? `codex-local-tools-${sessionId}`,
        toolUseId: `codex-local-tool-${hashText(key)}`,
        toolName,
        input: toolInput,
        output: safeJson(toolResponse),
        status: "completed",
        createdAt,
      },
    }];
  }

  private ensureSession(id: string): CodexSessionState {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        transcriptOffset: 0,
        pendingTranscriptLine: "",
        seenKeys: new Set<string>(),
        seenAssistantStops: new Set<string>(),
        seenHookToolResults: new Set<string>(),
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  private primeTranscript(session: CodexSessionState): void {
    if (!session.transcriptPath) return;
    try {
      session.transcriptOffset = fs.statSync(session.transcriptPath).size;
      session.pendingTranscriptLine = "";
    } catch {
      session.transcriptOffset = 0;
      session.pendingTranscriptLine = "";
    }
  }

  private drainTranscript(session: CodexSessionState): CliAgentRelayEvent[] {
    if (!session.transcriptPath) return [];

    const text = this.readTranscriptChunk(session);
    if (!text && !session.pendingTranscriptLine) {
      return [];
    }

    const events: CliAgentRelayEvent[] = [];
    const rawLines = `${session.pendingTranscriptLine}${text}`.split("\n");
    session.pendingTranscriptLine = "";

    if (rawLines.length > 0 && !text.endsWith("\n")) {
      const lastLine = rawLines.pop() ?? "";
      if (lastLine.trim()) {
        try {
          JSON.parse(lastLine);
          rawLines.push(lastLine);
        } catch {
          session.pendingTranscriptLine = lastLine;
        }
      }
    }

    for (const line of rawLines) {
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
      events.push(...this.transcriptObjectToEvents(session, obj, lineTimestamp));
    }

    return events;
  }

  private readTranscriptChunk(session: CodexSessionState): string {
    if (!session.transcriptPath) return "";

    let fd: number | null = null;
    try {
      const stat = fs.statSync(session.transcriptPath);
      if (stat.size < session.transcriptOffset) {
        session.transcriptOffset = 0;
        session.pendingTranscriptLine = "";
      }
      const byteLength = stat.size - session.transcriptOffset;
      if (byteLength <= 0) return "";

      const buffer = Buffer.alloc(byteLength);
      fd = fs.openSync(session.transcriptPath, "r");
      fs.readSync(fd, buffer, 0, byteLength, session.transcriptOffset);
      session.transcriptOffset = stat.size;
      return buffer.toString("utf8");
    } catch {
      return "";
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  }

  private transcriptObjectToEvents(
    session: CodexSessionState,
    obj: Record<string, unknown>,
    timestamp: number,
  ): CliAgentRelayEvent[] {
    if (readString(obj.type) !== "response_item") return [];
    const payload = asRecord(obj.payload);
    if (!payload) return [];

    const payloadType = readString(payload.type);
    const events: CliAgentRelayEvent[] = [];

    if (payloadType === "message") {
      const role = readString(payload.role);
      if (role !== "assistant") return [];
      const text = readContentText(payload.content);
      if (!text) return [];
      const messageId = makeMessageId(session.id, obj, payload, "message", text);
      session.lastAssistantMessageId = messageId;
      this.pushIfNew(
        session,
        obj,
        "assistant-message",
        0,
        `${messageId}:${text}`,
        events,
        {
          type: "message",
          payload: {
            role: "assistant",
            sessionId: session.id,
            messageId,
            modelId: readString(payload.model) ?? undefined,
            text: truncateText(text),
            createdAt: timestamp,
          },
        },
      );
      return events;
    }

    if (payloadType === "reasoning") {
      const text = readReasoningText(payload);
      if (!text) return [];
      const messageId = session.lastAssistantMessageId ??
        makeMessageId(session.id, obj, payload, "reasoning", text);
      this.pushIfNew(
        session,
        obj,
        "reasoning",
        0,
        `${messageId}:${text}`,
        events,
        {
          type: "reasoning",
          payload: {
            sessionId: session.id,
            messageId,
            text: truncateText(text),
            createdAt: timestamp,
          },
        },
      );
      return events;
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const toolUseId = readString(payload.call_id) ??
        makeToolUseId(session.id, obj, payload);
      const toolName = readString(payload.name) ?? "tool";
      const input = parseToolInput(payload.arguments ?? payload.input);
      this.pushIfNew(
        session,
        obj,
        "tool-call",
        0,
        `${toolUseId}:${toolName}:${safeJson(input)}`,
        events,
        {
          type: "tool",
          payload: {
            sessionId: session.id,
            messageId: session.lastAssistantMessageId ?? `codex-local-tools-${session.id}`,
            toolUseId,
            toolName,
            input,
            status: "running",
            createdAt: timestamp,
          },
        },
      );
      return events;
    }

    if (
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output"
    ) {
      const toolUseId = readString(payload.call_id) ??
        makeToolUseId(session.id, obj, payload);
      const output = formatToolOutput(payload.output);
      this.pushIfNew(
        session,
        obj,
        "tool-output",
        0,
        `${toolUseId}:${output}`,
        events,
        {
          type: "tool",
          payload: {
            sessionId: session.id,
            messageId: session.lastAssistantMessageId ?? `codex-local-tools-${session.id}`,
            toolUseId,
            toolName: "tool",
            input: {},
            output,
            status: "completed",
            createdAt: timestamp,
          },
        },
      );
      return events;
    }

    return events;
  }

  private pushIfNew(
    session: CodexSessionState,
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

interface SeenAssistantMessage {
  messageId: string;
  turn: number;
  textKey: string;
}

export class CodexRelayEventDeduper {
  private readonly turnBySession = new Map<string, number>();
  private readonly assistantByTurnText = new Map<string, SeenAssistantMessage>();
  private readonly assistantBySessionText = new Map<string, SeenAssistantMessage>();
  private readonly messageAlias = new Map<string, string>();
  private readonly seenAssistantMessageIds = new Set<string>();
  private readonly seenUsageKeys = new Set<string>();

  filter(event: CliAgentRelayEvent): CliAgentRelayEvent | null {
    if (event.type === "message") {
      return this.filterMessage(event);
    }

    if (event.type === "assistant-delta" || event.type === "reasoning" || event.type === "tool") {
      return this.rewriteMessageScopedEvent(event);
    }

    if (event.type === "usage") {
      return this.filterUsage(event);
    }

    return event;
  }

  private filterMessage(event: CliAgentRelayEvent): CliAgentRelayEvent | null {
    const role = readString(event.payload.role);
    const sessionId = readString(event.payload.sessionId);
    if (!sessionId) return event;

    if (role === "user") {
      this.turnBySession.set(sessionId, (this.turnBySession.get(sessionId) ?? 0) + 1);
      return event;
    }

    if (role !== "assistant") return event;

    const text = readString(event.payload.text);
    if (!text) return event;

    const messageId = readString(event.payload.messageId) ?? readString(event.payload.id);
    const textKey = normalizeRelayText(text);
    if (!textKey) return event;

    const scopedMessageId = messageId ? messageScopedKey(sessionId, messageId) : null;
    if (
      scopedMessageId &&
      (this.seenAssistantMessageIds.has(scopedMessageId) || this.messageAlias.has(scopedMessageId))
    ) {
      return null;
    }

    const turn = this.turnBySession.get(sessionId) ?? 0;
    const turnTextKey = `${sessionId}:${turn}:${textKey}`;
    const sessionTextKey = `${sessionId}:${textKey}`;
    const existing = this.assistantByTurnText.get(turnTextKey) ??
      (isCodexHistoryItemId(messageId) ? this.assistantBySessionText.get(sessionTextKey) : undefined);
    if (existing) {
      if (messageId) {
        this.messageAlias.set(messageScopedKey(sessionId, messageId), existing.messageId);
        this.seenAssistantMessageIds.add(messageScopedKey(sessionId, messageId));
      }
      return null;
    }

    const canonicalMessageId = messageId ?? `codex-assistant-${hashText(`${sessionId}:${turn}:${textKey}`)}`;
    this.assistantByTurnText.set(turnTextKey, {
      messageId: canonicalMessageId,
      turn,
      textKey,
    });
    this.assistantBySessionText.set(sessionTextKey, {
      messageId: canonicalMessageId,
      turn,
      textKey,
    });
    if (scopedMessageId) {
      this.seenAssistantMessageIds.add(scopedMessageId);
    }
    return event;
  }

  private rewriteMessageScopedEvent(event: CliAgentRelayEvent): CliAgentRelayEvent | null {
    const sessionId = readString(event.payload.sessionId);
    const messageId = readString(event.payload.messageId);
    if (!sessionId || !messageId) return event;

    const canonicalMessageId = this.messageAlias.get(messageScopedKey(sessionId, messageId));
    if (!canonicalMessageId) return event;

    return {
      ...event,
      payload: {
        ...event.payload,
        messageId: canonicalMessageId,
      },
    };
  }

  private filterUsage(event: CliAgentRelayEvent): CliAgentRelayEvent | null {
    const rewritten = this.rewriteMessageScopedEvent(event);
    if (!rewritten) return null;

    const sessionId = readString(rewritten.payload.sessionId);
    const messageId = readString(rewritten.payload.messageId);
    if (!sessionId || !messageId) return rewritten;

    const key = `${sessionId}:${messageId}:${safeJson(rewritten.payload.usage)}`;
    if (this.seenUsageKeys.has(key)) return null;
    this.seenUsageKeys.add(key);
    return rewritten;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSessionId(body: Record<string, unknown>): string | null {
  return (
    readString(body.sessionId) ??
    readString(body.session_id) ??
    readString(body.transcript_path)?.match(/([0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12})\.jsonl$/i)?.[1] ??
    null
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string") return Date.now();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function readContentText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

function readReasoningText(payload: Record<string, unknown>): string | null {
  const summary = payload.summary;
  if (typeof summary === "string") return summary.trim() ? summary : null;
  if (Array.isArray(summary)) {
    const text = summary
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text.trim()) return text;
  }
  const content = readContentText(payload.content);
  return content?.trim() ? content : null;
}

function makeMessageId(
  sessionId: string,
  obj: Record<string, unknown>,
  payload: Record<string, unknown>,
  kind: string,
  identity: string,
): string {
  return readString(payload.id) ??
    readString(payload.message_id) ??
    `codex-local-${sessionId}-${hashText(`${String(obj.timestamp ?? "")}:${kind}:${identity}`)}`;
}

function makeToolUseId(
  sessionId: string,
  obj: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  return `codex-local-tool-${hashText(`${sessionId}:${String(obj.timestamp ?? "")}:${safeJson(payload)}`)}`;
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
      return { value: parsed };
    } catch {
      return { value };
    }
  }
  if (value === undefined) return {};
  return { value };
}

function formatToolOutput(value: unknown): string {
  if (typeof value === "string") return truncateText(value);
  return safeJson(value);
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return truncateText(value);
  try {
    return truncateText(JSON.stringify(value ?? {}, null, 2));
  } catch {
    return String(value);
  }
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

function normalizeRelayText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageScopedKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

function isCodexHistoryItemId(messageId: string | null | undefined): boolean {
  return /^item-\d+$/i.test(messageId ?? "");
}

function transcriptKey(
  obj: Record<string, unknown>,
  kind: string,
  index: number,
  identity: string,
): string {
  const payload = asRecord(obj.payload);
  const base = readString(payload?.id) ??
    readString(payload?.call_id) ??
    `${String(obj.timestamp ?? "")}:${readString(payload?.type) ?? "item"}`;
  return `${base}:${kind}:${index}:${hashText(identity)}`;
}
