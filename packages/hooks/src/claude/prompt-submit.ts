/**
 * UserPromptSubmit hook handler for Claude Code.
 *
 * Fires when the user submits a prompt. This handler:
 * 1. Captures the prompt text
 * 2. Detects if user made manual edits since last checkpoint
 * 3. Records a user_edit event if the tree is dirty
 * 4. Records the prompt_submit event
 */

import { generateId, createClock, serialize, allocateSequence, insertEvent } from "@adit/core";
import { hasUncommittedChanges, getChangedFiles, createTimelineManager } from "@adit/engine";
import { initHookContext, readStdin } from "../common/context.js";

export async function handlePromptSubmit(): Promise<void> {
  const input = await readStdin();

  const sessionId = input.session_id as string | undefined;
  const cwd = (input.cwd as string) ?? process.cwd();
  const prompt = input.prompt as string | undefined;

  if (!prompt) return;

  const ctx = await initHookContext(cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  // Check if user made manual edits since last checkpoint
  const dirty = await hasUncommittedChanges(cwd);
  if (dirty) {
    const changes = await getChangedFiles(cwd);
    const userEditEvent = await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "user_edit",
      actor: "user",
      responseText: `Manual edits: ${changes.length} files changed`,
    });

    // Create a checkpoint for the user's manual edits
    await timeline.createCheckpoint(
      userEditEvent.id,
      `[adit] user edit before prompt (${changes.length} files)`,
    );
  }

  // Record the prompt submission
  await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "prompt_submit",
    actor: "user",
    promptText: prompt,
  });

  ctx.db.close();
}
