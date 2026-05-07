export type CliAgentProviderName = "claude-code" | "codex";

export type CliAgentOwner = "local" | "web" | "stopped";

export interface CliAgentState {
  owner: CliAgentOwner;
  busy: boolean;
  thinking: boolean;
  activeSessionId: string | null;
  resumeSessionId: string | null;
  sdkSessionId: string | null;
  activeModelId: string | null;
}

export interface CliPermissionRequest {
  id: string;
  toolName: string;
  input: unknown;
  createdAt: number;
}

export interface CliAgentProvider {
  readonly provider: CliAgentProviderName;
  readonly state: CliAgentState;
  readonly permissions: CliPermissionRequest[];
  takeover(): Promise<void>;
  releaseToLocal(): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  sendPrompt(prompt: string, opts?: { mode?: "build" | "plan" }): Promise<void>;
  answerPermission(
    id: string,
    approved: boolean,
    reason?: string,
  ): Promise<void>;
  abort(): Promise<void>;
  stop(): void;
}

export interface CliAgentRelayEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface RelayCommand {
  id: string;
  type: "prompt" | "abort" | "permission" | "takeover" | "switch-session";
  payload: Record<string, unknown>;
  createdAt: number;
}
