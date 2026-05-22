/**
 * CLI entrypoint detection.
 *
 * Handles package manager bin links so the CLI runs when invoked through
 * node_modules/.bin/adit as well as when executed by its real file path.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isCliEntrypoint(
  metaUrl: string,
  argvPath: string | undefined,
): boolean {
  if (!argvPath) return false;

  try {
    return (
      realpathSync(fileURLToPath(metaUrl)) ===
      realpathSync(path.resolve(argvPath))
    );
  } catch {
    return false;
  }
}
