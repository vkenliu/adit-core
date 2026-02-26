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
  /** JWT access token (1-hour expiry) */
  accessToken: string;
  /** Opaque refresh token (90-day expiry) */
  refreshToken: string;
  /** Server-assigned client UUID */
  clientId: string;
  /** Access token expiration (ISO 8601) */
  expiresAt: string;
  /** Server URL these credentials belong to */
  serverUrl: string;
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
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.clientId) {
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
  const expiresAt = new Date(creds.expiresAt).getTime();
  const safetyMarginMs = 60_000; // Refresh 60s before actual expiry
  return Date.now() >= expiresAt - safetyMarginMs;
}
