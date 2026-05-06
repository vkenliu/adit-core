import type { CloudClient } from "@varveai/adit-cloud";
import type { CliAgentRelayEvent, RelayCommand } from "./types.js";

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class CliAgentRelayClient {
  constructor(private readonly client: CloudClient) {}

  async register(input: {
    provider: "claude-code";
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
          command.type !== "takeover"
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
