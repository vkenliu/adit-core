import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { loadConfig, findGitRoot, projectNameFromRoot } from "@varveai/adit-core";
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
import { resolveExecutable, spawnCliSync } from "./cli-agent/cli-process.js";
import { CodexRelayEventDeduper, CodexTranscriptSync } from "./cli-agent/codex-transcript-sync.js";
import {
  ensurePersistentCodexHooksInstalled,
  installCodexHooks,
  type InstalledHooks,
} from "./cli-agent/hooks-bootstrap.js";
import { startCliAgentHookServer, type HookServer } from "./cli-agent/hook-server.js";
import { CliAgentRelayWebSocket } from "./cli-agent/relay-client.js";
import type {
  CliAgentRelayEvent,
  PromptImageAttachment,
  RelayCommand,
} from "./cli-agent/types.js";

interface CloudCodexOptions {
  bin?: string;
  arg?: string[];
}

interface CodexBinCandidate {
  bin: string;
  source: string;
  explicit: boolean;
}

interface CodexExecutableSelection {
  bin: string;
  executable: string | null;
  source: string;
  supportsAppServer: boolean;
  warnings: string[];
}

const MAC_CODEX_APP_CLI = "/Applications/Codex.app/Contents/Resources/codex";

function createRelayLoopWake() {
  let wakeCurrent: (() => void) | null = null;
  return {
    wake(): void {
      const wake = wakeCurrent;
      wakeCurrent = null;
      wake?.();
    },
    wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const finish = () => {
          if (wakeCurrent === finish) wakeCurrent = null;
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(finish, ms);
        wakeCurrent = finish;
      });
    },
  };
}

