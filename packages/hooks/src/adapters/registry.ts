/**
 * Platform adapter registry.
 *
 * Discovers, registers, and retrieves platform adapters.
 */

import type { Platform } from "@adit/core";
import type { PlatformAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";

/** Registered adapters keyed by platform */
const adapters = new Map<Platform, PlatformAdapter>();

// Register built-in adapters
adapters.set("claude-code", claudeCodeAdapter);

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
 * Falls back to "claude-code" as the default.
 */
export function detectPlatform(): Platform {
  // Claude Code sets specific env vars
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_PLUGIN_ROOT) {
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

  // Default to claude-code (the only fully supported platform)
  return "claude-code";
}
