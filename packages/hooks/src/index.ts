#!/usr/bin/env node

/**
 * ADIT hook dispatcher.
 *
 * Entry point for `npx adit-hook <command>`.
 * Uses the platform adapter pattern to handle events from any supported AI tool.
 * All errors are caught and swallowed — hooks must never block the AI agent.
 */

import { readStdin } from "./common/context.js";
import { detectPlatform, getAdapter } from "./adapters/index.js";
import { dispatchHook } from "./handlers/unified.js";

const command = process.argv[2];

async function main(): Promise<void> {
  if (!command) return;

  const raw = await readStdin();
  const platform = detectPlatform();
  const adapter = getAdapter(platform);
  const input = adapter.parseInput(raw, command);

  await dispatchHook(input);
}

// Fail-open: catch everything, exit 0
main().catch(() => {
  process.exit(0);
});