function checkCodexAppServer(command: string): boolean {
  const result = spawnCliSync(command, ["app-server", "--help"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function codexVersion(command: string): string | null {
  const result = spawnCliSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output || null;
}

function codexBinCandidates(explicitBin: string | undefined): CodexBinCandidate[] {
  if (explicitBin?.trim()) {
    return [{ bin: explicitBin.trim(), source: "--bin", explicit: true }];
  }

  const candidates: CodexBinCandidate[] = [];
  const aditCodexBin = process.env.ADIT_CODEX_BIN?.trim();
  const codexCliPath = process.env.CODEX_CLI_PATH?.trim();
  if (aditCodexBin) candidates.push({ bin: aditCodexBin, source: "ADIT_CODEX_BIN", explicit: false });
  if (codexCliPath) candidates.push({ bin: codexCliPath, source: "CODEX_CLI_PATH", explicit: false });
  if (process.platform === "darwin" && fs.existsSync(MAC_CODEX_APP_CLI)) {
    candidates.push({ bin: MAC_CODEX_APP_CLI, source: "Codex.app", explicit: false });
  }
  candidates.push({ bin: "codex", source: "PATH", explicit: false });

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.bin;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectCodexExecutable(explicitBin: string | undefined): CodexExecutableSelection {
  const candidates = codexBinCandidates(explicitBin);
  const warnings: string[] = [];
  let firstResolved: Omit<CodexExecutableSelection, "warnings"> | null = null;

  for (const candidate of candidates) {
    const executable = resolveExecutable(candidate.bin);
    if (!executable) {
      if (candidate.explicit) {
        return {
          bin: candidate.bin,
          executable: null,
          source: candidate.source,
          supportsAppServer: false,
          warnings,
        };
      }
      continue;
    }

    const supportsAppServer = checkCodexAppServer(executable);
    const selection = {
      bin: candidate.bin,
      executable,
      source: candidate.source,
      supportsAppServer,
    };
    if (!firstResolved) firstResolved = selection;
    if (supportsAppServer || candidate.explicit) {
      return { ...selection, warnings };
    }

    warnings.push(
      `[adit cloud codex] warning: ${candidate.source} Codex CLI does not expose app-server: ${executable}`,
    );
  }

  if (firstResolved) return { ...firstResolved, warnings };
  return {
    bin: candidates[0]?.bin ?? "codex",
    executable: null,
    source: candidates[0]?.source ?? "PATH",
    supportsAppServer: false,
    warnings,
  };
}

function codexBinaryMismatchWarnings(selectedExecutable: string): string[] {
  const selectedVersion = codexVersion(selectedExecutable);
  if (!selectedVersion) return [];

  const alternatives: Array<{ label: string; bin: string }> = [
    { label: "PATH codex", bin: "codex" },
    { label: "Codex.app", bin: MAC_CODEX_APP_CLI },
  ];
  const seen = new Set([selectedExecutable]);
  const warnings: string[] = [];

  for (const alternative of alternatives) {
    const executable = resolveExecutable(alternative.bin);
    if (!executable || seen.has(executable)) continue;
    seen.add(executable);
    const version = codexVersion(executable);
    if (!version || version === selectedVersion) continue;
    warnings.push(
      `[adit cloud codex] warning: selected Codex CLI (${selectedVersion}, ${selectedExecutable}) differs from ${alternative.label} (${version}, ${executable}). Mixed Codex binaries can rewrite ~/.codex/skills/.system during takeover; pin one binary with --bin if this is intentional.`,
    );
  }

  return warnings;
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function readImageAttachments(value: unknown): PromptImageAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: PromptImageAttachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = readString(item.id);
    const url = readString(item.url);
    const mimeType = readString(item.mimeType);
    if (!id || !url || !mimeType?.startsWith("image/")) continue;
    attachments.push({
      id,
      kind: "image",
      url,
      mimeType,
      fileName: readString(item.fileName),
      sizeBytes: typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes)
        ? item.sizeBytes
        : 0,
    });
  }
  return attachments;
}

function isPendingSessionId(value: string | null | undefined): boolean {
  return value?.startsWith("pending_") ?? false;
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
    const attachments = readImageAttachments(command.payload.attachments);
    if (!text && attachments.length === 0) return;
    const sessionId = readString(command.payload.sessionId);
    const pendingSessionId = readString(command.payload.pendingSessionId);
    const localMessageId = readString(command.payload.localMessageId);
    const mode = readString(command.payload.mode) === "plan" ? "plan" : "build";
    if (!pendingSessionId && sessionId && provider.state.activeSessionId !== sessionId) {
      await provider.switchSession(sessionId);
    }
    await provider.sendPrompt(text ?? "", { mode, pendingSessionId, localMessageId, attachments });
    return;
  }

  if (command.type === "steer") {
    const text = readString(command.payload.text);
    const attachments = readImageAttachments(command.payload.attachments);
    if (!text && attachments.length === 0) return;
    const sessionId = readString(command.payload.sessionId);
    const localMessageId = readString(command.payload.localMessageId);
    const mode = readString(command.payload.mode) === "plan" ? "plan" : "build";
    try {
      await provider.steerPrompt(text ?? "", { sessionId, localMessageId, mode, attachments });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not currently accepting steering input/i.test(message)) {
        await provider.sendPrompt(text ?? "", { mode, localMessageId, attachments });
        return;
      }
      throw error;
    }
    return;
  }

  if (command.type === "slash-command") {
    const name = readString(command.payload.command) ?? readString(command.payload.name);
    if (!name) return;
    const sessionId = readString(command.payload.sessionId);
    const pendingSessionId =
      readString(command.payload.pendingSessionId) ??
      (isPendingSessionId(sessionId) ? sessionId : null);
    if (!pendingSessionId && sessionId && provider.state.activeSessionId !== sessionId) {
      await provider.switchSession(sessionId);
    }
    await provider.handleSlashCommand({
      name,
      args: readStringArray(command.payload.args),
      raw: readString(command.payload.raw) ?? `/${name}`,
      sessionId,
      pendingSessionId,
      localMessageId: readString(command.payload.localMessageId),
    });
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
}): boolean {
  if (input.seen.has(input.command.id)) return false;
  input.seen.add(input.command.id);
  input.queue.push(input.command);
  if (input.seen.size > 500) {
    const keep = new Set(input.queue.map((command) => command.id));
    for (const id of input.seen) {
      if (!keep.has(id) && input.seen.size > 250) input.seen.delete(id);
    }
  }
  return true;
}

function commandErrorSessionId(
  provider: CodexCliProvider,
  command: RelayCommand,
  previousActiveSessionId: string | null,
): string | null {
  const payloadSessionId = readString(command.payload.sessionId);
  const pendingSessionId =
    readString(command.payload.pendingSessionId) ??
    (isPendingSessionId(payloadSessionId) ? payloadSessionId : null);
  if (pendingSessionId) {
    const activeSessionId = provider.state.activeSessionId;
    if (
      activeSessionId &&
      activeSessionId !== previousActiveSessionId &&
      !isPendingSessionId(activeSessionId)
    ) {
      return activeSessionId;
    }
    return pendingSessionId;
  }
  return payloadSessionId ?? provider.state.activeSessionId ?? provider.state.resumeSessionId;
}

