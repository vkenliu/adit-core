/**
 * Claude Code JSONL chat history parser.
 *
 * Reads Claude Code session files and extracts structured messages
 * for import into ADIT's timeline.
 */

import { readFileSync } from "node:fs";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A single content block inside a Claude message */
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown[];
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

/** Normalized message extracted from a JSONL line */
export interface ChatHistoryMessage {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  role: "user" | "assistant";
  /** Plain text content (concatenated text blocks) */
  text: string | null;
  /** Chain-of-thought / thinking content */
  thinkingText: string | null;
  /** Tool use calls in this message */
  toolUses: ToolUseInfo[];
  /** Tool results in this message (user messages carrying tool_result) */
  toolResults: ToolResultInfo[];
  /** Model used (assistant messages only) */
  model: string | null;
}

export interface ToolUseInfo {
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultInfo {
  toolUseId: string;
  content: string;
}

/* ------------------------------------------------------------------ */
/*  JSONL line types (raw)                                             */
/* ------------------------------------------------------------------ */

interface RawJsonlLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
  };
  toolUseResult?: unknown;
}

/* ------------------------------------------------------------------ */
/*  Skippable top-level types                                          */
/* ------------------------------------------------------------------ */

const SKIP_TYPES = new Set([
  "system",
  "progress",
  "queue-operation",
  "file-history-snapshot",
  "hook_progress",
  "bash_progress",
]);

/* ------------------------------------------------------------------ */
/*  Parser                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parse a Claude Code JSONL file into structured messages.
 *
 * Gracefully skips malformed lines and non-conversation entries.
 */
export function parseChatHistoryFile(filePath: string): ChatHistoryMessage[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const messages: ChatHistoryMessage[] = [];

  for (const line of lines) {
    let parsed: RawJsonlLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed JSON — skip
      continue;
    }

    // Skip non-conversation entries
    if (SKIP_TYPES.has(parsed.type)) continue;
    if (!parsed.uuid || !parsed.message) continue;

    const role = parsed.message.role;
    if (role !== "user" && role !== "assistant") continue;

    const msg = extractMessage(parsed);
    if (msg) {
      messages.push(msg);
    }
  }

  return messages;
}

/**
 * Extract a normalized ChatHistoryMessage from a raw JSONL line.
 */
function extractMessage(raw: RawJsonlLine): ChatHistoryMessage | null {
  const msg = raw.message!;
  const content = msg.content;

  let text: string | null = null;
  let thinkingText: string | null = null;
  const toolUses: ToolUseInfo[] = [];
  const toolResults: ToolResultInfo[] = [];

  if (typeof content === "string") {
    // Simple string content (user prompts)
    text = content;
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];

    for (const block of content) {
      switch (block.type) {
        case "text":
          textParts.push((block as TextBlock).text);
          break;
        case "thinking":
          thinkingParts.push((block as ThinkingBlock).thinking);
          break;
        case "tool_use": {
          const tu = block as ToolUseBlock;
          toolUses.push({
            toolUseId: tu.id,
            toolName: tu.name,
            input: tu.input,
          });
          break;
        }
        case "tool_result": {
          const tr = block as ToolResultBlock;
          const resultContent =
            typeof tr.content === "string"
              ? tr.content
              : JSON.stringify(tr.content);
          toolResults.push({
            toolUseId: tr.tool_use_id,
            content: resultContent,
          });
          break;
        }
      }
    }

    text = textParts.length > 0 ? textParts.join("\n") : null;
    thinkingText = thinkingParts.length > 0 ? thinkingParts.join("\n") : null;
  }

  // Skip empty messages (e.g. partial streaming chunks with no useful content)
  if (!text && !thinkingText && toolUses.length === 0 && toolResults.length === 0) {
    return null;
  }

  return {
    uuid: raw.uuid!,
    parentUuid: raw.parentUuid ?? null,
    sessionId: raw.sessionId ?? "",
    timestamp: raw.timestamp ?? new Date().toISOString(),
    role: raw.message!.role as "user" | "assistant",
    text,
    thinkingText,
    toolUses,
    toolResults,
    model: raw.message!.model ?? null,
  };
}
