import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export type {
  PlatformAdapter,
  HookMapping,
  NormalizedHookInput,
  PlatformHookConfig,
  ValidationResult,
  ValidationCheck,
  AditHookType,
} from "./types.js";

export { claudeCodeAdapter } from "./claude-code.js";
export { opencodeAdapter } from "./opencode.js";
export { createStubAdapter, cursorAdapter, copilotAdapter, codexAdapter, otherAdapter } from "./stub.js";
export { getAdapter, listAdapters, registerAdapter, detectPlatform, detectPlatforms } from "./registry.js";

/**
 * Resolve the absolute path to the adit-hook binary for reliable invocation.
 * Navigates from this module's location to the entry point (dist/index.js),
 * avoiding npx which can hang when the package isn't found locally.
 */
export function resolveAditHookBinary(): string {
  try {
    // This module lives at <pkg>/dist/adapters/index.js (or src/ in dev).
    // The binary entry point is one directory up at <pkg>/dist/index.js.
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const binaryPath = join(thisDir, "..", "index.js");
    if (existsSync(binaryPath)) {
      return `node "${binaryPath}"`;
    }
  } catch {
    /* fall through */
  }
  // Fallback: when installed via npm globally, adit-hook is on PATH
  return "adit-hook";
}
