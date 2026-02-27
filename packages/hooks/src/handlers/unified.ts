/**
 * Unified hook dispatcher.
 *
 * Platform-agnostic handler that processes normalized hook input
 * and delegates to the appropriate ADIT handler.
 */

import { getLatestEnvSnapshot } from "@adit/core";
import {
  hasUncommittedChanges,
  getChangedFiles,
  createTimelineManager,
  captureEnvironment,
  diffEnvironments,
} from "@adit/engine";
import { initHookContext } from "../common/context.js";
import type { NormalizedHookInput } from "../adapters/types.js";

/**
 * Dispatch a normalized hook input to the appropriate handler.
 * This is the single entry point for all platform hook events.
 */
export async function dispatchHook(input: NormalizedHookInput): Promise<void> {
  switch (input.hookType) {
    case "prompt-submit":
      await handlePromptSubmitUnified(input);
      break;
    case "stop":
      await handleStopUnified(input);
      break;
    case "session-start":
      await handleSessionStart(input);
      break;
    case "session-end":
      await handleSessionEnd(input);
      break;
    case "task-completed":
      await handleTaskCompleted(input);
      break;
    case "notification":
      await handleNotification(input);
      break;
    case "subagent-start":
      await handleSubagentStart(input);
      break;
    case "subagent-stop":
      await handleSubagentStop(input);
      break;
  }
}

/** Handle prompt submission */
async function handlePromptSubmitUnified(input: NormalizedHookInput): Promise<void> {
  if (!input.prompt) return;

  const ctx = await initHookContext(input.cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  try {
    // Check if user made manual edits since last checkpoint
    const dirty = await hasUncommittedChanges(input.cwd);
    if (dirty) {
      const changes = await getChangedFiles(input.cwd);
      const userEditEvent = await timeline.recordEvent({
        sessionId: ctx.session.id,
        eventType: "user_edit",
        actor: "user",
        responseText: `Manual edits: ${changes.length} files changed`,
      });

      await timeline.createCheckpoint(
        userEditEvent.id,
        `[adit] user edit before prompt (${changes.length} files)`,
      );
    }

    await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "prompt_submit",
      actor: "user",
      promptText: input.prompt,
    });
  } finally {
    ctx.db.close();
  }
}

/** Handle stop (assistant response complete) */
async function handleStopUnified(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  try {
    const dirty = await hasUncommittedChanges(input.cwd);

    const recentPrompts = await timeline.list({
      sessionId: ctx.session.id,
      eventType: "prompt_submit",
      limit: 1,
    });
    const lastPrompt = recentPrompts[0]?.promptText ?? null;

    const event = await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "assistant_response",
      actor: "assistant",
      promptText: lastPrompt,
      responseText: input.stopReason ?? "completed",
    });

    if (dirty) {
      await timeline.createCheckpoint(
        event.id,
        `[adit] assistant response (${input.stopReason ?? "completed"})`,
      );
    }

    if (ctx.config.captureEnv) {
      try {
        // Get previous snapshot before capturing new one
        const prevSnapshot = getLatestEnvSnapshot(ctx.db, ctx.session.id);
        await captureEnvironment(ctx.db, ctx.config, ctx.session.id);

        // Detect env drift if we have a previous snapshot
        if (prevSnapshot) {
          const currentSnapshot = getLatestEnvSnapshot(ctx.db, ctx.session.id);
          if (currentSnapshot) {
            const diff = diffEnvironments(prevSnapshot, currentSnapshot);
            if (diff.changes.length > 0) {
              await timeline.recordEvent({
                sessionId: ctx.session.id,
                eventType: "env_drift",
                actor: "system",
                responseText: `Environment drift detected: ${diff.changes.length} changes (${diff.severity})`,
                toolInputJson: JSON.stringify(diff),
              });
            }
          }
        }
      } catch {
        // Fail-open
      }
    }

    // Auto-sync to cloud (fire-and-forget, fail-open)
    // Uses dynamic import so @adit/cloud is not a build-time dependency.
    // The module name is constructed to prevent TypeScript from resolving it.
    try {
      const cloudModuleName = ["@adit", "cloud"].join("/");
      const cloudModule = await import(cloudModuleName) as {
        triggerAutoSync: (db: unknown, projectId: string) => Promise<void>;
      };
      cloudModule.triggerAutoSync(ctx.db, ctx.config.projectId).catch(() => {
        /* fail-open */
      });
    } catch {
      // @adit/cloud not installed — silently skip
    }
  } finally {
    ctx.db.close();
  }
}

/** Handle session start — capture initial env snapshot */
async function handleSessionStart(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd);

  try {
    if (ctx.config.captureEnv) {
      try {
        await captureEnvironment(ctx.db, ctx.config, ctx.session.id);
      } catch {
        // Fail-open
      }
    }
  } finally {
    ctx.db.close();
  }
}

/** Handle session end — capture final env snapshot and close session */
async function handleSessionEnd(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd);

  try {
    if (ctx.config.captureEnv) {
      try {
        await captureEnvironment(ctx.db, ctx.config, ctx.session.id);
      } catch {
        // Fail-open
      }
    }

    // Mark session as completed
    const { endSession } = await import("@adit/core");
    endSession(ctx.db, ctx.session.id, "completed");
  } finally {
    ctx.db.close();
  }
}

/** Handle task completed — record semantic milestone in timeline */
async function handleTaskCompleted(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  try {
    await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "task_completed",
      actor: "assistant",
      responseText: input.taskSubject ?? "Task completed",
      toolName: input.taskId ?? null,
      toolInputJson: JSON.stringify({
        taskId: input.taskId,
        taskSubject: input.taskSubject,
        taskDescription: input.taskDescription,
        teammateName: input.teammateName,
        teamName: input.teamName,
      }),
    });
  } finally {
    ctx.db.close();
  }
}

/** Handle notification — record Claude Code notification event */
async function handleNotification(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  try {
    await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "notification",
      actor: "system",
      responseText: input.notificationMessage ?? "Notification",
      toolName: input.notificationType ?? null,
      toolInputJson: JSON.stringify({
        message: input.notificationMessage,
        title: input.notificationTitle,
        notificationType: input.notificationType,
      }),
    });
  } finally {
    ctx.db.close();
  }
}

/** Handle subagent start — record when a subagent is spawned */
async function handleSubagentStart(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  try {
    await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "subagent_start",
      actor: "assistant",
      responseText: `Subagent started: ${input.agentType ?? "unknown"}`,
      toolName: input.agentType ?? null,
      toolInputJson: JSON.stringify({
        agentId: input.agentId,
        agentType: input.agentType,
      }),
    });
  } finally {
    ctx.db.close();
  }
}

/** Handle subagent stop — record when a subagent finishes */
async function handleSubagentStop(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  try {
    await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "subagent_stop",
      actor: "assistant",
      responseText: input.lastAssistantMessage
        ? `Subagent finished: ${input.agentType ?? "unknown"}`
        : `Subagent stopped: ${input.agentType ?? "unknown"}`,
      toolName: input.agentType ?? null,
      toolInputJson: JSON.stringify({
        agentId: input.agentId,
        agentType: input.agentType,
        agentTranscriptPath: input.agentTranscriptPath,
      }),
      toolOutputJson: input.lastAssistantMessage
        ? JSON.stringify({ lastAssistantMessage: input.lastAssistantMessage })
        : null,
    });
  } finally {
    ctx.db.close();
  }
}
