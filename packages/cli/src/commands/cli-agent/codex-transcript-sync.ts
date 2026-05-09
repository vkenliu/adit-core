import type { CliAgentRelayEvent } from "./types.js";

interface NoteHookInput {
  eventType: string;
  body: Record<string, unknown>;
  sessionId?: string | null;
}

interface CodexSessionState {
  id: string;
  seenAssistantStops: Set<string>;
  seenToolResults: Set<string>;
}

const MAX_TEXT_LENGTH = 12_000;

export class CodexTranscriptSync {
  private readonly sessions = new Map<string, CodexSessionState>();

  noteHook(input: NoteHookInput): string | null {
    const sessionId = input.sessionId ?? readSessionId(input.body);
    if (!sessionId) return null;
    this.ensureSession(sessionId);
    return sessionId;
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
    if (session.seenToolResults.has(key)) return [];
    session.seenToolResults.add(key);
    const createdAt = Date.now();
    return [{
      type: "tool",
      payload: {
        sessionId,
        messageId: `codex-local-tools-${sessionId}`,
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
        seenAssistantStops: new Set<string>(),
        seenToolResults: new Set<string>(),
      };
      this.sessions.set(id, session);
    }
    return session;
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
