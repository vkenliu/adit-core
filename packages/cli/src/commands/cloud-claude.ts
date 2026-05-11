import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig, findGitRoot } from "@varveai/adit-core";
import {
  CloudApiError,
  CloudAuthError,
  CloudClient,
  CloudNetworkError,
  DEFAULT_SERVER_URL,
  loadCloudConfig,
  loadCredentials,
} from "@varveai/adit-cloud";
import { ClaudeCodeProvider } from "./cli-agent/claude-code-provider.js";
import { ClaudeTranscriptSync } from "./cli-agent/claude-transcript-sync.js";
import { installClaudeHooks, type InstalledHooks } from "./cli-agent/hooks-bootstrap.js";
import { startCliAgentHookServer, type HookServer } from "./cli-agent/hook-server.js";
import { CliAgentRelayWebSocket } from "./cli-agent/relay-client.js";
import type { CliAgentRelayEvent, RelayCommand } from "./cli-agent/types.js";

interface CloudClaudeOptions {
  bin?: string;
  arg?: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findExecutable(command: string): boolean {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    Array.isArray(item)
      ? item.filter((answer): answer is string => typeof answer === "string")
      : [],
  );
}

function readHookModel(body: Record<string, unknown>): string | null {
  const env = body.env && typeof body.env === "object" && !Array.isArray(body.env)
    ? body.env as Record<string, unknown>
    : {};
  return (
    readString(body.model) ??
    readString(body.activeModelId) ??
    readString(env.ANTHROPIC_MODEL)
  );
}

