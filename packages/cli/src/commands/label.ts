/**
 * `adit label` — Manage labels on events.
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  queryEvents,
  getActiveSession,
  type AditEvent,
} from "@adit/core";
import { createTimelineManager } from "@adit/engine";

const LABEL_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

/** `adit label <id> <label>` — add a label to an event */
export async function labelCommand(
  eventId: string,
  label: string,
): Promise<void> {
  if (!LABEL_REGEX.test(label)) {
    console.error(`Invalid label format. Must be alphanumeric/hyphens, max 50 chars.`);
    process.exit(1);
  }

  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    await timeline.addLabel(eventId, label);
    console.log(`Added label "${label}" to event ${eventId.substring(0, 10)}`);
  } finally {
    closeDatabase(db);
  }
}

/** `adit label remove <id> <label>` — remove a label from an event */
export async function labelRemoveCommand(
  eventId: string,
  label: string,
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

    const labels: string[] = event.labelsJson ? JSON.parse(event.labelsJson) : [];
    const idx = labels.indexOf(label);
    if (idx === -1) {
      console.error(`Label "${label}" not found on event ${eventId.substring(0, 10)}`);
      process.exit(1);
    }

    labels.splice(idx, 1);

    const { updateEventLabels, tick, deserialize, serialize } = await import("@adit/core");
    const vclock = tick(deserialize(event.vclockJson), config.clientId);
    updateEventLabels(db, eventId, JSON.stringify(labels), serialize(vclock));

    console.log(`Removed label "${label}" from event ${eventId.substring(0, 10)}`);
  } finally {
    closeDatabase(db);
  }
}

/** `adit label list` — list all labels or events with a specific label */
export async function labelListCommand(
  opts?: { label?: string; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  try {
    const session = getActiveSession(db, config.projectId, config.clientId);
    const events = queryEvents(db, {
      sessionId: session?.id,
      limit: 1000,
    });

    if (opts?.label) {
      const matched = events.filter((e) => {
        if (!e.labelsJson) return false;
        try {
          const labels: string[] = JSON.parse(e.labelsJson);
          return labels.includes(opts.label!);
        } catch {
          return false;
        }
      });

      if (opts.json) {
        console.log(JSON.stringify(matched.map(formatEventSummary), null, 2));
        return;
      }

      if (matched.length === 0) {
        console.log(`No events with label "${opts.label}"`);
        return;
      }

      console.log(`Events with label "${opts.label}":\n`);
      for (const event of matched) {
        printEventLine(event);
      }
    } else {
      const labelMap = new Map<string, number>();
      for (const event of events) {
        if (!event.labelsJson) continue;
        try {
          const labels: string[] = JSON.parse(event.labelsJson);
          for (const label of labels) {
            labelMap.set(label, (labelMap.get(label) ?? 0) + 1);
          }
        } catch {
          // ignore
        }
      }

      if (opts?.json) {
        console.log(JSON.stringify(Object.fromEntries(labelMap), null, 2));
        return;
      }

      if (labelMap.size === 0) {
        console.log("No labels found. Use `adit label <id> <label>` to add one.");
        return;
      }

      console.log("Labels:\n");
      for (const [label, count] of [...labelMap.entries()].sort()) {
        console.log(`  ${label} (${count} events)`);
      }
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
  const snippet =
    event.promptText?.substring(0, 80) ??
    event.toolName ??
    event.responseText?.substring(0, 80) ??
    event.eventType;
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
    snippet:
      event.promptText?.substring(0, 200) ??
      event.toolName ??
      event.responseText?.substring(0, 200) ??
      null,
  };
}
