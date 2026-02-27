/**
 * Event types for the ADIT unified timeline.
 *
 * Every code change, prompt, tool call, and system action is an event.
 * Events form a tree via parentEventId for nested execution tracking.
 */

/** All possible event types in the timeline */
export type EventType =
  | "prompt_submit" // User submits a prompt
  | "assistant_response" // AI responds with code/text
  | "user_edit" // Manual edit between prompts
  | "tool_call" // Built-in tool execution
  | "subagent_call" // Subagent spawned
  | "skill_call" // Skill invoked
  | "mcp_call" // MCP server tool call
  | "checkpoint" // Git checkpoint created
  | "revert" // User reverted to checkpoint
  | "env_snapshot" // Environment captured
  | "env_drift" // Environment changed between snapshots
  | "plan_update" // SpecFlow plan modified
  | "task_completed" // Agent marked a task as done
  | "notification" // Claude Code notification fired
  | "subagent_start" // Subagent spawned by the AI
  | "subagent_stop"; // Subagent finished execution

/** Who performed the action */
export type Actor = "assistant" | "user" | "tool" | "system";

/** Lifecycle status of an event */
export type EventStatus =
  | "running"
  | "success"
  | "error"
  | "timeout"
  | "cancelled";

/** Classification of errors for filtering and analysis */
export type ErrorCategory =
  | "tool_failure"
  | "timeout"
  | "permission_denied"
  | "not_found"
  | "validation"
  | "unknown";

/** File change statistics within a checkpoint */
export interface FileStat {
  path: string;
  status: "M" | "A" | "D" | "R" | "??";
  additions?: number;
  deletions?: number;
}

/** Error details attached to failed events */
export interface EventError {
  category: ErrorCategory;
  message: string;
  stack?: string;
}

/** The core event record — every timeline entry is one of these */
export interface AditEvent {
  /** ULID — globally unique, time-sortable */
  id: string;
  /** Session this event belongs to */
  sessionId: string;
  /** Parent event for tree structure (null = root) */
  parentEventId: string | null;
  /** Monotonic sequence within session */
  sequence: number;
  /** What kind of event */
  eventType: EventType;
  /** Who performed it */
  actor: Actor;

  // -- Prompt / CoT capture --
  /** User's prompt text (when eventType=prompt_submit) */
  promptText: string | null;
  /** Chain of thought from the model (when eventType=assistant_response) */
  cotText: string | null;
  /** Summary of assistant's response */
  responseText: string | null;

  // -- Tool execution --
  /** Tool/command name */
  toolName: string | null;
  /** Serialized tool input */
  toolInputJson: string | null;
  /** Serialized tool output */
  toolOutputJson: string | null;

  // -- Git checkpoint --
  /** Git commit SHA for this checkpoint */
  checkpointSha: string | null;
  /** Ref path: refs/adit/checkpoints/<id> */
  checkpointRef: string | null;
  /** Per-file change stats */
  diffStatJson: string | null;

  // -- Environment context --
  /** Active git branch at time of event */
  gitBranch: string | null;
  /** HEAD SHA at time of event */
  gitHeadSha: string | null;
  /** FK to env_snapshots table */
  envSnapshotId: string | null;

  // -- Metadata --
  startedAt: string;
  endedAt: string | null;
  status: EventStatus;
  /** Serialized EventError */
  errorJson: string | null;
  /** User-assigned labels */
  labelsJson: string | null;
  /** FK to plans table for SpecFlow task linking */
  planTaskId: string | null;

  // -- Sync --
  /** Vector clock for conflict resolution */
  vclockJson: string;
  /** Soft delete timestamp */
  deletedAt: string | null;
}

/** Parsed labels from labelsJson */
export function parseLabels(labelsJson: string | null): string[] {
  if (!labelsJson) return [];
  try {
    return JSON.parse(labelsJson);
  } catch {
    return [];
  }
}

/** Parsed diff stats from diffStatJson */
export function parseDiffStats(diffStatJson: string | null): FileStat[] {
  if (!diffStatJson) return [];
  try {
    return JSON.parse(diffStatJson);
  } catch {
    return [];
  }
}

/** Parsed error from errorJson */
export function parseError(errorJson: string | null): EventError | null {
  if (!errorJson) return null;
  try {
    return JSON.parse(errorJson);
  } catch {
    return null;
  }
}
