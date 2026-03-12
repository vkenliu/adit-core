/**
 * `adit cloud` — Cloud sync commands.
 *
 * Subcommands:
 *   login             — Authenticate via device code flow
 *   logout            — Clear stored credentials
 *   sync              — Push unsynced records to cloud
 *   status            — Show sync state and unsynced count
 *   reset-credentials — Force-clear all credentials and sync state
 */

import { loadConfig, openDatabase, closeDatabase } from "@adit/core";
import {
  loadCloudConfig,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  isTokenExpired,
  requestDeviceCode,
  pollForToken,
  CloudClient,
  SyncEngine,
  countUnsyncedRecords,
  CloudAuthError,
  CloudNetworkError,
  CloudApiError,
  clearSyncErrors,
  isSyncDisabled,
  DEFAULT_SERVER_URL,
} from "@adit/cloud";
import type { DeviceAuthOptions } from "@adit/cloud";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { CLI_VERSION } from "../version.js";

/**
 * `adit cloud login` — Interactive device authorization flow.
 */
export async function cloudLoginCommand(opts?: {
  server?: string;
}): Promise<void> {
  const serverUrl = opts?.server ?? process.env.ADIT_CLOUD_URL ?? DEFAULT_SERVER_URL;
  const config = loadConfig();

  // Single-server binding: reject login if already bound to a different server
  const existingCredentials = loadCredentials();
  if (existingCredentials && existingCredentials.serverUrl !== serverUrl) {
    console.error(
      `Already authenticated with ${existingCredentials.serverUrl}.`,
    );
    console.error(
      "A client can only be connected to one cloud server at a time.",
    );
    console.error(
      "Run 'adit cloud reset-credentials' first to disconnect, then try again.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Connecting to ${serverUrl}...`);
  console.log();

  // Build machine identifier (deterministic per-machine)
  const machineId = createHash("sha256")
    .update(`${hostname()}-${config.clientId}`)
    .digest("hex")
    .substring(0, 32);

  const authOptions: DeviceAuthOptions = {
    machineId,
    platform: `${process.platform}-${process.arch}`,
    aditVersion: CLI_VERSION,
    displayName: hostname(),
  };

  try {
    // Step 1: Request device code
    const deviceCode = await requestDeviceCode(serverUrl, authOptions);

    console.log("To authenticate, open this URL in your browser:");
    console.log(`  ${deviceCode.verificationUrl}`);
    console.log();
    console.log(`Then enter this code: ${deviceCode.userCode}`);
    console.log();
    console.log("Waiting for approval... (press Ctrl+C to cancel)");

    // Step 2: Poll for approval
    const tokenResponse = await pollForToken(
      serverUrl,
      deviceCode.deviceCode,
    );

    // Step 3: Save credentials
    const expiresAt = new Date(
      Date.now() + 60 * 60 * 1000, // 1 hour from now
    ).toISOString();

    saveCredentials({
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      clientId: tokenResponse.clientId,
      expiresAt: tokenResponse.expiresAt ?? expiresAt,
      serverUrl,
    });

    // Reset any error state from previous sync failures
    clearSyncErrors();

    console.log();
    console.log("Authenticated successfully.");
    console.log(`Client ID: ${tokenResponse.clientId}`);
    console.log("Credentials saved to ~/.adit/cloud-credentials.json");
  } catch (error) {
    if (error instanceof CloudApiError) {
      console.error(`Login failed: ${error.message}`);
    } else if (error instanceof CloudNetworkError) {
      console.error(`Cannot reach ${serverUrl}: ${error.message}`);
    } else {
      console.error(
        `Login failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
  }
}

/**
 * `adit cloud logout` — Clear stored credentials.
 */
export async function cloudLogoutCommand(): Promise<void> {
  const credentials = loadCredentials();

  if (!credentials) {
    console.log("Not logged in to any cloud server.");
    return;
  }

  // Try to revoke the refresh token on the server
  try {
    const client = new CloudClient(credentials.serverUrl, credentials);
    await client.post("/api/auth/token/revoke", {
      refreshToken: credentials.refreshToken,
    });
  } catch {
    // Best-effort revocation — don't block logout on network errors
  }

  // Clear local sync state
  const config = loadConfig();
  try {
    const db = openDatabase(config.dbPath);
    try {
      const { clearSyncState } = await import("@adit/core");
      clearSyncState(db, credentials.serverUrl);
    } finally {
      closeDatabase(db);
    }
  } catch {
    // Database may not exist
  }

  clearCredentials();
  console.log("Logged out. Credentials cleared.");
}

/**
 * `adit cloud sync` — Push unsynced records to cloud.
 */
export async function cloudSyncCommand(opts?: {
  json?: boolean;
}): Promise<void> {
  const cloudConfig = loadCloudConfig();
  const credentials = loadCredentials();

  if (!credentials) {
    const msg =
      "Not logged in. Run 'adit cloud login' or 'adit cloud auth-token <jwt>' first.";
    if (opts?.json) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  // Re-enable sync if circuit breaker was tripped (manual sync = user intent)
  if (isSyncDisabled()) {
    clearSyncErrors();
  }

  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl;
  const config = loadConfig();

  if (!opts?.json) {
    console.log(`Syncing with ${serverUrl}...`);
  }

  const db = openDatabase(config.dbPath);
  try {
    const client = new CloudClient(serverUrl, credentials);
    const engine = new SyncEngine(db, client, {
      projectId: config.projectId,
      batchSize: cloudConfig.batchSize,
      serverUrl,
      cloudClientId: credentials.clientId,
    });

    const result = await engine.sync();

    if (opts?.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.batches === 0) {
        console.log("Already up to date. No records to sync.");
      } else {
        console.log(
          `Sync complete: ${result.accepted} accepted, ${result.duplicates} duplicates, ${result.conflicts.length} conflicts (${result.batches} batch${result.batches !== 1 ? "es" : ""})`,
        );
      }
    }
  } catch (error) {
    const msg =
      error instanceof CloudAuthError
        ? `Authentication failed: ${error.message}. Run 'adit cloud login' to re-authenticate.`
        : error instanceof CloudNetworkError
          ? `Network error: ${error.message}`
          : `Sync failed: ${error instanceof Error ? error.message : String(error)}`;

    if (opts?.json) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(msg);
    }
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

/**
 * `adit cloud status` — Show sync state and unsynced record count.
 */
export async function cloudStatusCommand(opts?: {
  json?: boolean;
}): Promise<void> {
  const cloudConfig = loadCloudConfig();
  const credentials = loadCredentials();
  const config = loadConfig();

  // Reset circuit breaker on manual status check
  clearSyncErrors();

  const status: Record<string, unknown> = {
    serverUrl: cloudConfig.serverUrl,
    enabled: cloudConfig.enabled,
    autoSync: cloudConfig.autoSync,
    loggedIn: credentials !== null,
  };

  if (credentials) {
    status.authType = credentials.authType ?? "device";
    status.clientId = credentials.clientId;
    status.tokenExpired = isTokenExpired(credentials);
  }

  // Check server reachability
  const serverUrl = cloudConfig.serverUrl ?? credentials?.serverUrl;
  if (serverUrl && credentials) {
    try {
      const client = new CloudClient(serverUrl, credentials);
      const params = new URLSearchParams();
      if (config.projectId) params.set("projectId", config.projectId);
      const statusPath = params.toString()
        ? `/api/sync/status?${params.toString()}`
        : "/api/sync/status";
      const remoteStatus = await client.get<{
        lastSyncedEventId: string | null;
        syncVersion: number;
        lastSyncedAt: string | null;
        projectCursors?: Record<string, {
          lastSyncedEventId: string | null;
          lastSyncedAt: string | null;
        }>;
      }>(statusPath);
      status.serverOnline = true;
      status.remoteStatus = remoteStatus;
    } catch (error) {
      status.serverOnline = false;
      status.serverError =
        error instanceof CloudNetworkError
          ? `unreachable — ${error.cause?.message ?? error.message}`
          : error instanceof CloudAuthError
            ? `auth failed — ${error.message}`
            : error instanceof CloudApiError
              ? `server error — ${error.status} ${error.message}`
              : `error — ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Count unsynced records
  try {
    const db = openDatabase(config.dbPath);
    try {
      const { getSyncState } = await import("@adit/core");
      const syncState = getSyncState(
        db,
        cloudConfig.serverUrl ?? credentials?.serverUrl ?? "",
      );

      status.syncState = syncState
        ? {
            lastSyncedEventId: syncState.lastSyncedEventId,
            lastSyncedAt: syncState.lastSyncedAt,
            syncVersion: syncState.syncVersion,
          }
        : null;

      const unsyncedCount = countUnsyncedRecords(
        db,
        syncState?.lastSyncedEventId ?? null,
        syncState?.lastSyncedAt ?? null,
        config.projectId,
      );
      status.unsyncedRecords = unsyncedCount;
    } finally {
      closeDatabase(db);
    }
  } catch {
    status.unsyncedRecords = "unknown";
  }

  if (opts?.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log("Cloud Sync Status");
  console.log("==================");
  console.log();
  const effectiveServerUrl = cloudConfig.serverUrl ?? credentials?.serverUrl ?? null;
  console.log(`Server:       ${effectiveServerUrl ?? "(not configured)"}`);
  console.log(`Enabled:      ${cloudConfig.enabled ? "yes" : "no"}`);
  console.log(`Auto-sync:    ${cloudConfig.autoSync ? "yes" : "no"}`);
  console.log(`Logged in:    ${credentials ? "yes" : "no"}`);

  if (credentials) {
    const authType = credentials.authType ?? "device";
    console.log(`Auth type:    ${authType}`);
    console.log(`Client ID:    ${credentials.clientId}`);
    if (authType === "token") {
      console.log("Token:        static (never expires)");
    } else {
      console.log(
        `Token:        ${isTokenExpired(credentials) ? "expired" : "valid"}`,
      );
    }
  }

  // Server reachability
  if (status.serverOnline === true) {
    console.log(`Server:       \x1b[32monline\x1b[0m`);
  } else if (status.serverOnline === false) {
    console.log(`Server:       \x1b[31moffline\x1b[0m (${status.serverError})`);
  }

  const syncState = status.syncState as {
    lastSyncedEventId: string | null;
    lastSyncedAt: string | null;
    syncVersion: number;
  } | null;

  if (syncState) {
    console.log(
      `Last sync:    ${syncState.lastSyncedAt ?? "never"}`,
    );
    console.log(
      `Cursor:       ${syncState.lastSyncedEventId ?? "none"}`,
    );
    console.log(`Sync version: ${syncState.syncVersion}`);
  } else {
    console.log("Last sync:    never");
  }

  // Show remote cursor comparison when server is online
  const remoteStatus = status.remoteStatus as {
    lastSyncedEventId: string | null;
    syncVersion: number;
    lastSyncedAt: string | null;
    projectCursors?: Record<string, {
      lastSyncedEventId: string | null;
      lastSyncedAt: string | null;
    }>;
  } | undefined;
  if (remoteStatus) {
    const localCursor = syncState?.lastSyncedEventId ?? null;
    // Prefer per-project cursor when available
    const projectEntry = config.projectId
      ? remoteStatus.projectCursors?.[config.projectId]
      : undefined;
    const remoteCursor = projectEntry !== undefined
      ? projectEntry.lastSyncedEventId
      : remoteStatus.lastSyncedEventId;
    const cursorSource = projectEntry !== undefined ? "project" : "global";

    if (localCursor !== remoteCursor) {
      console.log(
        `Remote cursor: ${remoteCursor ?? "none"} (${cursorSource}, differs from local)`,
      );
    }
    if (projectEntry !== undefined) {
      console.log(`Project:      ${config.projectId}`);
    }
  }

  console.log(`Unsynced:     ${status.unsyncedRecords} records`);

  // Actionable hints
  if (status.serverOnline === false) {
    console.log();
    console.log(
      "The cloud server is not reachable. Auto-sync will resume when the server is back online.",
    );
    console.log("To retry manually: adit cloud sync");
  } else if (
    status.serverOnline === true &&
    typeof status.unsyncedRecords === "number" &&
    status.unsyncedRecords > 0
  ) {
    console.log();
    console.log(
      `${status.unsyncedRecords} records pending. Run 'adit cloud sync' to push now.`,
    );
  }
}

/**
 * `adit cloud auth-token <token>` — Authenticate with a static JWT token.
 *
 * Server URL: ADIT_CLOUD_URL env > DEFAULT_SERVER_URL.
 * If device-code (login) credentials already exist, rejects —
 * login credentials take priority.
 */
export async function cloudAuthTokenCommand(token: string): Promise<void> {
  const serverUrl = process.env.ADIT_CLOUD_URL ?? DEFAULT_SERVER_URL;
  const config = loadConfig();

  // If device (login) credentials already exist, warn but allow override
  const existingCredentials = loadCredentials();
  if (existingCredentials && existingCredentials.authType !== "token") {
    console.log(
      "Replacing existing login credentials with static token.",
    );
  }

  // Save credentials with local clientId initially
  const credentials = {
    authType: "token" as const,
    accessToken: token,
    refreshToken: "",
    clientId: config.clientId,
    expiresAt: "",
    serverUrl,
  };
  saveCredentials(credentials);

  // Verify token against the server and retrieve server-assigned clientId
  try {
    const client = new CloudClient(serverUrl, credentials);
    const status = await client.get<{ clientId: string }>(
      "/api/sync/status",
    );
    if (status.clientId && status.clientId !== config.clientId) {
      // Update with server-assigned clientId
      saveCredentials({ ...credentials, clientId: status.clientId });
      console.log("Token verified successfully.");
      console.log(`Server:    ${serverUrl}`);
      console.log(`Client ID: ${status.clientId} (server-assigned)`);
    } else {
      console.log("Token verified successfully.");
      console.log(`Server:    ${serverUrl}`);
      console.log(`Client ID: ${config.clientId}`);
    }
  } catch (error) {
    // Token saved but verification failed — still usable, warn user
    if (error instanceof CloudAuthError) {
      console.warn(
        `Warning: Token verification failed (${error.message}). The token may be invalid.`,
      );
    } else if (error instanceof CloudNetworkError) {
      console.warn(
        `Warning: Could not reach ${serverUrl} to verify token. Token saved anyway.`,
      );
    } else {
      console.warn(
        `Warning: Token verification failed. Token saved anyway.`,
      );
    }
    console.log(`Server:    ${serverUrl}`);
    console.log(`Client ID: ${config.clientId}`);
  }

  // Reset any error state from previous sync failures
  clearSyncErrors();

  console.log("Credentials saved to ~/.adit/cloud-credentials.json");
}

/**
 * `adit cloud reset-credentials` — Force-clear all credentials and sync state.
 *
 * Unlike logout, this does not attempt to revoke the token on the server.
 * It simply wipes all local credential and sync state, allowing the client
 * to connect to any cloud server again.
 */
export async function cloudResetCredentialsCommand(opts?: {
  yes?: boolean;
}): Promise<void> {
  const credentials = loadCredentials();

  if (!credentials) {
    console.log("No credentials stored. Nothing to reset.");
    return;
  }

  if (!opts?.yes) {
    console.log(
      `This will remove all stored credentials for ${credentials.serverUrl}.`,
    );
    console.log("Local sync state will also be cleared.");
    console.log(
      "You will need to run 'adit cloud login' to reconnect to any server.",
    );
    console.log();
    console.log("Run with --yes to confirm.");
    process.exitCode = 1;
    return;
  }

  // Clear local sync state
  const config = loadConfig();
  try {
    const db = openDatabase(config.dbPath);
    try {
      const { clearSyncState } = await import("@adit/core");
      clearSyncState(db, credentials.serverUrl);
    } finally {
      closeDatabase(db);
    }
  } catch {
    // Database may not exist yet
  }

  clearCredentials();
  console.log("Credentials and sync state cleared.");
  console.log("You can now connect to any cloud server with 'adit cloud login'.");
}
