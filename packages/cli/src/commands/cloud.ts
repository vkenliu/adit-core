/**
 * `adit cloud` — Cloud sync commands.
 *
 * Subcommands:
 *   login   — Authenticate via device code flow
 *   logout  — Clear stored credentials
 *   sync    — Push unsynced records to cloud
 *   status  — Show sync state and unsynced count
 *   upload  — Upload Claude Code chat history to cloud
 */

import {
  loadConfig,
  openDatabase,
  closeDatabase,
  generateIdAt,
  createClock,
  serialize,
  insertSession,
  insertEvent,
  endSession,
  allocateSequence,
} from "@adit/core";
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
} from "@adit/cloud";
import type { DeviceAuthOptions } from "@adit/cloud";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { createInterface } from "node:readline";

/** Database handle type (avoids direct better-sqlite3 dependency) */
type AditDatabase = ReturnType<typeof openDatabase>;
import {
  discoverProjects,
  discoverSessions,
  findCurrentProject,
  parseChatHistoryFile,
} from "../chat-history/index.js";
import type {
  ClaudeProject,
  ClaudeSession,
  ChatHistoryMessage,
} from "../chat-history/index.js";

const DEFAULT_SERVER_URL = "https://adit-cloud.varve.ai";

/**
 * `adit cloud login` — Interactive device authorization flow.
 */
export async function cloudLoginCommand(opts?: {
  server?: string;
}): Promise<void> {
  const serverUrl = opts?.server ?? process.env.ADIT_CLOUD_URL ?? DEFAULT_SERVER_URL;
  const config = loadConfig();

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
    aditVersion: "0.2.0",
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

  const status: Record<string, unknown> = {
    serverUrl: cloudConfig.serverUrl,
    enabled: cloudConfig.enabled,
    autoSync: cloudConfig.autoSync,
    loggedIn: credentials !== null,
  };

  if (credentials) {
    status.clientId = credentials.clientId;
    status.tokenExpired = isTokenExpired(credentials);
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
  console.log(`Server:       ${cloudConfig.serverUrl ?? "(not configured)"}`);
  console.log(`Enabled:      ${cloudConfig.enabled ? "yes" : "no"}`);
  console.log(`Auto-sync:    ${cloudConfig.autoSync ? "yes" : "no"}`);
  console.log(`Logged in:    ${credentials ? "yes" : "no"}`);

  if (credentials) {
    console.log(`Client ID:    ${credentials.clientId}`);
    console.log(
      `Token:        ${isTokenExpired(credentials) ? "expired" : "valid"}`,
    );
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
      `Cursor:       ${syncState.lastSyncedEventId?.substring(0, 10) ?? "none"}...`,
    );
    console.log(`Sync version: ${syncState.syncVersion}`);
  } else {
    console.log("Last sync:    never");
  }

  console.log(`Unsynced:     ${status.unsyncedRecords} records`);
}

/* ------------------------------------------------------------------ */
/*  adit cloud upload                                                  */
/* ------------------------------------------------------------------ */

