#!/usr/bin/env node

/**
 * ADIT hook dispatcher.
 *
 * Entry point for `adit-hook <command>`.
 * Uses the platform adapter pattern to handle events from any supported AI tool.
 * All errors are caught and swallowed — hooks must never block the AI agent.
 */

import { appendFileSync } from "node:fs";
import { readStdin } from "./common/context.js";
import { detectPlatform, detectPlatformFromPayload, getAdapter } from "./adapters/index.js";
import { dispatchHook } from "./handlers/unified.js";

// Hard safety net: kill the process after 10 seconds no matter what.
// Hooks must never block the AI agent — this ensures we exit even if
// readStdin, database, git, or network operations hang.
setTimeout(() => process.exit(0), 10_000).unref();

const command = process.argv[2];

async function main(): Promise<void> {
  if (!command) return;

  const raw = await readStdin();
  let platform = detectPlatform();
  // Fallback: detect platform from the raw payload when env vars are absent.
  // Cursor (and possibly other tools) may not set env vars in hook child processes.
  if (platform === "other") {
    platform = detectPlatformFromPayload(raw) ?? "other";
  }

  // Debug: log raw hook data to /tmp/adit-hook-debug.jsonl
  try {
    const debugEntry = {
      timestamp: new Date().toISOString(),
      argv: process.argv,
      env: {
        CODEX: process.env.CODEX,
        CLAUDE_CODE: process.env.CLAUDE_CODE,
        CURSOR: process.env.CURSOR,
        GEMINI: process.env.GEMINI,
        GEMINI_SESSION_ID: process.env.GEMINI_SESSION_ID,
        GEMINI_PROJECT_DIR: process.env.GEMINI_PROJECT_DIR,
      },
      detectedPlatform: platform,
      command,
      raw,
    };
    appendFileSync("/tmp/adit-hook-debug.jsonl", JSON.stringify(debugEntry) + "\n");
  } catch { /* best-effort */ }

  const adapter = getAdapter(platform);
  const input = adapter.parseInput(raw, command);

  // Debug: log parsed input to see what the adapter extracted
  try {
    appendFileSync("/tmp/adit-hook-debug.jsonl", JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: "parsed",
      platform,
      hookType: input.hookType,
      lastAssistantMessage: input.lastAssistantMessage,
      stopReason: input.stopReason,
      transcriptPath: input.transcriptPath,
      rawKeys: Object.keys(raw),
    }) + "\n");
  } catch { /* best-effort */ }

  await dispatchHook(input);
}

// Fail-open: catch everything, always exit 0.
// .finally() ensures the process exits immediately even when lingering
// handles (stdin listeners, network connections, timers) would keep it alive.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
