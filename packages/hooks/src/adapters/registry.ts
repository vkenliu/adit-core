/**
 * Platform adapter registry.
 *
 * Discovers, registers, and retrieves platform adapters.
 * Provides both env-var-based detection (for hook dispatching) and
 * directory-based detection (for CLI commands like init/plugin install).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "@varveai/adit-core";
import type { PlatformAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { claudeVscodeAdapter } from "./claude-vscode.js";
import {
  cursorAdapter,
  copilotAdapter,
  codexAdapter,
  otherAdapter,
} from "./stub.js";
import { opencodeAdapter } from "./opencode.js";

/** Registered adapters keyed by platform */
const adapters = new Map<Platform, PlatformAdapter>();

// Register built-in adapters
adapters.set("claude-code", claudeCodeAdapter);
adapters.set("claude-vscode", claudeVscodeAdapter);

// Register OpenCode adapter (fully implemented)
adapters.set("opencode", opencodeAdapter);

// Register stub adapters (detected but not yet fully implemented)
adapters.set("cursor", cursorAdapter);
adapters.set("copilot", copilotAdapter);
adapters.set("codex", codexAdapter);
adapters.set("other", otherAdapter);

/** Get the adapter for a platform */
export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = adapters.get(platform);
  if (!adapter) {
    throw new Error(
      `No adapter registered for platform "${platform}". Available: ${listAdapters().map((a) => a.platform).join(", ")}`,
    );
  }
  return adapter;
}

/** List all registered adapters */
export function listAdapters(): PlatformAdapter[] {
  return Array.from(adapters.values());
}

/** Register a new adapter (for extensibility) */
export function registerAdapter(adapter: PlatformAdapter): void {
  adapters.set(adapter.platform, adapter);
}

/**
 * Detect the current platform from environment clues.
 * Falls back to "other" when no platform is detected.
 */
export function detectPlatform(): Platform {
  // Claude Code (CLI or VS Code extension).
  // ADIT's hook command prefix sets CLAUDE_CODE=1 for both platforms.
  // The VS Code extension host additionally sets ELECTRON_RUN_AS_NODE and
  // VSCODE_IPC_HOOK — these are NOT inherited by terminal child processes,
  // so running CLI from VS Code's terminal won't trigger false detection.
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_PLUGIN_ROOT) {
    if (process.env.ELECTRON_RUN_AS_NODE && process.env.VSCODE_IPC_HOOK) {
      return "claude-vscode";
    }
    return "claude-code";
  }

  // Cursor detection
  if (process.env.CURSOR_SESSION_ID || process.env.CURSOR) {
    return "cursor";
  }

  // GitHub Copilot detection
  if (process.env.GITHUB_COPILOT || process.env.COPILOT_SESSION) {
    return "copilot";
  }

  // OpenCode detection (Go-based AI coding CLI)
  if (process.env.OPENCODE || process.env.OPENCODE_SESSION) {
    return "opencode";
  }

  // Codex detection (OpenAI's AI coding agent)
  if (process.env.CODEX || process.env.CODEX_SESSION) {
    return "codex";
  }

  // No platform env vars detected — return "other" to stay platform-neutral.
  // Callers that need a concrete adapter should check for "other" and handle
  // it explicitly rather than silently assuming a specific platform.
  return "other";
}

/**
 * Detect which platforms are present in a project by checking for their
 * config directories on disk. Falls back to env-based detection if no
 * platform directories are found.
 *
 * This is the preferred detection method for CLI commands (init, plugin
 * install/uninstall) because env vars are only set inside AI tool sessions,
 * whereas config directories persist on disk.
 */
export function detectPlatforms(projectRoot: string): Platform[] {
  const platforms = new Set<Platform>();

  // Check for Claude Code config directory (shared by CLI and VS Code extension)
  if (existsSync(join(projectRoot, ".claude"))) {
    platforms.add("claude-code");
    platforms.add("claude-vscode");
  }

  // Check for OpenCode config directory or config file
  if (
    existsSync(join(projectRoot, ".opencode")) ||
    existsSync(join(projectRoot, "opencode.json")) ||
    existsSync(join(projectRoot, "opencode.jsonc"))
  ) {
    platforms.add("opencode");
  }

  // If no platform directories found, fall back to env detection.
  // This handles cases where adit is run from within an AI tool session
  // (e.g. the AI agent running `adit plugin install`).
  if (platforms.size === 0) {
    const envPlatform = detectPlatform();
    if (envPlatform !== "other") {
      platforms.add(envPlatform);
    }
  }

  return Array.from(platforms);
}
