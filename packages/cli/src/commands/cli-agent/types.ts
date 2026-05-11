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

export interface CliQuestionResponse {
  id: string;
  answers: string[][];
  rejected?: boolean;
}

export interface CliAgentProvider {
  readonly provider: CliAgentProviderName;
  readonly state: CliAgentState;
  readonly permissions: CliPermissionRequest[];
  takeover(): Promise<void>;
  releaseToLocal(): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  sendPrompt(prompt: string, opts?: { mode?: "build" | "plan"; pendingSessionId?: string | null }): Promise<void>;
  answerPermission(
    id: string,
    approved: boolean,
    reason?: string,
  ): Promise<void>;
  answerQuestion(response: CliQuestionResponse): Promise<void>;
  abort(): Promise<void>;
  stop(): void;
}

export interface CliAgentRelayEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface RelayCommand {
  id: string;
  type: "prompt" | "abort" | "permission" | "question" | "takeover" | "switch-session";
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CliAgentConnectionState {
  owner: string;
  busy: boolean;
  thinking: boolean;
  activeSessionId: string | null;
  resumeSessionId: string | null;
  sdkSessionId: string | null;
  activeModelId: string | null;
}