function printCloudError(prefix: string, error: unknown): void {
  if (error instanceof CloudAuthError) {
    console.error(`${prefix}: authentication failed. Run 'adit cloud login' again.`);
    console.error(error.message);
  } else if (error instanceof CloudNetworkError) {
    console.error(`${prefix}: cannot reach adit-cloud.`);
    console.error(error.message);
  } else if (error instanceof CloudApiError) {
    console.error(`${prefix}: cloud API error (${error.status}).`);
    console.error(error.message);
  } else {
    console.error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function processCommand(
  provider: ClaudeCodeProvider,
  command: RelayCommand,
): Promise<void> {
  if (command.type === "takeover") {
    await provider.takeover();
    return;
  }

  if (command.type === "switch-session") {
    const sessionId = readString(command.payload.sessionId);
    if (!sessionId) return;
    await provider.switchSession(sessionId);
    return;
  }

  if (command.type === "prompt") {
    const text = readString(command.payload.text);
    if (!text) return;
    const sessionId = readString(command.payload.sessionId);
    const pendingSessionId = readString(command.payload.pendingSessionId);
    const mode = readString(command.payload.mode) === "plan" ? "plan" : "build";
    if (!pendingSessionId && sessionId && provider.state.activeSessionId !== sessionId) {
      await provider.switchSession(sessionId);
    }
    await provider.sendPrompt(text, { mode, pendingSessionId });
    return;
  }

  if (command.type === "abort") {
    await provider.abort();
    return;
  }

  if (command.type === "permission") {
    const id = readString(command.payload.id);
    const response = readString(command.payload.response);
    if (!id) return;
    await provider.answerPermission(
      id,
      response !== "reject",
      response === "reject" ? "Rejected from adit-cloud." : undefined,
    );
    return;
  }

  if (command.type === "question") {
    const id = readString(command.payload.id);
    if (!id) return;
    await provider.answerQuestion({
      id,
      answers: readStringMatrix(command.payload.answers),
      rejected: command.payload.rejected === true,
    });
  }
}

function enqueueCommand(input: {
  queue: RelayCommand[];
  seen: Set<string>;
  command: RelayCommand;
}): void {
  if (input.seen.has(input.command.id)) return;
  input.seen.add(input.command.id);
  input.queue.push(input.command);
  if (input.seen.size > 500) {
    const keep = new Set(input.queue.map((command) => command.id));
    for (const id of input.seen) {
      if (!keep.has(id) && input.seen.size > 250) input.seen.delete(id);
    }
  }
}

async function drainCommandQueue(input: {
  provider: ClaudeCodeProvider;
  commands: RelayCommand[];
  eventQueue: CliAgentRelayEvent[];
  ws: CliAgentRelayWebSocket | null;
}): Promise<void> {
  while (input.commands.length > 0) {
    const command = input.commands.shift();
    if (!command) return;
    try {
      await processCommand(input.provider, command);
      input.ws?.ack(command.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.ws?.commandError(command.id, message);
      input.eventQueue.push({
        type: "error",
        payload: {
          message,
          commandId: command.id,
          createdAt: Date.now(),
        },
      });
    }
  }
}

export async function cloudClaudeCommand(opts?: CloudClaudeOptions): Promise<void> {
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) {
    console.error("Not inside a git project. Run this from the project you want to connect.");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(gitRoot);
  const credentials = loadCredentials();
  if (!credentials) {
    console.error("Not logged in. Run 'adit cloud login' first.");
    process.exitCode = 1;
    return;
  }

  const claudeBin = opts?.bin ?? "claude";
  if (!findExecutable(claudeBin)) {
    console.error(`Claude Code CLI not found: ${claudeBin}`);
    console.error("Install Claude Code and make sure 'claude' is available on PATH.");
    process.exitCode = 1;
    return;
  }

  const cloudConfig = loadCloudConfig();
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;
  const client = new CloudClient(serverUrl, credentials);
  const terminalId = randomUUID();
  const projectName = basename(config.projectRoot);
  const panelName = projectName;

  try {
    await client.get("/api/sync/status");
  } catch (error) {
    printCloudError("Unable to verify cloud login", error);
    process.exitCode = 1;
    return;
  }

  let hookServer: HookServer | null = null;
  let installedHooks: InstalledHooks | null = null;
  let provider: ClaudeCodeProvider | null = null;
  const eventQueue: CliAgentRelayEvent[] = [];
  const commandQueue: RelayCommand[] = [];
  const seenCommandIds = new Set<string>();
  const transcriptSync = new ClaudeTranscriptSync();

  try {
    hookServer = await startCliAgentHookServer();
    const hookSettingsPath = join(
      config.projectRoot,
      ".claude",
      `adit-cloud-${terminalId}.settings.local.json`,
    );
    installedHooks = installClaudeHooks({
      cwd: config.projectRoot,
      endpoint: hookServer.endpoint,
      marker: `from=adit-cloud-cli-${hookServer.port}`,
      settingsPath: hookSettingsPath,
    });

    provider = new ClaudeCodeProvider({
      bin: claudeBin,
      args: opts?.arg ?? [],
      cwd: config.projectRoot,
      hookSettingsPath: installedHooks.settingsPath,
      onEvent: (event) => eventQueue.push(event),
    });

    const ws = new CliAgentRelayWebSocket({
      serverUrl,
      accessToken: client.getCredentials().accessToken,
      register: {
        provider: "claude-code",
        terminalId,
        projectRoot: config.projectRoot,
        projectId: config.projectId,
        projectName,
        panelName,
      },
      onHello: (info) => {
        console.log(`Connected ${config.projectRoot} to adit-cloud Coding.`);
        console.log(`Terminal: ${terminalId}`);
        console.log(`Connection: ${info.connectionId}`);
        if (info.panelId) console.log(`Panel: ${info.panelName ?? panelName} (${info.panelId})`);
        console.log("Local Claude Code owns the session until the Coding page takes over.");
        console.log("When Web owns the session, type /local in this terminal to reclaim it.");
      },
      onCommand: (command) => enqueueCommand({
        queue: commandQueue,
        seen: seenCommandIds,
        command,
      }),
      onConnectionClosed: () => {
        // Server archived our panel; reconnect will get a fresh one.
      },
      onError: (error) => {
        printCloudError("[adit cloud claude] websocket relay", error);
      },
    });

    hookServer.events.on("hook", (event) => {
      const body = event.body as Record<string, unknown>;
      const sessionId = transcriptSync.noteHook({
        eventType: event.type,
        body,
        sessionId: readString(body.sessionId),
      });
      provider?.noteModel(readHookModel(body));
      const isLocalOwner = provider?.state.owner === "local";
      if (sessionId && isLocalOwner) provider?.noteLocalSession(sessionId);
      if (event.type === "UserPromptSubmit") {
        if (isLocalOwner) {
          provider?.markLocalBusy();
          for (const transcriptEvent of transcriptSync.drainSession(sessionId)) {
            eventQueue.push(transcriptEvent);
          }
          const prompt = readString(body.prompt);
          if (sessionId && prompt) {
            eventQueue.push({
              type: "message",
              payload: {
                role: "user",
                sessionId,
                text: prompt,
                createdAt: Date.now(),
              },
            });
          }
        }
      }
      if (
        event.type === "Stop" ||
        event.type === "SubagentStop" ||
        event.type === "SessionEnd"
      ) {
        if (isLocalOwner) {
          transcriptSync.scheduleDrain(sessionId, (transcriptEvent) => {
            eventQueue.push(transcriptEvent);
          });
          provider?.markLocalIdle();
        }
      }
    });

    ws.connect();

    let stopping = false;
    const cleanup = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n[adit cloud claude] received ${signal}, shutting down...`);
      provider?.stop();
      ws.close();
      try {
        installedHooks?.cleanup();
      } catch {}
      void hookServer?.close().catch(() => undefined);
      setTimeout(() => process.exit(0), 100);
    };

    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("SIGTERM", () => cleanup("SIGTERM"));

    provider.on("exit", () => {
      cleanup("Claude CLI exit");
    });

    while (!stopping) {
      try {
        if (ws.isOpen && ws.currentConnectionId) {
          ws.sendHeartbeat(provider.state);
          if (eventQueue.length > 0) {
            const batch = eventQueue.splice(0, 50);
            const sent = ws.sendEvents(batch);
            if (!sent) eventQueue.unshift(...batch);
          }
          await drainCommandQueue({
            provider,
            commands: commandQueue,
            eventQueue,
            ws,
          });
        } else {
          ws.connect();
        }
      } catch (error) {
        printCloudError("[adit cloud claude] relay loop", error);
      }

      await sleep(1500);
    }
  } catch (error) {
    printCloudError("Failed to start Claude Coding relay", error);
    provider?.stop();
    try {
      installedHooks?.cleanup();
    } catch {}
    await hookServer?.close().catch(() => undefined);
    process.exitCode = 1;
  }
}