export interface CloudUploadOptions {
  session?: string;
  list?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

/**
 * `adit cloud upload` — Upload Claude Code chat history to cloud.
 *
 * Discovers Claude Code projects/sessions, parses JSONL files,
 * inserts them as ADIT events, and syncs to cloud.
 */
export async function cloudUploadCommand(
  opts: CloudUploadOptions = {},
): Promise<void> {
  // --list mode: just show discovered projects/sessions
  if (opts.list) {
    return listProjectsAndSessions(opts);
  }

  // Require cloud login for actual upload (not for --list)
  const credentials = loadCredentials();
  if (!credentials && !opts.dryRun) {
    const msg = "Not logged in. Run 'adit cloud login' first.";
    if (opts.json) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  // Step 1: Discover Claude Code projects
  const cwd = process.cwd();
  let project = findCurrentProject(cwd);

  if (!project) {
    const projects = discoverProjects();
    if (projects.length === 0) {
      const msg = "No Claude Code projects found under ~/.claude/projects/";
      if (opts.json) {
        console.log(JSON.stringify({ error: msg }));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }

    // Interactive project selection
    if (opts.json) {
      console.log(
        JSON.stringify({
          error: `Could not determine project for ${cwd}. Use --list to see available projects.`,
        }),
      );
      process.exitCode = 1;
      return;
    }

    project = await promptProjectSelection(projects);
    if (!project) {
      console.log("Cancelled.");
      return;
    }
  }

  // Step 2: Discover sessions for the project
  let sessions = discoverSessions(project.projectDir);

  if (opts.session) {
    sessions = sessions.filter((s) => s.id === opts.session);
    if (sessions.length === 0) {
      const msg = `Session not found: ${opts.session}`;
      if (opts.json) {
        console.log(JSON.stringify({ error: msg }));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }
  }

  if (sessions.length === 0) {
    const msg = `No sessions found for project: ${project.realPath}`;
    if (opts.json) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.log(msg);
    }
    return;
  }

  if (!opts.json && !opts.dryRun) {
    console.log(`Project: ${project.realPath}`);
    console.log(`Sessions to upload: ${sessions.length}`);
    console.log();
  }

  // Step 3: Parse and import each session
  const config = loadConfig();
  const results: SessionUploadResult[] = [];

  const db = opts.dryRun ? null : openDatabase(config.dbPath);

  try {
    for (const session of sessions) {
      const result = importSession(
        session,
        config.projectId,
        config.clientId,
        db,
        opts.dryRun ?? false,
      );
      results.push(result);

      if (!opts.json && !opts.dryRun) {
        console.log(
          `  ${session.id.substring(0, 8)}... → ${result.eventsCreated} events`,
        );
      }
    }

    // Step 4: Sync to cloud (unless dry-run)
    if (!opts.dryRun && credentials && db) {
      const cloudConfig = loadCloudConfig();
      const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl;

      if (!opts.json) {
        console.log();
        console.log(`Syncing with ${serverUrl}...`);
      }

      try {
        const client = new CloudClient(serverUrl, credentials);
        const engine = new SyncEngine(db, client, {
          projectId: config.projectId,
          batchSize: cloudConfig.batchSize,
          serverUrl,
          cloudClientId: credentials.clientId,
        });

        const syncResult = await engine.sync();

        if (!opts.json) {
          console.log(
            `Sync complete: ${syncResult.accepted} accepted, ${syncResult.duplicates} duplicates`,
          );
        }
      } catch (error) {
        if (!opts.json) {
          console.error(
            `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          console.error(
            "Events were imported locally. Run 'adit cloud sync' to retry.",
          );
        }
      }
    }

    // Output summary
    const totalEvents = results.reduce((s, r) => s + r.eventsCreated, 0);
    const summary = {
      project: project.realPath,
      sessionsProcessed: results.length,
      totalEvents,
      dryRun: opts.dryRun ?? false,
      sessions: results,
    };

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else if (opts.dryRun) {
      console.log(`Dry run for project: ${project.realPath}`);
      console.log();
      for (const r of results) {
        console.log(
          `  ${r.sessionId.substring(0, 8)}... — ${r.eventsCreated} events (${r.promptSubmits} prompts, ${r.assistantResponses} responses, ${r.toolCalls} tool calls)`,
        );
      }
      console.log();
      console.log(
        `Total: ${results.length} sessions, ${totalEvents} events`,
      );
    } else {
      console.log();
      console.log(
        `Done: ${results.length} sessions, ${totalEvents} events uploaded.`,
      );
    }
  } finally {
    if (db) closeDatabase(db);
  }
}

/* ------------------------------------------------------------------ */
/*  Session import                                                     */
/* ------------------------------------------------------------------ */

interface SessionUploadResult {
  sessionId: string;
  aditSessionId: string;
  eventsCreated: number;
  promptSubmits: number;
  assistantResponses: number;
  toolCalls: number;
}

/**
 * Import a single Claude Code session into ADIT.
 *
 * Uses direct DB inserts (not the timeline manager) because we're
 * importing historical data and don't want to query current git state.
 */
function importSession(
  session: ClaudeSession,
  projectId: string,
  clientId: string,
  db: AditDatabase | null,
  dryRun: boolean,
): SessionUploadResult {
  const messages = parseChatHistoryFile(session.filePath);

  // Deduplicate: Claude Code emits multiple JSONL lines for the same
  // assistant turn as content blocks stream in. Keep only the last
  // occurrence of each uuid so we capture the most complete version.
  const deduped = deduplicateMessages(messages);

  const aditSessionId = generateIdAt(
    deduped.length > 0
      ? new Date(deduped[0].timestamp).getTime()
      : session.mtime.getTime(),
  );

  let promptSubmits = 0;
  let assistantResponses = 0;
  let toolCalls = 0;

  if (!dryRun && db) {
    const vclock = serialize(createClock(clientId));

    // Create the ADIT session
    insertSession(db, {
      id: aditSessionId,
      projectId,
      clientId,
      sessionType: "interactive",
      platform: "claude-code",
      startedAt:
        deduped.length > 0 ? deduped[0].timestamp : session.mtime.toISOString(),
      metadataJson: JSON.stringify({
        source: "claude-code-import",
        originalSessionId: session.id,
        importedAt: new Date().toISOString(),
      }),
      vclockJson: vclock,
    });

    // Map each message to ADIT event(s)
    let prevEventId: string | null = null;

    for (const msg of deduped) {
      const eventIds = insertMessageEvents(
        db,
        aditSessionId,
        clientId,
        msg,
        prevEventId,
      );

      for (const eid of eventIds) {
        prevEventId = eid.id;
        switch (eid.type) {
          case "prompt_submit":
            promptSubmits++;
            break;
          case "assistant_response":
            assistantResponses++;
            break;
          case "tool_call":
            toolCalls++;
            break;
        }
      }
    }

    // Close the session
    endSession(db, aditSessionId, "completed", vclock);
  } else {
    // Dry run: just count
    for (const msg of deduped) {
      if (msg.role === "user") {
        if (msg.toolResults.length > 0) {
          toolCalls += msg.toolResults.length;
        } else {
          promptSubmits++;
        }
      } else if (msg.role === "assistant") {
        if (msg.text || msg.thinkingText) {
          assistantResponses++;
        }
        toolCalls += msg.toolUses.length;
      }
    }
  }

  return {
    sessionId: session.id,
    aditSessionId,
    eventsCreated: promptSubmits + assistantResponses + toolCalls,
    promptSubmits,
    assistantResponses,
    toolCalls,
  };
}

/**
 * Deduplicate streamed messages — keep the last occurrence of each uuid.
 */
function deduplicateMessages(
  messages: ChatHistoryMessage[],
): ChatHistoryMessage[] {
  const byUuid = new Map<string, ChatHistoryMessage>();
  for (const msg of messages) {
    byUuid.set(msg.uuid, msg);
  }
  // Preserve original order using first-seen position
  const seen = new Set<string>();
  const result: ChatHistoryMessage[] = [];
  for (const msg of messages) {
    if (!seen.has(msg.uuid)) {
      seen.add(msg.uuid);
      result.push(byUuid.get(msg.uuid)!);
    }
  }
  return result;
}

interface InsertedEvent {
  id: string;
  type: "prompt_submit" | "assistant_response" | "tool_call";
}

/**
 * Insert ADIT events for a single parsed message.
 *
 * A user message becomes a `prompt_submit` event (or tool_call events
 * if it carries tool_result blocks).
 * An assistant message becomes an `assistant_response` event plus
 * separate `tool_call` events for each tool_use block.
 */
function insertMessageEvents(
  db: AditDatabase,
  sessionId: string,
  clientId: string,
  msg: ChatHistoryMessage,
  parentEventId: string | null,
): InsertedEvent[] {
  const vclock = serialize(createClock(clientId));
  const results: InsertedEvent[] = [];

  if (msg.role === "user") {
    if (msg.toolResults.length > 0) {
      // User message carrying tool results — create tool_call events
      for (const tr of msg.toolResults) {
        const id = generateIdAt(new Date(msg.timestamp).getTime());
        const seq = allocateSequence(db, sessionId);
        insertEvent(db, {
          id,
          sessionId,
          parentEventId,
          sequence: seq,
          eventType: "tool_call",
          actor: "tool",
          toolName: null,
          toolOutputJson: truncate(tr.content, 50_000),
          startedAt: msg.timestamp,
          endedAt: msg.timestamp,
          status: "success",
          vclockJson: vclock,
        });
        results.push({ id, type: "tool_call" });
        parentEventId = id;
      }
    } else {
      // Regular user prompt
      const id = generateIdAt(new Date(msg.timestamp).getTime());
      const seq = allocateSequence(db, sessionId);
      insertEvent(db, {
        id,
        sessionId,
        parentEventId,
        sequence: seq,
        eventType: "prompt_submit",
        actor: "user",
        promptText: truncate(msg.text, 100_000),
        startedAt: msg.timestamp,
        endedAt: msg.timestamp,
        status: "success",
        vclockJson: vclock,
      });
      results.push({ id, type: "prompt_submit" });
    }
  } else if (msg.role === "assistant") {
    // Assistant text/thinking → assistant_response
    if (msg.text || msg.thinkingText) {
      const id = generateIdAt(new Date(msg.timestamp).getTime());
      const seq = allocateSequence(db, sessionId);
      insertEvent(db, {
        id,
        sessionId,
        parentEventId,
        sequence: seq,
        eventType: "assistant_response",
        actor: "assistant",
        responseText: truncate(msg.text, 100_000),
        cotText: truncate(msg.thinkingText, 100_000),
        startedAt: msg.timestamp,
        endedAt: msg.timestamp,
        status: "success",
        vclockJson: vclock,
      });
      results.push({ id, type: "assistant_response" });
      parentEventId = id;
    }

    // Tool uses → tool_call events
    for (const tu of msg.toolUses) {
      const id = generateIdAt(new Date(msg.timestamp).getTime());
      const seq = allocateSequence(db, sessionId);
      insertEvent(db, {
        id,
        sessionId,
        parentEventId,
        sequence: seq,
        eventType: "tool_call",
        actor: "tool",
        toolName: tu.toolName,
        toolInputJson: truncate(JSON.stringify(tu.input), 50_000),
        startedAt: msg.timestamp,
        endedAt: msg.timestamp,
        status: "success",
        vclockJson: vclock,
      });
      results.push({ id, type: "tool_call" });
      parentEventId = id;
    }
  }

  return results;
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.substring(0, max) + "…[truncated]" : s;
}

/* ------------------------------------------------------------------ */
/*  --list mode                                                        */
/* ------------------------------------------------------------------ */

async function listProjectsAndSessions(
  opts: CloudUploadOptions,
): Promise<void> {
  const projects = discoverProjects();

  if (projects.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ projects: [] }));
    } else {
      console.log("No Claude Code projects found under ~/.claude/projects/");
    }
    return;
  }

  if (opts.json) {
    const data = projects.map((p) => ({
      dirName: p.dirName,
      realPath: p.realPath,
      sessions: discoverSessions(p.projectDir).map((s) => ({
        id: s.id,
        mtime: s.mtime.toISOString(),
        sizeBytes: s.sizeBytes,
        hasSubdir: s.hasSubdir,
      })),
    }));
    console.log(JSON.stringify({ projects: data }, null, 2));
    return;
  }

  const cwd = process.cwd();
  const currentProject = findCurrentProject(cwd);

  console.log("Claude Code Projects");
  console.log("====================");
  console.log();

  for (const project of projects) {
    const isCurrent = currentProject?.dirName === project.dirName;
    const marker = isCurrent ? " ← current" : "";
    console.log(`${project.realPath}${marker}`);

    const sessions = discoverSessions(project.projectDir);
    if (sessions.length === 0) {
      console.log("  (no sessions)");
    } else {
      for (const session of sessions.slice(0, 5)) {
        const date = session.mtime.toISOString().split("T")[0];
        const sizeKb = Math.round(session.sizeBytes / 1024);
        console.log(
          `  ${session.id.substring(0, 8)}...  ${date}  ${sizeKb}KB`,
        );
      }
      if (sessions.length > 5) {
        console.log(`  ... and ${sessions.length - 5} more`);
      }
    }
    console.log();
  }
}

/* ------------------------------------------------------------------ */
/*  Interactive project selection                                      */
/* ------------------------------------------------------------------ */

async function promptProjectSelection(
  projects: ClaudeProject[],
): Promise<ClaudeProject | null> {
  console.log(
    "Could not determine project from current directory. Select a project:",
  );
  console.log();

  for (let i = 0; i < projects.length; i++) {
    const sessions = discoverSessions(projects[i].projectDir);
    console.log(`  ${i + 1}) ${projects[i].realPath} (${sessions.length} sessions)`);
  }
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Enter number (or q to cancel): ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "q" || trimmed === "") {
        resolve(null);
        return;
      }
      const idx = parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < projects.length) {
        resolve(projects[idx]);
      } else {
        console.error("Invalid selection.");
        resolve(null);
      }
    });
  });
}
