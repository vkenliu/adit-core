/**
 * `adit search` — Search events with filters.
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  type AditEvent,
  type EventType,
} from "@adit/core";
import { getEventSummary } from "../utils/summary.js";
import { createTimelineManager } from "@adit/engine";

/** `adit search <query>` — search events with advanced filters */
export async function searchCommand(
  query: string,
  opts: {
    limit?: number;
    actor?: string;
    type?: string;
    from?: string;
    to?: string;
    branch?: string;
    hasCheckpoint?: boolean;
    format?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    let events = await timeline.search(query, opts.limit ?? 100);

    if (opts.actor) {
      events = events.filter((e) => e.actor === opts.actor);
    }
    if (opts.type) {
      events = events.filter((e) => e.eventType === (opts.type as EventType));
    }
    if (opts.from) {
      const fromDate = new Date(opts.from).toISOString();
      events = events.filter((e) => e.startedAt >= fromDate);
    }
    if (opts.to) {
      const toDate = new Date(opts.to).toISOString();
      events = events.filter((e) => e.startedAt <= toDate);
    }
    if (opts.branch) {
      events = events.filter((e) => e.gitBranch === opts.branch);
    }
    if (opts.hasCheckpoint) {
      events = events.filter((e) => e.checkpointSha != null);
    }

    events = events.slice(0, opts.limit ?? 20);

    if (opts.format === "json" || opts.json) {
      console.log(JSON.stringify(events.map(formatEventSummary), null, 2));
      return;
    }

    if (events.length === 0) {
      console.log(`No events matching "${query}"`);
      return;
    }

    console.log(`Found ${events.length} events matching "${query}":\n`);
    for (const event of events) {
      printEventLine(event);
    }
  } finally {
    closeDatabase(db);
  }
}

function printEventLine(event: AditEvent): void {
  const idShort = event.id.substring(0, 10);
  const time = event.startedAt.substring(5, 19).replace("T", " ");
  const labels = event.labelsJson ? ` ${JSON.parse(event.labelsJson).map((l: string) => `[${l}]`).join("")}` : "";
  const checkpoint = event.checkpointSha ? " *" : "";
  const snippet = getEventSummary(event, 80);
  console.log(`  ${idShort}  ${time}  [${event.actor[0].toUpperCase()}]${checkpoint}  ${snippet}${labels}`);
}

function formatEventSummary(event: AditEvent): Record<string, unknown> {
  return {
    id: event.id,
    eventType: event.eventType,
    actor: event.actor,
    startedAt: event.startedAt,
    gitBranch: event.gitBranch,
    checkpointSha: event.checkpointSha,
    labels: event.labelsJson ? JSON.parse(event.labelsJson) : [],
    snippet: getEventSummary(event, 200),
  };
}
