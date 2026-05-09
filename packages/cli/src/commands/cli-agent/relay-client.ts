import type { CloudClient } from "@varveai/adit-cloud";
import WebSocket from "ws";
import type { CliAgentConnectionState, CliAgentRelayEvent, RelayCommand } from "./types.js";

interface RegisterResponse {
  connection: {
    id: string;
    panelId: string | null;
  };
  panel: {
    id: string;
    name: string;
  };
}

interface CommandsResponse {
  commands?: Array<{
    id: string;
    type: string;
    payload: unknown;
    createdAt: number;
  }>;
}

type RelayWsStatus = "connecting" | "open" | "closed";

interface RelayWsClientOptions {
  serverUrl: string;
  accessToken: string;
  connectionId: string;
  onCommand: (command: RelayCommand) => void;
  onStatus?: (status: RelayWsStatus) => void;
  onError?: (error: Error) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asCommand(value: unknown): RelayCommand | null {
  const command = asRecord(value);
  const type = command.type;
  if (
    type !== "prompt" &&
    type !== "abort" &&
    type !== "permission" &&
    type !== "question" &&
    type !== "takeover" &&
    type !== "switch-session"
  ) {
    return null;
  }
  if (typeof command.id !== "string") return null;
  return {
    id: command.id,
    type,
    payload: asRecord(command.payload),
    createdAt: typeof command.createdAt === "number" ? command.createdAt : Date.now(),
  };
}

function wsUrlFromServer(serverUrl: string): string {
  const configured =
    process.env.ADIT_CLI_AGENT_WS_URL ??
    process.env.CLI_AGENT_WS_URL ??
    process.env.CLI_AGENT_WS_PUBLIC_URL;
  const url = new URL(configured?.trim() || "/ws/coding/cli-agent", serverUrl);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/ws/coding/cli-agent";
  }
  if (
    !configured &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    (url.port === "" || url.port === "3000")
  ) {
    url.port = process.env.CLI_AGENT_WS_PORT ?? "3001";
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class CliAgentRelayWebSocket {
  private socket: WebSocket | null = null;
  private statusValue: RelayWsStatus = "closed";

  constructor(private readonly opts: RelayWsClientOptions) {}

  get status(): RelayWsStatus {
    return this.statusValue;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.setStatus("connecting");
    const socket = new WebSocket(wsUrlFromServer(this.opts.serverUrl), {
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
      },
    });
    this.socket = socket;

    socket.on("open", () => {
      this.setStatus("open");
      this.send({
        type: "hello",
        connectionId: this.opts.connectionId,
      });
    });

    socket.on("message", (data) => {
      this.handleMessage(data.toString("utf8"));
    });

    socket.on("error", (error) => {
      this.opts.onError?.(error instanceof Error ? error : new Error(String(error)));
    });

    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.setStatus("closed");
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.setStatus("closed");
    socket?.close();
  }

  sendHeartbeat(state: CliAgentConnectionState, status: "online" | "offline" = "online"): boolean {
    return this.send({
      type: "heartbeat",
      status,
      ...state,
    });
  }

  sendEvents(events: CliAgentRelayEvent[]): boolean {
    if (events.length === 0) return true;
    return this.send({
      type: "events",
      events,
    });
  }

  ack(commandId: string): boolean {
    return this.send({ type: "command.ack", commandId });
  }

  commandError(commandId: string, message: string): boolean {
    return this.send({ type: "command.error", commandId, message });
  }

  private send(value: unknown): boolean {
    if (!this.isOpen || !this.socket) return false;
    this.socket.send(JSON.stringify(value));
    return true;
  }

  private setStatus(status: RelayWsStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.opts.onStatus?.(status);
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const message = asRecord(parsed);
    if (message.type === "command") {
      const command = asCommand(message.command);
      if (command) this.opts.onCommand(command);
      return;
    }
    if (message.type === "commands" && Array.isArray(message.commands)) {
      for (const item of message.commands) {
        const command = asCommand(item);
        if (command) this.opts.onCommand(command);
      }
    }
  }
}

export class CliAgentRelayClient {
  constructor(private readonly client: CloudClient) {}

  connectWebSocket(input: RelayWsClientOptions): CliAgentRelayWebSocket {
    const ws = new CliAgentRelayWebSocket(input);
    ws.connect();
    return ws;
  }

  async register(input: {
    provider: "claude-code";
    terminalId: string;
    projectRoot: string;
    projectId: string;
    projectName: string;
    panelName?: string;
  }): Promise<RegisterResponse> {
    return this.client.post<RegisterResponse>(
      "/api/coding/cli-connections/register",
      input,
    );
  }

  async heartbeat(input: {
    connectionId: string;
    status?: "online" | "offline";
    owner: string;
    busy: boolean;
    thinking: boolean;
    activeSessionId: string | null;
    resumeSessionId: string | null;
    sdkSessionId: string | null;
    activeModelId: string | null;
  }): Promise<void> {
    await this.client.post("/api/coding/cli-connections/heartbeat", input);
  }

  async fetchCommands(connectionId: string): Promise<RelayCommand[]> {
    const response = await this.client.get<CommandsResponse>(
      `/api/coding/cli-connections/${encodeURIComponent(connectionId)}/commands`,
    );

    return (response.commands ?? [])
      .map((command) => {
        if (
          command.type !== "prompt" &&
          command.type !== "abort" &&
          command.type !== "permission" &&
          command.type !== "question" &&
          command.type !== "takeover" &&
          command.type !== "switch-session"
        ) {
          return null;
        }
        return {
          id: command.id,
          type: command.type,
          payload: asRecord(command.payload),
          createdAt: command.createdAt,
        };
      })
      .filter((command): command is RelayCommand => Boolean(command));
  }

  async pushEvents(
    connectionId: string,
    events: CliAgentRelayEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    await this.client.post(
      `/api/coding/cli-connections/${encodeURIComponent(connectionId)}/events`,
      { events },
    );
  }
}
