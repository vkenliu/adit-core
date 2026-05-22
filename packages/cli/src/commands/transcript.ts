/**
 * `adit transcript` — Transcript upload management commands.
 *
 * Subcommands:
 *   enable   — Enable automatic transcript upload (default)
 *   disable  — Disable automatic transcript upload
 *   status   — Show transcript upload status
 *   upload   — Manually trigger transcript uploads
 *   reset    — Reset a failed transcript for re-upload
 */

import { loadConfig, openDatabase, closeDatabase } from "@varveai/adit-core";
import {
  loadCloudConfig,
  loadCredentials,
  isTokenExpired,
  CloudClient,
  CloudAuthError,
  CloudNetworkError,
  processTranscriptUploads,
} from "@varveai/adit-cloud";
import type { TranscriptUpload } from "@varveai/adit-core";

/**
 * `adit transcript enable` — Enable transcript upload.
 *
 * Sets the ADIT_TRANSCRIPT_UPLOAD env hint and prints guidance.
 * The actual toggle is environment-based (ADIT_TRANSCRIPT_UPLOAD).
 */
export async function transcriptEnableCommand(): Promise<void> {
  console.log("Transcript upload is enabled by default.");
  console.log();
  console.log("To disable, set the environment variable:");
  console.log("  export ADIT_TRANSCRIPT_UPLOAD=false");
  console.log();
  console.log("To re-enable after disabling:");
  console.log("  unset ADIT_TRANSCRIPT_UPLOAD");
  console.log("  # or: export ADIT_TRANSCRIPT_UPLOAD=true");
  console.log();
  console.log("Current status:");
  const config = loadCloudConfig();
  console.log(
    `  Transcript upload: ${config.transcriptUpload.enabled ? "enabled" : "disabled"}`,
  );
  console.log(
    `  Poll interval:     ${config.transcriptUpload.pollIntervalSec}s`,
  );
  console.log(
    `  Max concurrent:    ${config.transcriptUpload.maxConcurrent}`,
  );
  console.log(
    `  Max retries:       ${config.transcriptUpload.maxRetries}`,
  );
  console.log(
    `  Min increment:     ${config.transcriptUpload.minIncrementBytes} bytes`,
  );
}

/**
 * `adit transcript disable` — Disable transcript upload.
 */
export async function transcriptDisableCommand(): Promise<void> {
  console.log("To disable transcript upload, set this environment variable:");
  console.log("  export ADIT_TRANSCRIPT_UPLOAD=false");
  console.log();
  console.log(
    "Add it to your shell profile (~/.bashrc, ~/.zshrc) for persistence.",
  );
  console.log();
  const config = loadCloudConfig();
  console.log(
    `Current status: ${config.transcriptUpload.enabled ? "enabled" : "disabled"}`,
  );
}

/**
 * `adit transcript status` — Show transcript upload state.
 */
export async function transcriptStatusCommand(opts?: {
  json?: boolean;
}): Promise<void> {
  const cloudConfig = loadCloudConfig();
  const credentials = loadCredentials();
  const config = loadConfig();

  const statusData: Record<string, unknown> = {
    uploadEnabled: cloudConfig.transcriptUpload.enabled,
    serverUrl: cloudConfig.serverUrl,
    loggedIn: credentials !== null,
    config: {
      pollIntervalSec: cloudConfig.transcriptUpload.pollIntervalSec,
      maxConcurrent: cloudConfig.transcriptUpload.maxConcurrent,
      maxRetries: cloudConfig.transcriptUpload.maxRetries,
      minIncrementBytes: cloudConfig.transcriptUpload.minIncrementBytes,
    },
  };

  // Get transcript upload records from database
  let transcripts: TranscriptUpload[] = [];
  try {
    const db = openDatabase(config.dbPath);
    try {
      const { listPendingTranscriptUploads } = await import("@varveai/adit-core");
      const serverUrl =
        cloudConfig.serverUrl ?? credentials?.serverUrl ?? "";
      if (serverUrl) {
        transcripts = listPendingTranscriptUploads(db, serverUrl);
      }

      // Also get failed ones for status display
      const allTranscripts = db
        .prepare(
          `SELECT * FROM transcript_uploads
           WHERE server_url = ?
           ORDER BY updated_at DESC
           LIMIT 50`,
        )
        .all(serverUrl) as Array<Record<string, unknown>>;

      statusData.transcripts = allTranscripts.map((t) => ({
        id: (t.id as string).substring(0, 10) + "...",
        path: t.transcript_path,
        status: t.status,
        uploadedBytes: t.uploaded_bytes,
        fileSizeBytes: t.file_size_bytes,
        failureCount: t.failure_count,
        lastError: t.last_error,
        updatedAt: t.updated_at,
      }));
      statusData.totalTracked = allTranscripts.length;
      statusData.pendingCount = transcripts.length;
    } finally {
      closeDatabase(db);
    }
  } catch {
    statusData.transcripts = [];
    statusData.totalTracked = 0;
    statusData.pendingCount = 0;
  }

  if (opts?.json) {
    console.log(JSON.stringify(statusData, null, 2));
    return;
  }

  console.log("Transcript Upload Status");
  console.log("========================");
  console.log();
  console.log(
    `Upload:       ${cloudConfig.transcriptUpload.enabled ? "enabled" : "disabled"}`,
  );
  console.log(
    `Server:       ${cloudConfig.serverUrl ?? "(not configured)"}`,
  );
  console.log(`Logged in:    ${credentials ? "yes" : "no"}`);

  if (credentials) {
    console.log(
      `Token:        ${isTokenExpired(credentials) ? "expired" : "valid"}`,
    );
  }

  console.log();
  console.log(
    `Tracked transcripts: ${statusData.totalTracked}`,
  );
  console.log(
    `Pending uploads:     ${statusData.pendingCount}`,
  );

  const allTranscripts = statusData.transcripts as Array<{
    id: string;
    path: string;
    status: string;
    uploadedBytes: number;
    fileSizeBytes: number;
    failureCount: number;
    lastError: string | null;
    updatedAt: string;
  }>;

  if (allTranscripts.length > 0) {
    console.log();
    console.log("Transcripts:");
    for (const t of allTranscripts) {
      const progress =
        t.fileSizeBytes > 0
          ? `${Math.round((t.uploadedBytes / t.fileSizeBytes) * 100)}%`
          : "0%";
      const statusIcon =
        t.status === "up_to_date"
          ? "OK"
          : t.status === "failed"
            ? "FAIL"
            : t.status === "uploading"
              ? "..."
              : "PEND";
      console.log(
        `  [${statusIcon}] ${t.path} (${progress}, ${formatBytes(t.uploadedBytes)}/${formatBytes(t.fileSizeBytes)})`,
      );
      if (t.lastError) {
        console.log(`         Error: ${t.lastError}`);
      }
    }
  }
}

