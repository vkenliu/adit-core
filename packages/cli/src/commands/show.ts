/**
 * `adit show <id>` — Show full event details.
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  parseLabels,
  parseDiffStats,
  parseError,
} from "@varveai/adit-core";
import { createTimelineManager } from "@varveai/adit-engine";

export async function showCommand(eventId: string): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const event = await timeline.get(eventId);
    if (!event) {
      // Try prefix match
      const { queryEvents } = await import("@varveai/adit-core");
      const all = queryEvents(db, { limit: 500 });
      const match = all.find((e) => e.id.startsWith(eventId));
      if (!match) {
        console.error(`Event not found: ${eventId}`);
        process.exit(1);
      }
      return showCommand(match.id);
    }

    console.log(`Event: ${event.id}`);
    console.log(`  Type:      ${event.eventType}`);
    console.log(`  Actor:     ${event.actor}`);
    console.log(`  Sequence:  ${event.sequence}`);
    console.log(`  Session:   ${event.sessionId}`);
    console.log(`  Started:   ${event.startedAt}`);
    console.log(`  Ended:     ${event.endedAt ?? "-"}`);
    console.log(`  Status:    ${event.status}`);
    console.log(`  Branch:    ${event.gitBranch ?? "-"}`);
    console.log(`  HEAD:      ${event.gitHeadSha ?? "-"}`);

    if (event.checkpointSha) {
      console.log(`  Checkpoint: ${event.checkpointSha}`);
      console.log(`  Ref:        ${event.checkpointRef}`);
    }

    const labels = parseLabels(event.labelsJson);
    if (labels.length > 0) {
      console.log(`  Labels:    ${labels.join(", ")}`);
    }

    const error = parseError(event.errorJson);
    if (error) {
      console.log(`  Error:     [${error.category}] ${error.message}`);
    }

    if (event.promptText) {
      console.log(`\n--- Prompt ---`);
      console.log(event.promptText);
    }

    if (event.cotText) {
      console.log(`\n--- Chain of Thought ---`);
      console.log(event.cotText);
    }

    if (event.responseText) {
      console.log(`\n--- Response ---`);
      console.log(event.responseText);
    }

    if (event.toolName) {
      console.log(`\n--- Tool: ${event.toolName} ---`);
      if (event.toolInputJson) {
        console.log("Input:", event.toolInputJson);
      }
      if (event.toolOutputJson) {
        console.log("Output:", event.toolOutputJson);
      }
    }

    const stats = parseDiffStats(event.diffStatJson);
    if (stats.length > 0) {
      console.log(`\n--- Files Changed (${stats.length}) ---`);
      for (const f of stats) {
        const adds = f.additions !== undefined ? `+${f.additions}` : "";
        const dels = f.deletions !== undefined ? `-${f.deletions}` : "";
        console.log(`  ${f.status} ${f.path} ${adds} ${dels}`);
      }
    }

    // Show diff if available
    const diff = await timeline.getDiff(event.id, 50);
    if (diff) {
      console.log(`\n--- Diff (first 50 lines) ---`);
      console.log(diff);
    }
  } finally {
    closeDatabase(db);
  }
}
