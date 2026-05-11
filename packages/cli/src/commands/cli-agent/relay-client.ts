import WebSocket from "ws";
import type {
  CliAgentConnectionState,
  CliAgentProviderName,
  CliAgentRelayEvent,
  RelayCommand,
} from "./types.js";

export interface CliAgentRegisterPayload {
  provider: CliAgentProviderName;
  terminalId: string;
  projectRoot: string;
  projectId: string;
  projectName: string;
  panelName?: string;
}

export interface CliAgentRelayHello {
  connectionId: string;
  panelId: string | null;
  panelName: string | null;
}

type RelayWsStatus = "connecting" | "open" | "closed";

export interface RelayWsClientOptions {
  serverUrl: string;
  accessToken: string;
  register: CliAgentRegisterPayload;
  onHello: (info: CliAgentRelayHello) => void;
  onCommand: (command: RelayCommand) => void;
  onConnectionClosed?: () => void;
  onStatus?: (status: RelayWsStatus) => void;
  onError?: (error: Error) => void;
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

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
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionalClose = false;
  private connectionId: string | null = null;

  constructor(private readonly opts: RelayWsClientOptions) {}

  get status(): RelayWsStatus {
    return this.statusValue;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get currentConnectionId(): string | null {
    return this.connectionId;
  }

  connect(): void {
    if (this.intentionalClose) return;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
        accessToken: this.opts.accessToken,
        register: this.opts.register,
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
      const hadConnection = this.connectionId !== null;
      this.connectionId = null;
      this.setStatus("closed");
      if (hadConnection) this.opts.onConnectionClosed?.();
      if (!this.intentionalClose) this.scheduleReconnect();
    });
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.connectionId = null;
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

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const message = asRecord(parsed);

    if (message.type === "hello.ok") {
      const connection = asRecord(message.connection);
      const panel = asRecord(message.panel);
      const connectionId = typeof connection.id === "string" ? connection.id : null;
      if (connectionId) {
        this.connectionId = connectionId;
        this.reconnectAttempt = 0;
        this.opts.onHello({
          connectionId,
          panelId: typeof panel.id === "string" ? panel.id : null,
          panelName: typeof panel.name === "string" ? panel.name : null,
        });
      }
      return;
    }

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
