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
  prompt?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  stopReason?: string;
  taskId?: string;
  taskSubject?: string;
  taskDescription?: string;
  teammateName?: string;
  teamName?: string;
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
  | "tool-use"
  | "stop"
  | "session-start"
  | "session-end"
  | "task-completed";
