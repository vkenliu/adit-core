/**
 * Cloud credential storage.
 *
 * Persists JWT tokens and server-assigned client ID to
 * ~/.adit/cloud-credentials.json with restricted file permissions.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  chmodSync,
} from "node:fs";

export interface CloudCredentials {
  /** Authentication type: "device" (default) or "token" (static JWT) */
  authType?: "device" | "token";
  /** JWT access token (1-hour expiry for device, static for token) */
  accessToken: string;
  /** Opaque refresh token (90-day expiry); empty string for token auth */
  refreshToken: string;
  /** Server-assigned client UUID */
  clientId: string;
  /** Access token expiration (ISO 8601); empty string for token auth (never expires) */
  expiresAt: string;
  /** Server URL these credentials belong to */
  serverUrl: string;
  /** Consecutive sync error count (circuit breaker) */
  syncErrorCount?: number;
  /** True when circuit breaker has tripped (sync disabled) */
  syncDisabled?: boolean;
  /** ISO 8601 timestamp of the first error in the current failure window */
  firstSyncErrorAt?: string;
}

const CREDENTIALS_FILE = "cloud-credentials.json";

function credentialsPath(): string {
  return join(homedir(), ".adit", CREDENTIALS_FILE);
}

/** Load stored credentials, or null if not logged in */
export function loadCredentials(): CloudCredentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CloudCredentials;
    if (!parsed.accessToken) return null;
    // Token auth only requires accessToken; device auth requires all fields
    if (parsed.authType !== "token" && (!parsed.refreshToken || !parsed.clientId)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Save credentials to disk with restricted permissions (0600) */
export function saveCredentials(creds: CloudCredentials): void {
  const path = credentialsPath();
  mkdirSync(join(homedir(), ".adit"), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2), "utf-8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod may fail on some platforms (Windows) — not critical
  }
}

/** Remove stored credentials (logout) */
export function clearCredentials(): void {
  const path = credentialsPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/** Check if the access token has expired (with 60s safety margin) */
export function isTokenExpired(creds: CloudCredentials): boolean {
  // Static tokens never expire
  if (creds.authType === "token") return false;
  const expiresAt = new Date(creds.expiresAt).getTime();
  const safetyMarginMs = 60_000; // Refresh 60s before actual expiry
  return Date.now() >= expiresAt - safetyMarginMs;
}

/**
 * Create in-memory credentials from the ADIT_AUTH_TOKEN env var.
 * Returns null if the env var is not set.
 */
export function credentialsFromEnvToken(
  serverUrl: string,
  clientId: string,
): CloudCredentials | null {
  const token = process.env.ADIT_AUTH_TOKEN;
  if (!token) return null;
  return {
    authType: "token",
    accessToken: token,
    refreshToken: "",
    clientId,
    expiresAt: "",
    serverUrl,
  };
}

/** Default circuit breaker window in milliseconds (1 hour) */
const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000;

/**
 * Increment the sync error counter in stored credentials.
 *
 * The circuit breaker uses a time-windowed approach: errors are only
 * counted within a rolling window (default 1 hour). If the first error
 * in the current window is older than the window, the counter resets
 * before incrementing. This ensures that transient outages don't
 * permanently disable auto-sync.
 *
 * Returns true if sync is now disabled (threshold reached within window).
 */
export function incrementSyncErrors(threshold = 5): boolean {
  const creds = loadCredentials();
  if (!creds) return false;

  const now = new Date().toISOString();
  let count = creds.syncErrorCount ?? 0;
  let firstErrorAt = creds.firstSyncErrorAt ?? now;

  // If the first error is outside the window, reset the counter
  const elapsed = Date.now() - new Date(firstErrorAt).getTime();
  if (elapsed > CIRCUIT_BREAKER_WINDOW_MS) {
    count = 0;
    firstErrorAt = now;
  }

  count += 1;
  const disabled = count >= threshold;

  saveCredentials({
    ...creds,
    syncErrorCount: count,
    syncDisabled: disabled,
    firstSyncErrorAt: firstErrorAt,
  });
  return disabled;
}

/** Reset sync error counter and re-enable sync. */
export function clearSyncErrors(): void {
  const creds = loadCredentials();
  if (!creds) return;
  if (!creds.syncErrorCount && !creds.syncDisabled) return;
  saveCredentials({
    ...creds,
    syncErrorCount: 0,
    syncDisabled: false,
    firstSyncErrorAt: undefined,
  });
}

/**
 * Check if sync has been disabled by the circuit breaker.
 *
 * If the breaker is tripped but the error window has expired (>1 hour
 * since the first error), automatically resets the breaker and returns
 * false — giving auto-sync another chance.
 */
export function isSyncDisabled(): boolean {
  const creds = loadCredentials();
  if (creds?.syncDisabled !== true) return false;

  // Auto-reset if the error window has expired
  const firstErrorAt = creds.firstSyncErrorAt;
  if (firstErrorAt) {
    const elapsed = Date.now() - new Date(firstErrorAt).getTime();
    if (elapsed > CIRCUIT_BREAKER_WINDOW_MS) {
      clearSyncErrors();
      return false;
    }
  }

  return true;
}
