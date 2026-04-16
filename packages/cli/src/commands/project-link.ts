/**
 * CLI handlers for `adit cloud project link` and `adit cloud project intent`.
 *
 * These wire up the config/credentials/database lifecycle around the
 * command handlers from @varveai/adit-cloud/project-link.
 */

import { loadConfig, openDatabase, closeDatabase } from "@varveai/adit-core";
import {
  loadCloudConfig,
  loadCredentials,
  isTokenExpired,
  CloudClient,
  CloudAuthError,
  CloudNetworkError,
  CloudApiError,
  linkCommand,
  intentCommand,
  formatIntentList,
  formatIntentDetail,
  DEFAULT_SERVER_URL,
} from "@varveai/adit-cloud";
import type { LinkOptions, IntentOptions } from "@varveai/adit-cloud";
import { isGitRepo } from "@varveai/adit-engine";

/**
 * `adit cloud project link` — Link this project to adit-cloud.
 */
export async function projectLinkCliHandler(opts: LinkOptions): Promise<void> {
  const config = loadConfig();

  // Prerequisite: git repo
  if (!(await isGitRepo(config.projectRoot))) {
    console.error("Not a git repository. Run this from within a git project.");
    process.exitCode = 1;
    return;
  }

  // Prerequisite: credentials
  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not logged in to adit-cloud.");
    console.error("Run 'adit cloud login' to authenticate, or 'adit cloud auth-token <token>' for token auth.");
    process.exitCode = 1;
    return;
  }

  if (isTokenExpired(credentials) && credentials.authType !== "token") {
    // CloudClient will attempt auto-refresh — just warn
    console.log("Token expired — will attempt auto-refresh...");
  }

  // Resolve server URL
  const cloudConfig = loadCloudConfig();
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;

  // Verify connectivity
  const client = new CloudClient(serverUrl, credentials);
  try {
    await client.get("/api/sync/health");
  } catch (error) {
    if (error instanceof CloudNetworkError) {
      console.error(`Cannot reach adit-cloud at ${serverUrl}. Check your network connection.`);
    } else if (error instanceof CloudAuthError) {
      console.error(`Authentication failed: ${error.message}`);
      console.error("Run 'adit cloud login' to re-authenticate.");
    } else {
      console.error(`Connection check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
    return;
  }

  // Suppress non-JSON output in JSON mode
  if (!opts.json) {
    console.log(`Authenticated on ${serverUrl}`);
  }

  // Open database and run the link flow
  const db = openDatabase(config.dbPath);
  try {
    const result = await linkCommand(db, client, config.projectRoot, config.projectId, serverUrl, opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    if (error instanceof CloudApiError) {
      console.error(`\nServer error: ${error.status} — ${error.message}`);
      if (error.body) {
        const bodyStr = typeof error.body === "string"
          ? error.body
          : JSON.stringify(error.body, null, 2);
        console.error(`  Response: ${bodyStr}`);
      }
    } else if (error instanceof CloudNetworkError) {
      console.error(`\nNetwork error: ${error.message}`);
    } else if (error instanceof CloudAuthError) {
      console.error(`\nAuthentication failed: ${error.message}`);
      console.error("Run 'adit cloud login' to re-authenticate.");
    } else {
      console.error(`\nLink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

/**
 * `adit cloud project intent` — List or show intents from connected project.
 */
export async function projectIntentCliHandler(opts: IntentOptions): Promise<void> {
  const config = loadConfig();

  // Prerequisite: credentials
  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not logged in to adit-cloud. Run 'adit cloud login' to authenticate.");
    process.exitCode = 1;
    return;
  }

  // Resolve server URL and project ID
  const cloudConfig = loadCloudConfig();
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;
  const client = new CloudClient(serverUrl, credentials);

  // Check for cached confirmed project ID
  const db = openDatabase(config.dbPath);
  try {
    const { getProjectLinkCache } = await import("@varveai/adit-cloud");
    const cache = getProjectLinkCache(db, config.projectId, serverUrl);
    const projectId = cache?.confirmedProjectId ?? config.projectId;

    const result = await intentCommand(client, projectId, opts);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.intent) {
      console.log(formatIntentDetail(result.intent));
    } else if (result.intents) {
      console.log(formatIntentList(result.intents));
    }
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) {
      console.error("No project link found. Run 'adit cloud project link' first.");
    } else if (error instanceof CloudApiError) {
      console.error(`Server error: ${error.status} — ${error.message}`);
    } else {
      console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}
