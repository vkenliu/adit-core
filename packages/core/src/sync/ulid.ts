/**
 * ULID generation for globally unique, time-sortable identifiers.
 *
 * ULIDs are used as primary keys across all tables because:
 * 1. They are time-sortable (first 48 bits = timestamp)
 * 2. They are globally unique without coordination
 * 3. They sort lexicographically = natural merge ordering for cloud sync
 */

import { ulid, monotonicFactory } from "ulid";

/** Monotonic factory ensures ULIDs created in the same ms are still ordered */
const monotonic = monotonicFactory();

/** Generate a new ULID (monotonic within same millisecond) */
export function generateId(): string {
  return monotonic();
}

/** Generate a ULID with a specific timestamp (for testing or import) */
export function generateIdAt(timestamp: number): string {
  return ulid(timestamp);
}

/** Extract the timestamp from a ULID */
export function extractTimestamp(id: string): number {
  // ULID encodes time in first 10 chars (Crockford Base32)
  const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = 0;
  const chars = id.substring(0, 10).toUpperCase();
  for (const char of chars) {
    const idx = ENCODING.indexOf(char);
    if (idx === -1) throw new Error(`Invalid ULID character: ${char}`);
    time = time * 32 + idx;
  }
  return time;
}
