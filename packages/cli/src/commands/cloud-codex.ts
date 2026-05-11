import { basename } from "node:path";
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
import { CodexCliProvider } from "./cli-agent/codex-cli-provider.js";
import { CodexRelayEventDeduper, CodexTranscriptSync } from "./cli-agent/codex-transcript-sync.js";
import { installCodexHooks, type InstalledHooks } from "./cli-agent/hooks-bootstrap.js";
import { startCliAgentHookServer, type HookServer } from "./cli-agent/hook-server.js";
import { CliAgentRelayWebSocket } from "./cli-agent/relay-client.js";
import type { CliAgentRelayEvent, RelayCommand } from "./cli-agent/types.js";

interface CloudCodexOptions {
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

function checkCodexAppServer(command: string): boolean {
  const result = spawnSync(command, ["app-server", "--help"], {
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
  return readString(body.model) ?? readString(body.activeModelId);
}

function withHooksEnabled(args: string[]): string[] {
  const hasHooksFlag = args.some((arg, index) =>
    (arg === "--enable" && args[index + 1] === "hooks") ||
    arg === "--enable=hooks" ||
    arg === "-cfeatures.hooks=true" ||
    arg === "-c" && args[index + 1] === "features.hooks=true" ||
    arg === "--config=features.hooks=true" ||
    arg === "--config" && args[index + 1] === "features.hooks=true"
  );
  return hasHooksFlag ? args : ["--enable", "hooks", ...args];
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
  provider: CodexCliProvider,
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
  provider: CodexCliProvider;
  commands: RelayCommand[];
  enqueueEvent: (event: CliAgentRelayEvent) => void;
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
      input.enqueueEvent({
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

export async function cloudCodexCommand(opts?: CloudCodexOptions): Promise<void> {
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

  const codexBin = opts?.bin ?? "codex";
  if (!findExecutable(codexBin)) {
    console.error(`Codex CLI not found: ${codexBin}`);
    console.error("Install Codex CLI and make sure 'codex' is available on PATH.");
    process.exitCode = 1;
    return;
  }
  if (!checkCodexAppServer(codexBin)) {
    console.error(`Codex CLI does not expose 'app-server': ${codexBin}`);
    console.error("Upgrade Codex CLI to the latest version and try again.");
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
  let provider: CodexCliProvider | null = null;
  const eventQueue: CliAgentRelayEvent[] = [];
  const commandQueue: RelayCommand[] = [];
  const seenCommandIds = new Set<string>();
  const transcriptSync = new CodexTranscriptSync();
  const eventDeduper = new CodexRelayEventDeduper();
  const enqueueEvent = (event: CliAgentRelayEvent): void => {
    const next = eventDeduper.filter(event);
    if (next) eventQueue.push(next);
  };
  const enqueueEvents = (events: CliAgentRelayEvent[]): void => {
    for (const event of events) enqueueEvent(event);
  };

  try {
    hookServer = await startCliAgentHookServer();
    installedHooks = installCodexHooks({
      cwd: config.projectRoot,
      endpoint: hookServer.endpoint,
      marker: `from=adit-cloud-codex-${hookServer.port}`,
    });

    provider = new CodexCliProvider({
      bin: codexBin,
      args: withHooksEnabled(opts?.arg ?? []),
      cwd: config.projectRoot,
      onEvent: enqueueEvent,
    });

    const ws = new CliAgentRelayWebSocket({
      serverUrl,
      accessToken: client.getCredentials().accessToken,
      register: {
        provider: "codex",
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
        console.log("Local Codex CLI owns the session until the Coding page takes over.");
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
        printCloudError("[adit cloud codex] websocket relay", error);
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
      if (event.type === "UserPromptSubmit" && isLocalOwner) {
        provider?.markLocalBusy();
        enqueueEvents(transcriptSync.drainSession(sessionId));
        const prompt = readString(body.prompt);
        if (sessionId && prompt) {
          enqueueEvent({
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
      if (event.type === "PostToolUse" && isLocalOwner) {
        const transcriptEvents = transcriptSync.drainSession(sessionId);
        if (transcriptEvents.length > 0) {
          enqueueEvents(transcriptEvents);
        } else {
          enqueueEvents(transcriptSync.toolEvents(sessionId, body));
        }
      }
      if (event.type === "Stop") {
        if (isLocalOwner) {
          const transcriptEvents = transcriptSync.drainSession(sessionId);
          if (transcriptEvents.length > 0) {
            enqueueEvents(transcriptEvents);
          } else {
            enqueueEvents(transcriptSync.stopEvents(sessionId, body));
          }
          transcriptSync.scheduleDrain(sessionId, (transcriptEvent) => {
            enqueueEvent(transcriptEvent);
          });
          provider?.markLocalIdle();
        }
      }
    });

    ws.connect();

    let stopping = false;
    let lastLocalTranscriptDrainAt = 0;
    const cleanup = (signal: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n[adit cloud codex] received ${signal}, shutting down...`);
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
      cleanup("Codex CLI exit");
    });

    while (!stopping) {
      try {
        if (ws.isOpen && ws.currentConnectionId) {
          ws.sendHeartbeat(provider.state);
          const state = provider.state;
          const now = Date.now();
          if (
            state.owner === "local" &&
            state.activeSessionId &&
            now - lastLocalTranscriptDrainAt > 1000
          ) {
            lastLocalTranscriptDrainAt = now;
            enqueueEvents(transcriptSync.drainSession(state.activeSessionId));
          }
          if (eventQueue.length > 0) {
            const batch = eventQueue.splice(0, 50);
            const sent = ws.sendEvents(batch);
            if (!sent) eventQueue.unshift(...batch);
          }
          await drainCommandQueue({
            provider,
            commands: commandQueue,
            enqueueEvent,
            ws,
          });
        } else {
          ws.connect();
        }
      } catch (error) {
        printCloudError("[adit cloud codex] relay loop", error);
      }

      await sleep(1500);
    }
  } catch (error) {
    printCloudError("Failed to start Codex Coding relay", error);
    provider?.stop();
    try {
      installedHooks?.cleanup();
    } catch {}
    await hookServer?.close().catch(() => undefined);
    process.exitCode = 1;
  }
}
