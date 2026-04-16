/**
 * `adit list` — Show timeline entries.
 *
 * Displays a compact, token-efficient table of recent events.
 */

import { loadConfig, openDatabase, closeDatabase, type AditEvent, type Actor, type EventType } from "@varveai/adit-core";
import { getEventSummary } from "../utils/summary.js";
import { padRight, formatDateTime } from "../utils/format.js";
import { createTimelineManager } from "@varveai/adit-engine";
import pc from "picocolors";

export type SortField = "ACTOR" | "TIME";

export interface ListCommandOptions {
  limit?: number;
  actor?: string;
  type?: string;
  checkpoints?: boolean;
  query?: string;
  expand?: boolean;
  sort?: SortField;
  json?: boolean;
}

export async function listCommand(opts: ListCommandOptions): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    let events: AditEvent[];

    if (opts.query) {
      events = await timeline.search(opts.query, opts.limit ?? 20);
    } else {
      events = await timeline.list({
        actor: opts.actor as Actor | undefined,
        eventType: opts.type as EventType | undefined,
        hasCheckpoint: opts.checkpoints,
        limit: opts.limit ?? 50,
      });
    }

    if (events.length === 0) {
      console.log("No events found.");
      return;
    }

    // Sort events — default is TIME (descending, most recent first)
    const sortField = opts.sort ?? "TIME";
    events = sortEvents(events, sortField);

    // JSON output
    if (opts.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }

    // Print header
    console.log(
      pc.bold(
        padRight("ID", 12) +
          padRight("ACTOR", 6) +
          padRight("TYPE", 20) +
          padRight("TIME", 20) +
          "SUMMARY",
      ),
    );
    console.log(pc.dim("-".repeat(85)));

    for (const event of events) {
      const actor = actorSymbol(event.actor);
      const time = formatDateTime(event.startedAt);
      const summary = getSummary(event, opts.expand);
      const idShort = event.id.substring(0, 10);
      const checkpoint = event.checkpointSha ? " " + pc.green("*") : "";

      console.log(
        pc.dim(padRight(idShort, 12)) +
          colorActor(padRight(actor, 6), event.actor) +
          padRight(event.eventType, 20) +
          pc.dim(padRight(time, 20)) +
          summary +
          checkpoint,
      );
    }

    console.log(pc.dim(`\n${events.length} events shown (sorted by ${sortField}).`));
  } finally {
    closeDatabase(db);
  }
}

function actorSymbol(actor: string): string {
  switch (actor) {
    case "assistant":
      return "[A]";
    case "user":
      return "[U]";
    case "tool":
      return "[T]";
    case "system":
      return "[S]";
    default:
      return "[?]";
  }
}

function colorActor(text: string, actor: string): string {
  switch (actor) {
    case "assistant":
      return pc.green(text);
    case "user":
      return pc.cyan(text);
    case "tool":
      return pc.yellow(text);
    case "system":
      return pc.magenta(text);
    default:
      return text;
  }
}

function getSummary(event: AditEvent, expand?: boolean): string {
  return getEventSummary(event, expand ? 200 : 60);
}

export function sortEvents(events: AditEvent[], field: SortField): AditEvent[] {
  const sorted = [...events];
  switch (field) {
    case "ACTOR":
      sorted.sort((a, b) => a.actor.localeCompare(b.actor));
      break;
    case "TIME":
    default:
      sorted.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      break;
  }
  return sorted;
}
