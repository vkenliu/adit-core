/**
 * Session types for ADIT.
 *
 * A session represents a continuous AI-assisted development interaction.
 * Multiple sessions can exist for the same project (multi-client support).
 */

/** Session lifecycle status */
export type SessionStatus =
  | "active"
  | "completed"
  | "error"
  | "cancelled";

/** Which AI platform is driving this session */
export type Platform =
  | "claude-code"
  | "claude-vscode"
  | "cursor"
  | "copilot"
  | "opencode"
  | "codex"
  | "other";

/** Session type */
export type SessionType = "interactive" | "headless";

/** Session metadata captured at start */
export interface SessionMetadata {
  gitBranch: string;
  gitRemoteUrl?: string;
  workingDirectory: string;
  nodeVersion?: string;
  pythonVersion?: string;
  osInfo?: string;
}

/** The session record */
export interface AditSession {
  /** ULID — globally unique, time-sortable */
  id: string;
  /** Project identifier: hash(remote_url + repo_root) */
  projectId: string;
  /** Unique per machine/installation */
  clientId: string;
  sessionType: SessionType;
  platform: Platform;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  /** Serialized SessionMetadata */
  metadataJson: string | null;
  /** Vector clock for sync */
  vclockJson: string;
  /** Platform-provided session ID (e.g., Claude Code session_id) */
  platformSessionId?: string | null;
  /** Soft delete timestamp */
  deletedAt: string | null;
}
