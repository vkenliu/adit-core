/**
 * Unified hook dispatcher.
 *
 * Platform-agnostic handler that processes normalized hook input
 * and delegates to the appropriate ADIT handler.
 */

import {
  getLatestEnvSnapshot,
  endSession,
} from "@adit/core";
import {
  hasUncommittedChanges,
  getChangedFiles,
  createTimelineManager,
  captureEnvironment,
  diffEnvironments,
} from "@adit/engine";
import { initHookContext, type HookContext } from "../common/context.js";
import type { NormalizedHookInput } from "../adapters/types.js";

/**
 * Dispatch a normalized hook input to the appropriate handler.
 * This is the single entry point for all platform hook events.
 */
export async function dispatchHook(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd);

  try {
    switch (input.hookType) {
      case "prompt-submit":
        await handlePromptSubmitUnified(ctx, input);
        break;
      case "stop":
        await handleStopUnified(ctx, input);
        break;
      case "session-start":
        await handleSessionStart(ctx, input);
        break;
      case "session-end":
        await handleSessionEnd(ctx, input);
        break;
      case "task-completed":
        await handleTaskCompleted(ctx, input);
        break;
      case "notification":
        await handleNotification(ctx, input);
        break;
      case "subagent-start":
        await handleSubagentStart(ctx, input);
        break;
      case "subagent-stop":
        await handleSubagentStop(ctx, input);
        break;
    }

    // Trigger transcript upload (fire-and-forget, fail-open).
    // Every hook event carries transcript_path, so we check on each event.
    // Reuses the existing ctx instead of opening a second DB connection.
    if (input.transcriptPath) {
      triggerTranscriptUploadIfEnabled(ctx, input).catch(() => {
        /* fail-open */
      });
    }
  } finally {
    ctx.db.close();
  }
}

/** Handle prompt submission */
async function handlePromptSubmitUnified(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  if (!input.prompt) return;

  const timeline = createTimelineManager(ctx.db, ctx.config);

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
}

/** Handle stop (assistant response complete) */
async function handleStopUnified(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

  const dirty = await hasUncommittedChanges(input.cwd);

  const recentPrompts = await timeline.list({
    sessionId: ctx.session.id,
    eventType: "prompt_submit",
    limit: 1,
  });
  const lastPrompt = recentPrompts[0]?.promptText ?? null;

  // Use last_assistant_message as the response text (what the model actually said).
  // Fall back to stop_reason for backward compatibility, then to "completed".
  const responseText = input.lastAssistantMessage ?? input.stopReason ?? "completed";
  const checkpointLabel = input.stopReason ?? "completed";

  const event = await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "assistant_response",
    actor: "assistant",
    promptText: lastPrompt,
    responseText,
  });

  if (dirty) {
    await timeline.createCheckpoint(
      event.id,
      `[adit] assistant response (${checkpointLabel})`,
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
    // Note: auto-sync is awaited so db stays open until it finishes querying.
    // The actual network push happens inside triggerAutoSync's own fire-and-forget.
    await cloudModule.triggerAutoSync(ctx.db, ctx.config.projectId);
  } catch {
    // @adit/cloud not installed — silently skip
  }
}

/** Handle session start — capture initial env snapshot and record metadata */
async function handleSessionStart(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

  // Record session start event with platform metadata
  const metadata: Record<string, unknown> = {};
  if (input.model) metadata.model = input.model;
  if (input.sessionSource) metadata.source = input.sessionSource;
  if (input.permissionMode) metadata.permissionMode = input.permissionMode;

  if (Object.keys(metadata).length > 0) {
    await timeline.recordEvent({
      sessionId: ctx.session.id,
      eventType: "checkpoint",
      actor: "system",
      responseText: `Session started (${input.sessionSource ?? "startup"})`,
      toolInputJson: JSON.stringify(metadata),
    });
  }

  if (ctx.config.captureEnv) {
    try {
      await captureEnvironment(ctx.db, ctx.config, ctx.session.id);
    } catch {
      // Fail-open
    }
  }
}

/** Handle session end — capture final env snapshot and close session */
async function handleSessionEnd(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  if (ctx.config.captureEnv) {
    try {
      await captureEnvironment(ctx.db, ctx.config, ctx.session.id);
    } catch {
      // Fail-open
    }
  }

  // Mark session as completed with end reason
  const status = input.sessionEndReason === "error" ? "error" : "completed";
  endSession(ctx.db, ctx.session.id, status);
}

/** Handle task completed — record semantic milestone in timeline */
async function handleTaskCompleted(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

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
}

/** Handle notification — record Claude Code notification event */
async function handleNotification(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

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
}

/** Handle subagent start — record when a subagent is spawned */
async function handleSubagentStart(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

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
}

/** Handle subagent stop — record when a subagent finishes */
async function handleSubagentStop(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

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
}

/**
 * Trigger transcript upload if cloud is configured.
 *
 * Uses dynamic import so @adit/cloud is not a build-time dependency.
 * Fully fail-open: errors are silently swallowed.
 *
 * Reuses the existing HookContext to avoid opening a second DB connection.
 */
async function triggerTranscriptUploadIfEnabled(
  ctx: HookContext,
  input: NormalizedHookInput,
): Promise<void> {
  if (!input.transcriptPath) return;

  try {
    const cloudModuleName = ["@adit", "cloud"].join("/");
    const cloudModule = (await import(cloudModuleName)) as {
      triggerTranscriptUpload: (
        db: unknown,
        sessionId: string,
        transcriptPath: string,
        cli?: string,
      ) => Promise<void>;
    };
    await cloudModule.triggerTranscriptUpload(
      ctx.db,
      ctx.session.id,
      input.transcriptPath,
      input.platformCli,
    );
  } catch {
    // @adit/cloud not installed or other error — silently skip
  }
}
