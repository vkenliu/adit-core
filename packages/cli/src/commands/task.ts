/**
 * CLI handlers for `adit cloud task`.
 *
 * Implements the task status update command for updating
 * task statuses in an intent using the /api/task-slices/bulk endpoint.
 */

import { loadConfig } from "@varveai/adit-core";
import {
  loadCloudConfig,
  loadCredentials,
  CloudClient,
  bulkTaskUpdateCommand,
  type BulkTaskUpdateOptions,
} from "@varveai/adit-cloud";
import { CloudAuthError, CloudNetworkError, CloudApiError } from "@varveai/adit-cloud";

/**
 * `adit cloud task` — Update task statuses in an intent.
 */
export async function taskCliHandler(intentId: string, opts: {
  status?: string;
  taskId?: string[];
  phase?: number;
  featureTag?: string;
  wave?: number;
  json?: boolean;
}): Promise<void> {
  const config = loadConfig();

  // Prerequisite: credentials
  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not logged in to adit-cloud.");
    console.error("Run 'adit cloud login' to authenticate, or 'adit cloud auth-token <token>' for token auth.");
    process.exitCode = 1;
    return;
  }

  if (credentials.authType !== "token" && credentials.authType !== undefined) {
    // CloudClient will attempt auto-refresh — just warn
    console.log("Token expired — will attempt auto-refresh...");
  }

  // Resolve server URL and project ID
  const cloudConfig = loadCloudConfig();
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl ?? "https://adit.cloud";
  const projectId = config.projectId;

  if (!projectId) {
    console.error("No project ID configured. Run 'adit init' first.");
    process.exitCode = 1;
    return;
  }

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

  // Prepare options
  const options: BulkTaskUpdateOptions = {
    intentId,
    status: opts.status as any,
    taskId: opts.taskId,
    json: opts.json,
  };

  // Add filters if provided
  if (opts.phase !== undefined || opts.featureTag !== undefined || opts.wave !== undefined) {
    options.filters = {
      phase: opts.phase,
      featureTag: opts.featureTag,
      wave: opts.wave,
    };
  }

  // Execute the command
  try {
    const result = await bulkTaskUpdateCommand(client, projectId, options);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);

      if (result.failed.length > 0) {
        console.error("\nFailed tasks:");
        result.failed.forEach((failed: { taskId: string; error: string }) => {
          console.error(`  ${failed.taskId}: ${failed.error}`);
        });
      }
    }
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) {
      console.error("Intent not found or access denied. Check the intent ID and your permissions.");
    } else if (error instanceof CloudApiError) {
      if (error.status === 302 ||
          (typeof error.body === "string" && error.body.includes("/auth/signin"))) {
        console.error("Authentication required. The server is redirecting to the login page.");
        console.error("\nPlease try one of the following:");
        console.error("1. Run 'adit cloud login' to authenticate with device code");
        console.error("2. Set ADIT_AUTH_TOKEN environment variable with a valid token");
        console.error("3. Check if your authentication has expired");
      } else {
        console.error(`Server error: ${error.status} — ${error.message}`);
        if (error.body) {
          const bodyStr = typeof error.body === "string"
            ? error.body
            : JSON.stringify(error.body, null, 2);
          console.error(`  Response: ${bodyStr}`);
        }
      }
    } else if (error instanceof CloudNetworkError) {
      if (error.message.includes("redirect") || error.message.includes("Too many redirects")) {
        console.error("Authentication redirect detected. The server is redirecting requests.");
        console.error("\nPlease try one of the following:");
        console.error("1. Run 'adit cloud login' to authenticate with device code");
        console.error("2. Set ADIT_AUTH_TOKEN environment variable with a valid token");
        console.error("3. Check if your authentication has expired");
      } else {
        console.error(`Network error: ${error.message}`);
      }
    } else if (error instanceof CloudAuthError) {
      console.error(`Authentication failed: ${error.message}`);
      console.error("Run 'adit cloud login' to re-authenticate.");
    } else {
      console.error(`Task update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}