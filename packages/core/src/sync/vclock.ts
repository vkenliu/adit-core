/**
 * Vector clock implementation for conflict detection.
 *
 * Each client maintains its own counter. When syncing to cloud:
 * - If clock A dominates clock B → A is newer, no conflict
 * - If neither dominates → concurrent edits, needs merge
 *
 * For ADIT's append-only events, conflicts are rare (two clients
 * can't create the same ULID). Vector clocks primarily help with
 * mutable records like sessions and plans.
 */

export interface VectorClock {
  [clientId: string]: number;
}

/** Create a new vector clock with initial tick for this client */
export function createClock(clientId: string): VectorClock {
  return { [clientId]: 1 };
}

/** Increment this client's counter */
export function tick(clock: VectorClock, clientId: string): VectorClock {
  return {
    ...clock,
    [clientId]: (clock[clientId] ?? 0) + 1,
  };
}

/** Merge two clocks (take max of each client's counter) */
export function merge(a: VectorClock, b: VectorClock): VectorClock {
  const result: VectorClock = { ...a };
  for (const [client, count] of Object.entries(b)) {
    result[client] = Math.max(result[client] ?? 0, count);
  }
  return result;
}

/**
 * Compare two vector clocks.
 * Returns:
 *  -1 if a < b (a happened before b)
 *   0 if concurrent (neither dominates)
 *   1 if a > b (a happened after b)
 */
export function compare(a: VectorClock, b: VectorClock): -1 | 0 | 1 {
  const allClients = new Set([...Object.keys(a), ...Object.keys(b)]);

  let aGreater = false;
  let bGreater = false;

  for (const client of allClients) {
    const aVal = a[client] ?? 0;
    const bVal = b[client] ?? 0;

    if (aVal > bVal) aGreater = true;
    if (bVal > aVal) bGreater = true;
  }

  if (aGreater && !bGreater) return 1;
  if (bGreater && !aGreater) return -1;
  return 0; // concurrent or equal
}

/** Serialize a vector clock to JSON string */
export function serialize(clock: VectorClock): string {
  return JSON.stringify(clock);
}

/** Deserialize a JSON string to vector clock */
export function deserialize(json: string): VectorClock {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
