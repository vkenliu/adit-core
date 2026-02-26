/**
 * ADIT configuration management.
 *
 * Loads config from environment variables with sensible defaults.
 * The data directory (.adit/) lives inside the project root by default.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface AditConfig {
  /** Project root directory (where .git lives) */
  projectRoot: string;
  /** Data directory for ADIT state */
  dataDir: string;
  /** SQLite database path */
  dbPath: string;
  /** Unique client identifier for this machine */
  clientId: string;
  /** Project identifier (hash of remote + root) */
  projectId: string;
  /** Git ref prefix for checkpoints */
  refPrefix: string;
  /** Max prompt chars to store (0 = unlimited) */
  maxPromptChars: number;
  /** Max diff lines to store (0 = unlimited) */
  maxDiffLines: number;
  /** Whether to capture environment snapshots */
  captureEnv: boolean;
  /** Keys to redact from tool I/O */
  redactKeys: string[];
}

/** Default sensitive keys to redact from recorded payloads */
const DEFAULT_REDACT_KEYS = [
  "authorization",
  "api_key",
  "apiKey",
  "token",
  "password",
  "secret",
  "credential",
  "private_key",
  "privateKey",
];

/** Get or create a persistent client ID */
function getClientId(): string {
  const configDir = join(homedir(), ".adit");
  const idFile = join(configDir, "client-id");

  if (existsSync(idFile)) {
    return readFileSync(idFile, "utf-8").trim();
  }

  // Generate deterministic ID from hostname + homedir
  const id = createHash("sha256")
    .update(`${homedir()}-${process.pid}-${Date.now()}`)
    .digest("hex")
    .substring(0, 16);

  return id;
}

/** Compute project ID from git remote and project root */
function computeProjectId(projectRoot: string, remoteUrl?: string): string {
  const input = remoteUrl
    ? `${remoteUrl}:${projectRoot}`
    : projectRoot;
  return createHash("sha256").update(input).digest("hex").substring(0, 16);
}

/** Find the git root by walking up from cwd */
export function findGitRoot(startDir?: string): string | null {
  let dir = resolve(startDir ?? process.cwd());
  while (dir !== "/") {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Load configuration from environment + defaults */
export function loadConfig(cwd?: string): AditConfig {
  const projectRoot =
    process.env.ADIT_PROJECT_ROOT ??
    findGitRoot(cwd) ??
    resolve(cwd ?? process.cwd());

  const dataDir =
    process.env.ADIT_DATA_DIR ?? join(projectRoot, ".adit");

  const dbPath =
    process.env.ADIT_DB_PATH ?? join(dataDir, "adit.sqlite");

  const clientId =
    process.env.ADIT_CLIENT_ID ?? getClientId();

  const remoteUrl = process.env.ADIT_REMOTE_URL;
  const projectId = computeProjectId(projectRoot, remoteUrl);

  const redactKeysEnv = process.env.ADIT_REDACT_KEYS;
  const redactKeys = redactKeysEnv
    ? redactKeysEnv.split(",").map((k) => k.trim())
    : DEFAULT_REDACT_KEYS;

  return {
    projectRoot,
    dataDir,
    dbPath,
    clientId,
    projectId,
    refPrefix: "refs/adit/checkpoints",
    maxPromptChars: parseInt(process.env.ADIT_MAX_PROMPT_CHARS ?? "0", 10),
    maxDiffLines: parseInt(process.env.ADIT_MAX_DIFF_LINES ?? "0", 10),
    captureEnv: process.env.ADIT_CAPTURE_ENV !== "false",
    redactKeys,
  };
}

/** Redact sensitive keys from an object (shallow) */
export function redactSensitiveKeys(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lowerKeys = new Set(keys.map((k) => k.toLowerCase()));

  for (const [key, value] of Object.entries(obj)) {
    if (lowerKeys.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactSensitiveKeys(
        value as Record<string, unknown>,
        keys,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
