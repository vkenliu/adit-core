export type CliAgentProviderName = "claude-code" | "codex";

export type CliAgentOwner = "local" | "web" | "stopped";

export interface CliAgentContextUsage {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
  modelId?: string | null;
  updatedAt: number;
  source: "claude-sdk" | "codex-app-server";
}

export interface CliAgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  updatedAt: number;
  source: "codex-app-server";
}

export interface CliAgentState {
  owner: CliAgentOwner;
  busy: boolean;
  thinking: boolean;
  activeSessionId: string | null;
  resumeSessionId: string | null;
  sdkSessionId: string | null;
  activeModelId: string | null;
  currentBranch: string | null;
  contextUsage: CliAgentContextUsage | null;
  lastTokenUsage: CliAgentTokenUsage | null;
  metadata?: Record<string, unknown>;
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

export interface CliSlashCommand {
  name: string;
  args: string[];
  raw: string;
  sessionId?: string | null;
  pendingSessionId?: string | null;
  localMessageId?: string | null;
}

export interface CliRewindResponse {
  id: string;
  sessionId?: string | null;
  userMessageId?: string | null;
  dryRun?: boolean;
  rejected?: boolean;
}

export interface CliSlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface CliAgentProvider {
  readonly provider: CliAgentProviderName;
  readonly state: CliAgentState;
  readonly permissions: CliPermissionRequest[];
  takeover(): Promise<void>;
  releaseToLocal(): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  sendPrompt(prompt: string, opts?: {
    mode?: "build" | "plan";
    pendingSessionId?: string | null;
    localMessageId?: string | null;
  }): Promise<void>;
  steerPrompt?(prompt: string, opts?: {
    sessionId?: string | null;
    localMessageId?: string | null;
    mode?: "build" | "plan";
  }): Promise<void>;
  handleSlashCommand(command: CliSlashCommand): Promise<void>;
  answerRewind?(response: CliRewindResponse): Promise<void>;
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
  type:
    | "prompt"
    | "steer"
    | "abort"
    | "permission"
    | "question"
    | "takeover"
    | "switch-session"
    | "slash-command"
    | "rewind";
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
  currentBranch: string | null;
  contextUsage: CliAgentContextUsage | null;
  lastTokenUsage: CliAgentTokenUsage | null;
  metadata?: Record<string, unknown>;
}
