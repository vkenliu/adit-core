/**
 * Timeline manager — the high-level orchestrator.
 *
 * Coordinates between the database, git operations, and snapshot creation
 * to provide the unified timeline experience.
 */

import type Database from "better-sqlite3";
import {
  generateId,
  createClock,
  serialize,
  insertEvent,
  allocateSequence,
  getEventById,
  queryEvents,
  updateEventCheckpoint,
  updateEventLabels,
  searchEvents,
  getLatestCheckpointEvent,
  insertDiff,
  getDiffText,
  type AditEvent,
  type EventType,
  type Actor,
  type AditConfig,
  tick,
  deserialize,
  withPerf,
} from "@adit/core";
import { createSnapshot, getCheckpointDiff } from "../snapshot/creator.js";
import type { FileChange } from "../detector/working-tree.js";
import { getHeadSha, getCurrentBranch } from "../git/runner.js";
import { getRefPrefix } from "../git/refs.js";
import { runGitOrThrow } from "../git/runner.js";

export interface TimelineManager {
  /** Record a new event in the timeline */
  recordEvent(params: RecordEventParams): Promise<AditEvent>;

  /** Create a git checkpoint for an event */
  createCheckpoint(
    eventId: string,
    message: string,
    preComputedChanges?: FileChange[],
  ): Promise<{ sha: string; ref: string } | null>;

  /** Revert working tree to a checkpoint */
  revertTo(eventId: string): Promise<void>;

  /** Undo the last checkpoint */
  undo(): Promise<void>;

  /** Add a label to an event */
  addLabel(eventId: string, label: string): Promise<void>;

  /** Search events by text */
  search(query: string, limit?: number): Promise<AditEvent[]>;

  /** List recent events */
  list(opts?: ListOptions): Promise<AditEvent[]>;

  /** Get a single event by ID */
  get(eventId: string): Promise<AditEvent | null>;

  /** Get diff text for an event */
  getDiff(
    eventId: string,
    maxLines?: number,
    offsetLines?: number,
  ): Promise<string | null>;
}

export interface RecordEventParams {
  sessionId: string;
  parentEventId?: string | null;
  eventType: EventType;
  actor: Actor;
  promptText?: string | null;
  cotText?: string | null;
  responseText?: string | null;
  toolName?: string | null;
  toolInputJson?: string | null;
  toolOutputJson?: string | null;
  errorJson?: string | null;
  planTaskId?: string | null;
}

export interface ListOptions {
  sessionId?: string;
  eventType?: EventType;
  actor?: Actor;
  hasCheckpoint?: boolean;
  limit?: number;
}

/** Create a timeline manager instance */
export function createTimelineManager(
  db: Database.Database,
  config: AditConfig,
): TimelineManager {
  const cwd = config.projectRoot;

  return {
    async recordEvent(params: RecordEventParams): Promise<AditEvent> {
      const id = generateId();
      const sequence = allocateSequence(db, params.sessionId);
      const now = new Date().toISOString();
      const branch = await getCurrentBranch(cwd);
      const headSha = await getHeadSha(cwd);
      const vclock = serialize(createClock(config.clientId));

      insertEvent(db, {
        id,
        sessionId: params.sessionId,
        parentEventId: params.parentEventId ?? null,
        sequence,
        eventType: params.eventType,
        actor: params.actor,
        promptText: params.promptText ?? null,
        cotText: params.cotText ?? null,
        responseText: params.responseText ?? null,
        toolName: params.toolName ?? null,
        toolInputJson: params.toolInputJson ?? null,
        toolOutputJson: params.toolOutputJson ?? null,
        gitBranch: branch,
        gitHeadSha: headSha,
        startedAt: now,
        status: "success",
        endedAt: now,
        errorJson: params.errorJson ?? null,
        planTaskId: params.planTaskId ?? null,
        clientId: config.clientId,
        vclockJson: vclock,
      });

      return getEventById(db, id)!;
    },

    async createCheckpoint(
      eventId: string,
      message: string,
      preComputedChanges?: FileChange[],
    ): Promise<{ sha: string; ref: string } | null> {
      return withPerf(config.dataDir, "snapshot", "createCheckpoint", async () => {
        const event = getEventById(db, eventId);
        if (!event) throw new Error(`Event not found: ${eventId}`);

        // Find the parent checkpoint SHA for proper chaining
        const lastCheckpoint = getLatestCheckpointEvent(db, event.sessionId);
        const parentSha = lastCheckpoint?.checkpointSha ?? (await getHeadSha(cwd));

        const refPath = `${getRefPrefix()}/${eventId}`;
        const result = await createSnapshot(cwd, parentSha, message, refPath, preComputedChanges);
        if (!result) return null;

        // Store the diff
        const diffText = await getCheckpointDiff(
          cwd,
          result.sha,
          parentSha ?? undefined,
        );
        if (diffText) {
          insertDiff(db, {
            id: generateId(),
            eventId,
            diffText,
          });
        }

        // Update the event with checkpoint info
        updateEventCheckpoint(
          db,
          eventId,
          result.sha,
          result.ref,
          JSON.stringify(result.files),
        );

        return { sha: result.sha, ref: result.ref };
      });
    },

    async revertTo(eventId: string): Promise<void> {
      const event = getEventById(db, eventId);
      if (!event) throw new Error(`Event not found: ${eventId}`);
      if (!event.checkpointSha) {
        throw new Error(`Event ${eventId} has no checkpoint`);
      }

      // Record the revert action itself
      await runGitOrThrow(
        ["reset", "--hard", event.checkpointSha],
        { cwd },
      );
    },

    async undo(): Promise<void> {
      const latest = getLatestCheckpointEvent(db);
      if (!latest?.checkpointSha) {
        throw new Error("No checkpoints to undo");
      }

      // Find parent of latest checkpoint
      const parentResult = await import("../git/refs.js").then((m) =>
        m.getParentSha(cwd, latest.checkpointSha!),
      );
      if (!parentResult) {
        throw new Error("Cannot find parent of latest checkpoint");
      }

      await runGitOrThrow(["reset", "--hard", parentResult], { cwd });
    },

    async addLabel(eventId: string, label: string): Promise<void> {
      const event = getEventById(db, eventId);
      if (!event) throw new Error(`Event not found: ${eventId}`);

      const labels: string[] = event.labelsJson
        ? JSON.parse(event.labelsJson)
        : [];
      if (!labels.includes(label)) {
        labels.push(label);
      }

      const vclock = tick(deserialize(event.vclockJson), config.clientId);
      updateEventLabels(db, eventId, JSON.stringify(labels), serialize(vclock));
    },

    async search(query: string, limit = 20): Promise<AditEvent[]> {
      return searchEvents(db, query, limit);
    },

    async list(opts?: ListOptions): Promise<AditEvent[]> {
      return queryEvents(db, {
        sessionId: opts?.sessionId,
        eventType: opts?.eventType,
        actor: opts?.actor,
        hasCheckpoint: opts?.hasCheckpoint,
        limit: opts?.limit ?? 50,
      });
    },

    async get(eventId: string): Promise<AditEvent | null> {
      return getEventById(db, eventId);
    },

    async getDiff(
      eventId: string,
      maxLines?: number,
      offsetLines?: number,
    ): Promise<string | null> {
      return getDiffText(db, eventId, maxLines, offsetLines);
    },
  };
}
