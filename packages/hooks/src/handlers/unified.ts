/**
 * Unified hook dispatcher.
 *
 * Platform-agnostic handler that processes normalized hook input
 * and delegates to the appropriate ADIT handler.
 */

import {
  getLatestEnvSnapshot,
  endSession,
  withPerf,
} from "@varveai/adit-core";
import {
  getChangedFiles,
  createTimelineManager,
  captureEnvironment,
  diffEnvironments,
} from "@varveai/adit-engine";
import { initHookContext, type HookContext } from "../common/context.js";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { NormalizedHookInput } from "../adapters/types.js";

/**
 * Dispatch a normalized hook input to the appropriate handler.
 * This is the single entry point for all platform hook events.
 */
export async function dispatchHook(input: NormalizedHookInput): Promise<void> {
  const ctx = await initHookContext(input.cwd, input.platformCli ?? "other", input.platformSessionId);
  const dataDir = ctx.config.dataDir;

  try {
    await withPerf(dataDir, "hook", input.hookType, async () => {
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
    });

    // Trigger transcript upload (fail-open).
    // Every hook event carries transcript_path, so we check on each event.
    // Awaited so db stays open until the query finishes.
    if (input.transcriptPath) {
      await withPerf(dataDir, "hook", "transcript-upload", () =>
        triggerTranscriptUploadIfEnabled(ctx, input),
      ).catch(() => {
        /* fail-open */
      });
    }

    // Auto-sync to cloud on every hook event (fail-open).
    // Uses dynamic import so @varveai/adit-cloud is not a build-time dependency.
    // The module name is constructed to prevent TypeScript from resolving it.
    // Force sync on session-end (flush all data) and on stop/session.idle
    // (ensures data is persisted even if /exit doesn't fire a session-end).
    try {
      await withPerf(dataDir, "network", "cloud-auto-sync", async () => {
        const cloudModuleName = ["@adit", "cloud"].join("/");
        const cloudModule = await import(cloudModuleName) as {
          triggerAutoSync: (db: unknown, projectId: string, options?: { force?: boolean }) => Promise<void>;
        };
        // Awaited so db stays open until it finishes querying.
        // The actual network push happens inside triggerAutoSync's own fire-and-forget.
        const force = input.hookType === "session-end" || input.hookType === "stop";
        await cloudModule.triggerAutoSync(ctx.db, ctx.config.projectId, force ? { force: true } : undefined);
      });
    } catch {
      // @varveai/adit-cloud not installed — silently skip
    }
  } finally {
    ctx.db.close();
  }
}

/** Handle prompt submission (kept lightweight — no git operations) */
async function handlePromptSubmitUnified(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  if (!input.prompt) return;

  const timeline = createTimelineManager(ctx.db, ctx.config);

  // Only record the prompt text. Manual-edit detection (getChangedFiles) is
  // deferred to handleStopUnified so this blocking UserPromptSubmit hook
  // stays fast and doesn't run `git status` on every keystroke-enter.
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

  // Use getChangedFiles directly so the result can be reused by captureEnvironment,
  // avoiding a duplicate `git status` call.
  const changedFiles = await withPerf(ctx.config.dataDir, "git", "getChangedFiles", () =>
    getChangedFiles(input.cwd),
  );
  const dirty = changedFiles.length > 0;

  const recentPrompts = await timeline.list({
    sessionId: ctx.session.id,
    eventType: "prompt_submit",
    limit: 1,
  });
  const lastPrompt = recentPrompts[0]?.promptText ?? null;

  // Use last_assistant_message as the response text (what the model actually said).
  // Cursor sometimes fires stop before transcript text is fully flushed, so
  // we retry transcript extraction briefly when message text is missing.
  const recoveredAssistantMessage = input.lastAssistantMessage
    ?? await recoverAssistantMessageFromTranscript(input.transcriptPath);
  // Fall back to stop_reason for backward compatibility, then to "completed".
  const responseText = recoveredAssistantMessage ?? input.stopReason ?? "completed";
  const checkpointLabel = input.stopReason ?? "completed";

  // Debug: log response resolution chain to trace why "completed" is recorded
  try {
    appendFileSync("/tmp/adit-hook-debug.jsonl", JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: "stop-response-resolution",
      hookType: input.hookType,
      platformCli: input.platformCli,
      hasLastAssistantMessage: !!input.lastAssistantMessage,
      hasTranscriptPath: !!input.transcriptPath,
      transcriptRecoveryResult: recoveredAssistantMessage ? "found" : "not-found",
      stopReason: input.stopReason,
      finalResponseText: responseText,
      rawPlatformDataKeys: input.rawPlatformData ? Object.keys(input.rawPlatformData) : [],
      rawPlatformData: input.rawPlatformData,
    }) + "\n");
  } catch { /* best-effort */ }

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
      changedFiles,
    );
  }

  if (ctx.config.captureEnv) {
    try {
      // Get previous snapshot before capturing new one
      const prevSnapshot = getLatestEnvSnapshot(ctx.db, ctx.session.id);
      // Pass pre-computed changed files to avoid duplicate git status call
      await withPerf(ctx.config.dataDir, "snapshot", "captureEnvironment", () =>
        captureEnvironment(ctx.db, ctx.config, ctx.session.id, {
          changedFiles,
        }),
      );

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

}

function extractLastAssistantTextFromTranscript(transcriptPath: string): string | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  try {
    const lines = readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as {
          role?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (entry.role !== "assistant") continue;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;
        const text = content
          .filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text.trim())
          .filter((t) => t.length > 0)
          .join("\n");
        if (text) return text;
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    // fail-open
  }
  return undefined;
}

