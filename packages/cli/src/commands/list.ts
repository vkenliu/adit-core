/**
 * `adit list` — Show timeline entries.
 *
 * Displays a compact, token-efficient table of recent events.
 */

import { loadConfig, openDatabase, closeDatabase, type AditEvent, type Actor, type EventType, parseDiffStats, parseLabels } from "@adit/core";
import { createTimelineManager } from "@adit/engine";

export interface ListCommandOptions {
  limit?: number;
  actor?: string;
  type?: string;
  checkpoints?: boolean;
  query?: string;
  expand?: boolean;
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
        limit: opts.limit ?? 20,
      });
    }

    if (events.length === 0) {
      console.log("No events found.");
      return;
    }

    // Print header
    console.log(
      padRight("ID", 12) +
        padRight("SEQ", 5) +
        padRight("ACTOR", 6) +
        padRight("TYPE", 20) +
        padRight("TIME", 20) +
        "SUMMARY",
    );
    console.log("-".repeat(90));

    for (const event of events) {
      const actorChar = actorSymbol(event.actor);
      const time = formatTime(event.startedAt);
      const summary = getSummary(event, opts.expand);
      const idShort = event.id.substring(0, 10);

      console.log(
        padRight(idShort, 12) +
          padRight(String(event.sequence), 5) +
          padRight(actorChar, 6) +
          padRight(event.eventType, 20) +
          padRight(time, 20) +
          summary,
      );
    }

    console.log(`\n${events.length} events shown.`);
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

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return iso.substring(11, 19);
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