/**
 * `adit transcript upload` — Manually trigger transcript uploads.
 */
export async function transcriptUploadCommand(opts?: {
  json?: boolean;
}): Promise<void> {
  const cloudConfig = loadCloudConfig();
  const credentials = loadCredentials();

  if (!cloudConfig.transcriptUpload.enabled) {
    const msg =
      "Transcript upload is disabled. Set ADIT_TRANSCRIPT_UPLOAD=true to enable.";
    if (opts?.json) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  if (!credentials) {
    const msg = "Not logged in. Run 'adit cloud login' first.";
    if (opts?.json) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl;
  const config = loadConfig();

  if (!opts?.json) {
    console.log(`Uploading transcripts to ${serverUrl}...`);
  }

  const db = openDatabase(config.dbPath);
  try {
    const client = new CloudClient(serverUrl, credentials);
    const result = await processTranscriptUploads({
      db,
      client,
      config: cloudConfig.transcriptUpload,
      serverUrl,
    });

    if (opts?.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.processed === 0) {
        console.log("No transcripts to upload.");
      } else {
        console.log(
          `Upload complete: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.failed} failed, ${result.resynced} resynced`,
        );
      }
    }
  } catch (error) {
    const msg =
      error instanceof CloudAuthError
        ? `Authentication failed: ${error.message}`
        : error instanceof CloudNetworkError
          ? `Network error: ${error.message}`
          : `Upload failed: ${error instanceof Error ? error.message : String(error)}`;

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
 * `adit transcript reset <id>` — Reset a failed transcript for re-upload.
 */
export async function transcriptResetCommand(
  id: string,
  opts?: { json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  try {
    const { getTranscriptUploadById, resetTranscriptUpload } = await import(
      "@varveai/adit-core"
    );

    // Try to find by ID prefix
    const upload = getTranscriptUploadById(db, id);
    if (!upload) {
      // Try to find by path
      const cloudConfig = loadCloudConfig();
      const credentials = loadCredentials();
      const serverUrl =
        cloudConfig.serverUrl ?? credentials?.serverUrl ?? "";
      const { getTranscriptUpload } = await import("@varveai/adit-core");
      const byPath = getTranscriptUpload(db, id, serverUrl);

      if (!byPath) {
        const msg = `Transcript not found: ${id}`;
        if (opts?.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      resetTranscriptUpload(db, byPath.id);
      if (opts?.json) {
        console.log(JSON.stringify({ reset: true, id: byPath.id }));
      } else {
        console.log(`Reset transcript upload: ${byPath.transcriptPath}`);
        console.log(
          "It will be re-uploaded from the beginning on the next upload cycle.",
        );
      }
      return;
    }

    resetTranscriptUpload(db, upload.id);
    if (opts?.json) {
      console.log(JSON.stringify({ reset: true, id: upload.id }));
    } else {
      console.log(`Reset transcript upload: ${upload.transcriptPath}`);
      console.log(
        "It will be re-uploaded from the beginning on the next upload cycle.",
      );
    }
  } finally {
    closeDatabase(db);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
