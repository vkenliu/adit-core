#!/usr/bin/env node

/**
 * ADIT hook dispatcher.
 *
 * Entry point for `adit-hook <command>`.
 * Uses the platform adapter pattern to handle events from any supported AI tool.
 * All errors are caught and swallowed — hooks must never block the AI agent.
 */

import { readStdin } from "./common/context.js";
import { detectPlatform, getAdapter } from "./adapters/index.js";
import { dispatchHook } from "./handlers/unified.js";

// Hard safety net: kill the process after 10 seconds no matter what.
// Hooks must never block the AI agent — this ensures we exit even if
// readStdin, database, git, or network operations hang.
setTimeout(() => process.exit(0), 10_000).unref();

const command = process.argv[2];

async function main(): Promise<void> {
  if (!command) return;

  const raw = await readStdin();
  const platform = detectPlatform();
  const adapter = getAdapter(platform);
  const input = adapter.parseInput(raw, command);

  await dispatchHook(input);
}

// Fail-open: catch everything, always exit 0.
// .finally() ensures the process exits immediately even when lingering
// handles (stdin listeners, network connections, timers) would keep it alive.
main()
  .catch(() => {})
  .finally(() => process.exit(0));
