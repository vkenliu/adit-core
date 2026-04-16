/**
 * Shared event summary generation.
 *
 * Produces a short one-line message for each event type,
 * following per-type rules for which field to display.
 */

import type { AditEvent } from "@varveai/adit-core";

/**
 * Generate a short summary string for an event based on its type.
 *
 * Rules per event type:
 *   subagent_stop    → lastAssistantMessage (from toolOutputJson)
 *   prompt_submit    → prompt (promptText)
 *   user_edit        → response (responseText)
 *   notification     → response (responseText)
 *   task_completed   → response (responseText)
 *   env_drift        → changes.newValue (from toolInputJson)
 *   subagent_start   → agentType (toolName)
 *   tool_call        → description (from toolInputJson)
 *   checkpoint       → source + model (from toolInputJson)
 *   subagent_call    → description (from toolInputJson)
 *   assistant_response → response (responseText)
 */
export function getEventSummary(event: AditEvent, maxLen = 60): string {
  let text: string | null = null;

  switch (event.eventType) {
    case "prompt_submit":
      text = event.promptText;
      break;

    case "assistant_response":
    case "user_edit":
    case "notification":
    case "task_completed":
      text = event.responseText;
      break;

    case "subagent_stop":
      text = parseJson<{ lastAssistantMessage?: string }>(event.toolOutputJson)?.lastAssistantMessage ?? null;
      break;

    case "env_drift": {
      const drift = parseJson<{ changes?: Array<{ key?: string; newValue?: string }> }>(event.toolInputJson);
      if (drift?.changes?.length) {
        text = drift.changes
          .map((c) => c.newValue ?? "")
          .filter(Boolean)
          .join(", ");
      }
      break;
    }

    case "subagent_start":
      text = event.toolName;
      break;

    case "tool_call":
    case "subagent_call":
      text = parseJson<{ description?: string }>(event.toolInputJson)?.description
        ?? event.toolName;
      break;

    case "checkpoint": {
      const meta = parseJson<{ source?: string; model?: string }>(event.toolInputJson);
      if (meta?.source || meta?.model) {
        text = [meta.source, meta.model].filter(Boolean).join(" ");
      } else if (event.checkpointSha) {
        text = `checkpoint ${event.checkpointSha.substring(0, 8)}`;
      }
      break;
    }

    default:
      text = event.responseText ?? event.promptText ?? event.toolName;
      break;
  }

  if (!text) return event.eventType;
  return truncate(text.replace(/\n/g, " ").trim(), maxLen);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

function parseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
