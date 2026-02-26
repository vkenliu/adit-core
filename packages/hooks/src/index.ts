#!/usr/bin/env node

/**
 * ADIT hook dispatcher.
 *
 * Entry point for `npx adit-hook <command>`.
 * All errors are caught and swallowed — hooks must never block the AI agent.
 */

import { handlePromptSubmit } from "./claude/prompt-submit.js";
import { handleToolUse } from "./claude/tool-use.js";
import { handleStop } from "./claude/stop.js";

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "prompt-submit":
      await handlePromptSubmit();
      break;
    case "tool-use":
      await handleToolUse();
      break;
    case "stop":
      await handleStop();
      break;
    default:
      // Unknown command — exit silently
      break;
  }
}

// Fail-open: catch everything, exit 0
main().catch(() => {
  process.exit(0);
});
