/**
 * Stop hook handler for Claude Code.
 *
 * Fires when Claude finishes responding. This handler:
 * 1. Detects code changes made by the assistant
 * 2. Creates a git checkpoint (shadow ref)
 * 3. Records an assistant_response event with the checkpoint
 * 4. Captures an environment snapshot if configured
 */

import { createTimelineManager, captureEnvironment, hasUncommittedChanges } from "@adit/engine";
import { initHookContext, readStdin } from "../common/context.js";

export async function handleStop(): Promise<void> {
  const input = await readStdin();

  const cwd = (input.cwd as string) ?? process.cwd();
  const stopReason = input.stop_reason as string | undefined;

  const ctx = await initHookContext(cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  // Only create checkpoint if there are actual changes
  const dirty = await hasUncommittedChanges(cwd);

  // Record the assistant response event
  const event = await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "assistant_response",
    actor: "assistant",
    responseText: stopReason ?? "completed",
  });

  // Create checkpoint if files changed
  if (dirty) {
    await timeline.createCheckpoint(
      event.id,
      `[adit] assistant response (${stopReason ?? "completed"})`,
    );
  }

  // Capture environment snapshot if configured
  if (ctx.config.captureEnv) {
    try {
      await captureEnvironment(ctx.db, ctx.config, ctx.session.id);
    } catch {
      // Fail-open: environment capture errors don't block
    }
  }

  ctx.db.close();
}
