/**
 * `adit export <id>` — Export an event bundle.
 *
 * Bundles an event with its prompt, diff, and metadata
 * into a single JSON document.
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  getEnvSnapshotById,
  parseLabels,
  parseDiffStats,
} from "@adit/core";
import { createTimelineManager } from "@adit/engine";

export interface ExportFormat {
  format: "json" | "jsonl";
}

export async function exportCommand(
  eventId: string,
  opts: { format?: string; output?: string },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const event = await timeline.get(eventId);
    if (!event) {
      console.error(`Event not found: ${eventId}`);
      process.exit(1);
    }

    const diff = await timeline.getDiff(eventId);
    const envSnapshot = event.envSnapshotId
      ? getEnvSnapshotById(db, event.envSnapshotId)
      : null;

    const bundle = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      event: {
        id: event.id,
        sessionId: event.sessionId,
        sequence: event.sequence,
        eventType: event.eventType,
        actor: event.actor,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        status: event.status,
        gitBranch: event.gitBranch,
        gitHeadSha: event.gitHeadSha,
        checkpointSha: event.checkpointSha,
        labels: parseLabels(event.labelsJson),
        fileStats: parseDiffStats(event.diffStatJson),
      },
      prompt: event.promptText ?? null,
      chainOfThought: event.cotText ?? null,
      response: event.responseText ?? null,
      tool: event.toolName
        ? {
            name: event.toolName,
            input: event.toolInputJson
              ? JSON.parse(event.toolInputJson)
              : null,
            output: event.toolOutputJson
              ? JSON.parse(event.toolOutputJson)
              : null,
          }
        : null,
      diff: diff ?? null,
      environment: envSnapshot
        ? {
            gitBranch: envSnapshot.gitBranch,
            gitHeadSha: envSnapshot.gitHeadSha,
            nodeVersion: envSnapshot.nodeVersion,
            pythonVersion: envSnapshot.pythonVersion,
            osInfo: envSnapshot.osInfo,
            depLockPath: envSnapshot.depLockPath,
            depLockHash: envSnapshot.depLockHash,
          }
        : null,
    };

    const output = JSON.stringify(bundle, null, 2);

    if (opts.output) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(opts.output, output);
      console.log(`Exported to ${opts.output}`);
    } else {
      console.log(output);
    }
  } finally {
    closeDatabase(db);
  }
}