async function recoverAssistantMessageFromTranscript(transcriptPath?: string): Promise<string | undefined> {
  if (!transcriptPath) return undefined;
  const delaysMs = [0, 120, 240, 480, 800];
  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const text = extractLastAssistantTextFromTranscript(transcriptPath);
    if (text) return text;
  }
  return undefined;
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
      await withPerf(ctx.config.dataDir, "snapshot", "captureEnvironment", () =>
        captureEnvironment(ctx.db, ctx.config, ctx.session.id),
      );
    } catch {
      // Fail-open
    }
  }

  // Trigger auto-sync on session start to ensure the Project record
  // exists server-side before the user runs `/adit link`.
  try {
    const { triggerAutoSync } = await import("@varveai/adit-cloud");
    triggerAutoSync(ctx.db, ctx.config.projectId).catch(() => {});
  } catch {
    // Fail-open — cloud package may not be available
  }

  // Trigger project-link auto-sync (fire-and-forget, fail-open).
  // Spawns a detached background process to sync branches, commits,
  // and documents — won't be killed by the 10s hook timeout.
  try {
    const cloudModuleName = ["@adit", "cloud"].join("/");
    const { triggerProjectLinkSync } = await import(cloudModuleName) as {
      triggerProjectLinkSync: (db: unknown, projectId: string, projectRoot: string) => Promise<void>;
    };
    triggerProjectLinkSync(ctx.db, ctx.config.projectId, ctx.config.projectRoot)
      .catch(() => {});
  } catch {
    // Fail-open — cloud package may not be available
  }
}

/** Handle session end — capture final env snapshot and close session */
async function handleSessionEnd(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  if (ctx.config.captureEnv) {
    try {
      await withPerf(ctx.config.dataDir, "snapshot", "captureEnvironment", () =>
        captureEnvironment(ctx.db, ctx.config, ctx.session.id),
      );
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

/** Handle notification — record notification event (tool results, session diffs, etc.) */
async function handleNotification(ctx: HookContext, input: NormalizedHookInput): Promise<void> {
  const timeline = createTimelineManager(ctx.db, ctx.config);

  const base: Record<string, unknown> = {
    message: input.notificationMessage,
    title: input.notificationTitle,
    notificationType: input.notificationType,
  };

  await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType: "notification",
    actor: "system",
    responseText: input.notificationMessage ?? "Notification",
    toolName: input.notificationType ?? null,
    toolInputJson: JSON.stringify(base),
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
 * Uses dynamic import so @varveai/adit-cloud is not a build-time dependency.
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
      ) => Promise<void>;
    };
    await cloudModule.triggerTranscriptUpload(
      ctx.db,
      ctx.session.id,
      input.transcriptPath,
    );
  } catch {
    // @varveai/adit-cloud not installed or other error — silently skip
  }
}
