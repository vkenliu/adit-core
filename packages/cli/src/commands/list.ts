/**
 * `adit list` — Show timeline entries.
 *
 * Displays a compact, token-efficient table of recent events.
 */

import { loadConfig, openDatabase, closeDatabase, type AditEvent, type Actor, type EventType, parseDiffStats, parseLabels } from "@adit/core";
import { createTimelineManager } from "@adit/engine";
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
      const time = formatTime(event.startedAt);
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

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const time = d.toLocaleTimeString("en-US", { hour12: false });
    return `${month}/${day} ${time}`;
  } catch {
    return iso.substring(5, 19).replace("T", " ");
  }
}

function getSummary(event: AditEvent, expand?: boolean): string {
  const maxLen = expand ? 200 : 60;

  if (event.promptText) {
    return truncate(event.promptText.replace(/\n/g, " "), maxLen);
  }
  if (event.toolName) {
    return truncate(`${event.toolName}`, maxLen);
  }
  if (event.checkpointSha) {
    const stats = parseDiffStats(event.diffStatJson);
    const fileCount = stats.length;
    return `checkpoint ${event.checkpointSha.substring(0, 8)} (${fileCount} files)`;
  }
  if (event.responseText) {
    return truncate(event.responseText.replace(/\n/g, " "), maxLen);
  }

  const labels = parseLabels(event.labelsJson);
  if (labels.length > 0) {
    return labels.join(", ");
  }

  return event.eventType;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.substring(0, len) : s + " ".repeat(len - s.length);
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