async function drainCommandQueue(input: {
  provider: CodexCliProvider;
  commands: RelayCommand[];
  enqueueEvent: (event: CliAgentRelayEvent) => void;
  ws: CliAgentRelayWebSocket | null;
}): Promise<boolean> {
  let processed = false;
  while (input.commands.length > 0) {
    const command = input.commands.shift();
    if (!command) return processed;
    processed = true;
    const previousActiveSessionId = input.provider.state.activeSessionId;
    try {
      await processCommand(input.provider, command);
      input.ws?.ack(command.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sessionId = commandErrorSessionId(input.provider, command, previousActiveSessionId);
      input.ws?.commandError(command.id, message, sessionId);
      input.enqueueEvent({
        type: "error",
        payload: {
          message,
          commandId: command.id,
          ...(sessionId ? { sessionId } : {}),
          createdAt: Date.now(),
        },
      });
    }
  }
  return processed;
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

  const codexSelection = selectCodexExecutable(opts?.bin);
  const codexExecutable = codexSelection.executable;
  if (!codexExecutable) {
    console.error(`Codex CLI not found: ${codexSelection.bin}`);
    console.error("Install Codex CLI and make sure 'codex' is available on PATH.");
    process.exitCode = 1;
    return;
  }
  for (const warning of codexSelection.warnings) console.error(warning);
  if (!codexSelection.supportsAppServer) {
    console.error(`Codex CLI does not expose 'app-server': ${codexSelection.bin}`);
    console.error("Upgrade Codex CLI to the latest version and try again.");
    process.exitCode = 1;
    return;
  }
  if (!opts?.bin && codexSelection.source !== "PATH") {
    console.log(`[adit cloud codex] using Codex CLI from ${codexExecutable} (${codexSelection.source}).`);
  }
  for (const warning of codexBinaryMismatchWarnings(codexExecutable)) console.error(warning);

  const cloudConfig = loadCloudConfig();
  const serverUrl = cloudConfig.serverUrl ?? credentials.serverUrl ?? DEFAULT_SERVER_URL;
  const client = new CloudClient(serverUrl, credentials);
  const terminalId = randomUUID();
  const projectName = projectNameFromRoot(config.projectRoot);
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
  const relayLoopWake = createRelayLoopWake();
  const enqueueEvent = (event: CliAgentRelayEvent): void => {
    const next = eventDeduper.filter(event);
    if (next) {
      eventQueue.push(next);
      relayLoopWake.wake();
    }
  };
  const enqueueEvents = (events: CliAgentRelayEvent[]): void => {
    for (const event of events) enqueueEvent(event);
  };

  try {
    const installedPersistentHooks = await ensurePersistentCodexHooksInstalled({
      cwd: config.projectRoot,
    });
    if (installedPersistentHooks) {
      console.log("Installed ADIT Codex hooks for local timeline tracking.");
    }
  } catch (error) {
    console.error(
      `[adit cloud codex] warning: failed to install persistent ADIT Codex hooks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    hookServer = await startCliAgentHookServer();
    installedHooks = installCodexHooks({
      cwd: config.projectRoot,
      endpoint: hookServer.endpoint,
      marker: `from=adit-cloud-codex-${hookServer.port}`,
    });

    provider = new CodexCliProvider({
      bin: codexExecutable,
      args: withHooksEnabled(opts?.arg ?? []),
      cwd: config.projectRoot,
      onEvent: enqueueEvent,
    });

    const ws = new CliAgentRelayWebSocket({
      serverUrl,
      accessToken: async () => (await client.getFreshCredentials()).accessToken,
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
      onCommand: (command) => {
        const enqueued = enqueueCommand({
          queue: commandQueue,
          seen: seenCommandIds,
          command,
        });
        if (enqueued) relayLoopWake.wake();
      },
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
    let lastTranscriptDrainAt = 0;
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
          const flushEvents = () => {
            if (eventQueue.length === 0) return;
            const batch = eventQueue.splice(0, 50);
            const sent = ws.sendEvents(batch);
            if (!sent) eventQueue.unshift(...batch);
          };
          await drainCommandQueue({
            provider,
            commands: commandQueue,
            enqueueEvent,
            ws,
          });
          ws.sendHeartbeat(provider.state);
          const state = provider.state;
          const now = Date.now();
          if (state.activeSessionId && now - lastTranscriptDrainAt > 1000) {
            lastTranscriptDrainAt = now;
            enqueueEvents(transcriptSync.drainSession(state.activeSessionId));
          }
          flushEvents();
        } else {
          ws.connect();
        }
      } catch (error) {
        printCloudError("[adit cloud codex] relay loop", error);
      }

      const relayConnected = ws.isOpen && Boolean(ws.currentConnectionId);
      if (commandQueue.length === 0 && (!relayConnected || eventQueue.length === 0)) {
        await relayLoopWake.wait(1500);
      }
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
