/**
 * Platform adapter interface.
 *
 * Each AI CLI tool gets an adapter that translates between
 * the platform's hook/event system and ADIT's internal model.
 */

import type { Platform } from "@adit/core";

/**
 * Adapter that bridges a specific AI platform's hook system
 * with ADIT's internal event model.
 */
export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: Platform;

  /** Human-readable platform name */
  readonly displayName: string;

  /** Hook event mappings: platform event name → ADIT handler */
  readonly hookMappings: HookMapping[];

  /** Parse platform-specific stdin input into ADIT's normalized format */
  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput;

  /** Generate platform-specific hook configuration */
  generateHookConfig(aditBinaryPath: string): PlatformHookConfig;

  /** Validate that the platform is properly configured */
  validateInstallation(projectRoot: string): Promise<ValidationResult>;

  /** Install/register hooks for this platform */
  installHooks(projectRoot: string, aditBinaryPath: string): Promise<void>;

  /** Uninstall/deregister hooks */
  uninstallHooks(projectRoot: string): Promise<void>;

  /**
   * Get the platform-specific command to resume/continue an AI session.
   *
   * Returns a human-readable command string (e.g., "claude --continue")
   * that the user can run to resume working with the AI agent after
   * restoring a checkpoint. Returns null if the platform does not
   * support a resume command.
   */
  getResumeCommand?(projectRoot: string): string | null;
}

/** Maps a platform event to an ADIT handler */
export interface HookMapping {
  /** Platform's event name (e.g., "UserPromptSubmit" for Claude) */
  platformEvent: string;
  /** ADIT's internal handler name */
  aditHandler: AditHookType;
  /** Optional matcher (e.g., "Write|Edit" for PostToolUse) */
  matcher?: string;
}

/** Normalized hook input — platform-agnostic representation */
export interface NormalizedHookInput {
  cwd: string;
  hookType: AditHookType;
  /** CLI identifier for upload routing (e.g., "claude-code", "cursor") */
  platformCli?: Platform;
  /** Session ID from the platform (e.g., Claude Code session_id) */
  platformSessionId?: string;
  /** Path to the session transcript file (JSONL) */
  transcriptPath?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  stopReason?: string;
  /** The assistant's last message text (sent in Stop events) */
  lastAssistantMessage?: string;
  /** Whether the stop hook is active (loop prevention) */
  stopHookActive?: boolean;
  taskId?: string;
  taskSubject?: string;
  taskDescription?: string;
  teammateName?: string;
  teamName?: string;
  notificationMessage?: string;
  notificationTitle?: string;
  notificationType?: string;
  agentId?: string;
  agentType?: string;
  agentTranscriptPath?: string;
  /** Permission mode the AI agent is running in */
  permissionMode?: string;
  /** Which AI model is being used (from SessionStart) */
  model?: string;
  /** Session source: startup, resume, clear, compact (from SessionStart) */
  sessionSource?: string;
  /** Why the session ended: clear, logout, exit, etc. (from SessionEnd) */
  sessionEndReason?: string;
  rawPlatformData?: Record<string, unknown>;
}

/** Platform-specific hook configuration output */
export interface PlatformHookConfig {
  /** Platform-specific config file path (relative to project root) */
  configPath: string;
  /** Configuration content to write */
  content: Record<string, unknown>;
}

/** Result of validating a platform installation */
export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** All ADIT hook types */
export type AditHookType =
  | "prompt-submit"
  | "stop"
  | "session-start"
  | "session-end"
  | "task-completed"
  | "notification"
  | "subagent-start"
  | "subagent-stop";
