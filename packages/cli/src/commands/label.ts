/**
 * `adit label <id> <label>` — Add a label to an event.
 * `adit search <query>` — Search events by text.
 */

import { loadConfig, openDatabase, closeDatabase } from "@adit/core";
import { createTimelineManager } from "@adit/engine";

export async function labelCommand(
  eventId: string,
  label: string,
): Promise<void> {
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

export async function searchCommand(
  query: string,
  opts: { limit?: number },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const timeline = createTimelineManager(db, config);

  try {
    const events = await timeline.search(query, opts.limit ?? 20);

    if (events.length === 0) {
      console.log(`No events matching "${query}"`);
      return;
    }

    console.log(`Found ${events.length} events matching "${query}":\n`);
    for (const event of events) {
      const idShort = event.id.substring(0, 10);
      const time = event.startedAt.substring(11, 19);
      const snippet =
        event.promptText?.substring(0, 80) ??
        event.toolName ??
        event.responseText?.substring(0, 80) ??
        event.eventType;
      console.log(`  ${idShort}  ${time}  [${event.actor[0].toUpperCase()}]  ${snippet}`);
    }
  } finally {
    closeDatabase(db);
  }
}
