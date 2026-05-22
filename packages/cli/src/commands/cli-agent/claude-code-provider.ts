import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  AbortError,
  query,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { getCurrentBranch } from "@varveai/adit-engine";
import type {
  CliAgentContextUsage,
  CliAgentProvider,
  CliAgentRelayEvent,
  CliQuestionResponse,
  CliAgentState,
  CliPermissionRequest,
  CliSlashCommand,
  CliSlashCommandInfo,
  CliRewindResponse,
} from "./types.js";
import { spawnCliProcess, spawnClaudeCliProcess } from "./cli-process.js";

interface PendingPrompt {
  message: string;
  mode: "build" | "plan";
  pendingSessionId: string | null;
  localMessageId: string | null;
  promptEvent: PendingPromptEvent;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface QueuedSdkPrompt {
  message: string;
  mode: "build" | "plan";
  pendingSessionId: string | null;
  localMessageId: string | null;
  promptEvent: PendingPromptEvent;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ActiveClaudePromptInput {
  generation: number;
  displaySessionId: string | null;
  acceptedSessionIds: Set<string>;
  stream: PushableSdkPromptStream;
}

interface PendingPromptEvent {
  text: string;
  messageId?: string;
  createdAt: number;
}

interface ClaudeCodeProviderOptions {
  bin: string;
  args: string[];
  cwd: string;
  hookSettingsPath?: string;
  onEvent?: (event: CliAgentRelayEvent) => void;
}

type CapabilityHydrateTarget =
  | { owner: "local"; child: ChildProcess }
  | { owner: "web"; generation: number };

const RECLAIM_COMMAND = "/local";
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const EXIT_PLAN_MODE_TOOL = "ExitPlanMode";
const TODO_WRITE_TOOL = "TodoWrite";
const CLAUDE_CLOUD_NATIVE_SLASH_COMMANDS = ["rewind"] as const;
const BRANCH_REFRESH_INTERVAL_MS = 5_000;
const CONTEXT_USAGE_REFRESH_INTERVAL_MS = 10_000;

export const CLAUDE_CLOUD_RELAY_ADIT_ENV: Readonly<Record<string, string>> = {
  ADIT_CLOUD_AUTO_SYNC: "false",
  ADIT_PROJECT_LINK_AUTO_SYNC: "false",
  ADIT_TRANSCRIPT_UPLOAD: "false",
};

export type ClaudeTodoStatus = "pending" | "in_progress" | "completed";
export type ClaudeTodoPriority = "high" | "medium" | "low";

export interface ClaudeTodoItem {
  id: string;
  content: string;
  status: ClaudeTodoStatus;
  priority?: ClaudeTodoPriority;
  activeForm?: string;
}

interface CliQuestionRequest {
  id: string;
  input: Record<string, unknown>;
  createdAt: number;
}

interface ClaudeRewindCheckpoint {
  messageId: string;
  label: string;
  preview: string;
  timestamp: number;
  files: number;
}

interface PendingRewindRequest {
  id: string;
  sessionId: string;
  checkpoints: ClaudeRewindCheckpoint[];
}

export class ClaudeCodeProvider extends EventEmitter implements CliAgentProvider {
  readonly provider = "claude-code" as const;
  private local: ChildProcess | null = null;
  private remoteQuery: Query | null = null;
  private capabilityProbeQuery: Query | null = null;
  private capabilityProbeAbortController: AbortController | null = null;
  private remoteAbortController: AbortController | null = null;
  private remoteLoopGeneration = 0;
  private ownerValue: CliAgentState["owner"] = "stopped";
  private busyValue = false;
  private thinkingValue = false;
  private activeSessionId: string | null = null;
  private resumeSessionId: string | null = null;
  private sdkSessionId: string | null = null;
  private remoteSdkSessionId: string | null = null;
  private remoteSdkSessionIdsByActiveSession = new Map<string, Set<string>>();
  private activeModelId: string | null = null;
  private currentBranch: string | null = null;
  private branchRefreshAt = 0;
  private branchRefreshPromise: Promise<void> | null = null;
  private contextUsage: CliAgentContextUsage | null = null;
  private contextUsageBySession = new Map<string, CliAgentContextUsage>();
  private contextUsageRefreshAt = 0;
  private contextUsageRefreshPromise: Promise<void> | null = null;
  private promptQueue: PendingPrompt[] = [];
  private promptResolvers: Array<(value: QueuedSdkPrompt | null) => void> = [];
  private startingPrompt: QueuedSdkPrompt | null = null;
  private activePromptInput: ActiveClaudePromptInput | null = null;
  private activePromptEvent: PendingPromptEvent | null = null;
  private pendingPermissions = new Map<string, {
    request: CliPermissionRequest;
    resolve: (result: PermissionResult) => void;
    reject: (error: Error) => void;
  }>();
  private pendingQuestions = new Map<string, {
    request: CliQuestionRequest;
    resolve: (result: PermissionResult) => void;
    reject: (error: Error) => void;
  }>();
  private pendingRewinds = new Map<string, PendingRewindRequest>();
  private boundPendingSessionIds = new Set<string>();
  private lastAssistantMessageBySession = new Map<string, string>();
  private slashCommandsByName = new Map<string, CliSlashCommandInfo>();
  private mcpServers: Array<{ name: string; status: string }> = [];
  private skills: string[] = [];
  private capabilityHydrateGeneration = 0;
  private reclaimingToLocal = false;
  private reclaimBuffer = "";
  private reclaimAttached = false;
  private suppressNextLocalExit = false;

  constructor(private readonly opts: ClaudeCodeProviderOptions) {
    super();
    this.startLocal();
  }

  get state(): CliAgentState {
    this.scheduleBranchRefresh();
    return {
      owner: this.ownerValue,
      busy: this.busyValue,
      thinking: this.thinkingValue,
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      sdkSessionId: this.sdkSessionId,
      activeModelId: this.activeModelId,
      currentBranch: this.currentBranch,
      contextUsage: this.contextUsage,
      lastTokenUsage: null,
    };
  }

  get permissions(): CliPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((item) => item.request);
  }

  noteModel(modelId: string | null | undefined): void {
    if (!modelId || modelId === this.activeModelId) return;
    this.activeModelId = modelId;
    this.emitState();
  }

  noteLocalSession(id: string): void {
    if (!id) return;
    const changed = this.activeSessionId !== id || this.resumeSessionId !== id;
    this.activeSessionId = id;
    this.resumeSessionId = id;
    this.sdkSessionId = null;
    this.remoteSdkSessionId = null;
    this.applyStoredContextUsageForSession(id);
    this.refreshActiveModel({ sessionId: id });
    if (!changed) return;
    this.emitState();
  }

  markLocalBusy(): void {
    this.setBusy(true);
    this.setThinking(true);
  }

  markLocalIdle(): void {
    this.setThinking(false);
    this.setBusy(false);
  }

  async takeover(): Promise<void> {
    if (this.ownerValue === "web") {
      this.emitSlashCommands();
      void this.hydrateCapabilities({
        owner: "web",
        generation: this.remoteLoopGeneration,
      });
      return;
    }
    if (this.ownerValue !== "local") {
      throw Object.assign(new Error("local Claude owner is not available"), {
        statusCode: 409,
      });
    }
    if (this.busyValue || this.thinkingValue) {
      throw Object.assign(new Error("local Claude is busy"), {
        statusCode: 409,
      });
    }

    this.suppressNextLocalExit = true;
    const oldLocal = this.local;
    this.local = null;
    try {
      oldLocal?.kill("SIGTERM");
    } catch {}

    this.ownerValue = "web";
    this.reclaimingToLocal = false;
    this.emitState();
    process.stderr.write(
      `\n[adit cloud claude] Web has taken over Claude Code. Type ${RECLAIM_COMMAND} here to reclaim local control.\n`,
    );
    this.attachReclaimInput();
    const generation = ++this.remoteLoopGeneration;
    void this.runRemoteLoop(generation);
    void this.hydrateCapabilities({ owner: "web", generation });
  }

  async releaseToLocal(): Promise<void> {
    if (this.ownerValue !== "web") return;
    if (this.reclaimingToLocal) return;
    this.reclaimingToLocal = true;
    this.detachReclaimInput();
    this.stopCapabilityProbe();
    process.stderr.write("\n[adit cloud claude] releasing Web control back to local Claude CLI...\n");
    this.remoteLoopGeneration++;
    await this.finishActiveRunAsAborted({
      errorMessage: "Web control released to local CLI",
      eventMessage: "Web control released to local CLI.",
      interruptRemote: true,
    });
    this.mergeRemoteTranscriptsIntoActive();
    const resumeId = this.pickResumeSessionId({ fallbackToLatest: true });
    this.startLocal(resumeId ? ["--resume", resumeId] : []);
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!isUuid(sessionId)) {
      throw Object.assign(new Error("Claude session not found for this project"), {
        statusCode: 404,
      });
    }

    const hasLocalTranscript = isValidClaudeSession(sessionId, this.opts.cwd);
    if (!hasLocalTranscript && this.ownerValue !== "web") {
      throw Object.assign(new Error("Claude session not found for this project"), {
        statusCode: 404,
      });
    }

    if (this.ownerValue === "web") {
      const generation = ++this.remoteLoopGeneration;
      await this.finishActiveRunAsAborted({
        errorMessage: "Claude session switched",
        eventMessage: "Claude session switched.",
        interruptRemote: true,
      });
      this.activeSessionId = sessionId;
      this.resumeSessionId = sessionId;
      this.sdkSessionId = null;
      this.remoteSdkSessionId = null;
      this.applyStoredContextUsageForSession(sessionId);
      this.refreshActiveModel({ sessionId });
      this.emitState();
      void this.runRemoteLoop(generation);
      return;
    }

    this.activeSessionId = sessionId;
    this.resumeSessionId = sessionId;
    this.sdkSessionId = null;
    this.remoteSdkSessionId = null;
    this.applyStoredContextUsageForSession(sessionId);
    this.refreshActiveModel({ sessionId });
    this.emitState();

    if (this.ownerValue === "local") {
      this.suppressNextLocalExit = true;
      const oldLocal = this.local;
      this.local = null;
      try {
        oldLocal?.kill("SIGTERM");
      } catch {}
      this.startLocal(["--resume", sessionId]);
      return;
    }
  }

  async sendPrompt(
    prompt: string,
    opts: { mode?: "build" | "plan"; pendingSessionId?: string | null; localMessageId?: string | null } = {},
  ): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Claude session"), {
        statusCode: 409,
      });
    }
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const sessionId = this.activeSessionId ?? this.resumeSessionId;
    this.refreshActiveModel({ sessionId });

    await new Promise<void>((resolve, reject) => {
      this.promptQueue.push({
        message: trimmed,
        mode: opts.mode === "plan" ? "plan" : "build",
        pendingSessionId: opts.pendingSessionId ?? null,
        localMessageId: opts.localMessageId ?? null,
        promptEvent: {
          text: trimmed,
          ...(opts.localMessageId ? { messageId: opts.localMessageId } : {}),
          createdAt: Date.now(),
        },
        resolve,
        reject,
      });
      this.drainPromptResolvers();
    });
  }

  async steerPrompt(
    prompt: string,
    opts: { sessionId?: string | null; localMessageId?: string | null } = {},
  ): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Claude session"), {
        statusCode: 409,
      });
    }
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const input = this.activePromptInput;
    if (
      !input ||
      input.generation !== this.remoteLoopGeneration ||
      !this.remoteQuery ||
      (!this.busyValue && !this.thinkingValue)
    ) {
      throw Object.assign(new Error("Claude Code is not currently accepting steering input"), {
        statusCode: 409,
      });
    }
    if (opts.sessionId && !this.acceptsSteerSessionId(opts.sessionId, input)) {
      throw Object.assign(new Error("Claude Code is running a different session"), {
        statusCode: 409,
      });
    }

    const sessionId =
      (opts.sessionId && !opts.sessionId.startsWith("pending_") ? opts.sessionId : null) ??
      this.activeSessionId ??
      this.resumeSessionId ??
      input.displaySessionId ??
      this.sdkSessionId ??
      this.remoteSdkSessionId ??
      "pending";
    const sdkSessionId = this.remoteSdkSessionId ??
      this.sdkSessionId ??
      Array.from(input.acceptedSessionIds).find(isUuid);
    input.stream.push(toUserMessage(trimmed, sdkSessionId ?? undefined, {
      priority: "now",
      shouldQuery: true,
    }));
    this.pushEvent("message", {
      role: "user",
      sessionId,
      ...(opts.localMessageId ? { messageId: opts.localMessageId } : {}),
      text: trimmed,
      inputKind: "steer",
      createdAt: Date.now(),
    });
  }

  async handleSlashCommand(command: CliSlashCommand): Promise<void> {
    const name = command.name.trim().replace(/^\//, "");
    if (!name) return;
    const normalized = name.toLowerCase();

    if (normalized === "mcp") {
      this.pushNotice({
        title: "/mcp",
        text: formatClaudeMcpServers(this.mcpServers),
        sessionId: command.sessionId,
      });
      return;
    }

    if (normalized === "skills") {
      this.pushNotice({
        title: "/skills",
        text: formatClaudeSkills(this.skills, this.slashCommandsByName),
        sessionId: command.sessionId,
        data: {
          noticeKind: "skills",
          provider: this.provider,
          skills: this.skills.map((name) => ({
            name,
            enabled: true,
          })),
        },
      });
      return;
    }

    if (normalized === "rewind") {
      this.requestRewind(command.sessionId);
      return;
    }

    if (!this.slashCommandsByName.has(normalized)) {
      throw Object.assign(
        new Error(`Claude Code did not expose /${name} for this Cloud session.`),
        { statusCode: 400 },
      );
    }

    await this.sendPrompt(command.raw.startsWith("/") ? command.raw : `/${command.raw}`, {
      mode: "build",
      pendingSessionId: command.pendingSessionId ?? pendingSessionIdFromSlashCommand(command),
      localMessageId: command.localMessageId ?? null,
    });
  }

  private requestRewind(sessionIdInput?: string | null): void {
    const sessionId = sessionIdInput ?? this.activeSessionId ?? this.resumeSessionId ?? this.sdkSessionId;
    if (!sessionId || !isValidClaudeSession(sessionId, this.opts.cwd)) {
      this.pushNotice({
        title: "/rewind",
        text: "Claude Code does not have an active session that can be rewound.",
        sessionId,
      });
      return;
    }

    const checkpoints = readClaudeRewindCheckpoints(this.opts.cwd, sessionId, 30);
    if (checkpoints.length === 0) {
      this.pushNotice({
        title: "/rewind",
        text: "No Claude Code user messages were found for this session.",
        sessionId,
      });
      return;
    }

    const id = `rewind-${randomUUID()}`;
    this.pendingRewinds.set(id, { id, sessionId, checkpoints });
    this.pushEvent("rewind.requested", {
      id,
      sessionId,
      checkpoints,
      createdAt: Date.now(),
    });
  }

  async answerRewind(response: CliRewindResponse): Promise<void> {
    const pending = this.pendingRewinds.get(response.id);
    if (response.rejected) {
      if (pending) this.pendingRewinds.delete(response.id);
      this.pushEvent("rewind.rejected", {
        id: response.id,
        sessionId: pending?.sessionId ?? response.sessionId,
        createdAt: Date.now(),
      });
      return;
    }

    const sessionId = response.sessionId ?? pending?.sessionId;
    const userMessageId = response.userMessageId;
    if (!sessionId || !userMessageId) {
      throw Object.assign(new Error("rewind sessionId and userMessageId are required"), {
        statusCode: 400,
      });
    }
    if (this.busyValue) {
      throw Object.assign(new Error("Claude Code is busy; wait for the current run before rewinding."), {
        statusCode: 409,
      });
    }

    const result = await this.runRewindFiles(sessionId, userMessageId, response.dryRun === true);
    const checkpoint = pending?.checkpoints.find((item) => item.messageId === userMessageId);
    if (response.dryRun !== true) {
      this.pendingRewinds.delete(response.id);
    }
    this.pushEvent("rewind.completed", {
      id: response.id,
      sessionId,
      userMessageId,
      dryRun: response.dryRun === true,
      checkpoint,
      result,
      createdAt: Date.now(),
    });
    this.pushNotice({
      title: response.dryRun === true ? "Rewind preview" : "Rewind files",
      text: formatRewindResult(result, response.dryRun === true, checkpoint?.files),
      sessionId,
    });
  }

  private async runRewindFiles(
    sessionId: string,
    userMessageId: string,
    dryRun: boolean,
  ): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }> {
    const abortController = new AbortController();
    const rewindQuery = query({
      prompt: this.createCapabilityProbeStream(abortController.signal),
      options: {
        cwd: this.opts.cwd,
        pathToClaudeCodeExecutable: this.opts.bin,
        spawnClaudeCodeProcess: spawnClaudeCliProcess,
        env: this.buildEnv(),
        settings: this.opts.hookSettingsPath,
        resume: sessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        forkSession: false,
        enableFileCheckpointing: true,
        abortController,
        includePartialMessages: false,
        forwardSubagentText: false,
      },
    });

    try {
      await rewindQuery.supportedCommands().catch(() => [] as SlashCommand[]);
      return await rewindQuery.rewindFiles(userMessageId, { dryRun });
    } finally {
      abortController.abort();
      try {
        rewindQuery.close?.();
      } catch {}
    }
  }

  async answerPermission(
    id: string,
    approved: boolean,
    reason?: string,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(id);
    if (!pending) {
      throw Object.assign(new Error("permission request not found"), {
        statusCode: 404,
      });
    }
    this.pendingPermissions.delete(id);
    this.pushEvent("permission-resolved", { id, approved });
    const result: PermissionResult = approved
      ? {
          behavior: "allow",
          updatedInput: asRecord(pending.request.input),
          toolUseID: id,
        }
      : {
          behavior: "deny",
          message: reason || "The user rejected this tool use from adit-cloud.",
          toolUseID: id,
        };
    if (pending.request.toolName === EXIT_PLAN_MODE_TOOL) {
      this.pushEvent("plan.approval.resolved", {
        id,
        requestID: id,
        approved,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
      });
    }
    pending.resolve(result);
  }

  async answerQuestion(response: CliQuestionResponse): Promise<void> {
    const pending = this.pendingQuestions.get(response.id);
    if (!pending) {
      const pendingPermission = this.pendingPermissions.get(response.id);
      if (pendingPermission?.request.toolName === ASK_USER_QUESTION_TOOL) {
        this.pendingPermissions.delete(response.id);
        this.resolveAskUserQuestionPermission(response, pendingPermission.request, pendingPermission.resolve);
        return;
      }
      throw Object.assign(new Error("question request not found"), {
        statusCode: 404,
      });
    }
    this.pendingQuestions.delete(response.id);

    this.resolveAskUserQuestionPermission(response, pending.request, pending.resolve);
  }

  private resolveAskUserQuestionPermission(
    response: CliQuestionResponse,
    request: { id: string; input: unknown },
    resolve: (result: PermissionResult) => void,
  ): void {
    if (response.rejected) {
      this.pushEvent("question.rejected", {
        id: response.id,
        requestID: response.id,
      });
      resolve({
        behavior: "deny",
        message: "The user ignored this question from adit-cloud.",
        toolUseID: response.id,
      });
      return;
    }

    const inputRecord = asRecord(request.input);
    const questions = normalizeQuestionInput(inputRecord);
    const answers = buildQuestionAnswerMap(questions, response.answers);
    this.pushEvent("question.replied", {
      id: response.id,
      requestID: response.id,
    });
    resolve({
      behavior: "allow",
      updatedInput: {
        ...inputRecord,
        answers,
      },
      toolUseID: response.id,
    });
  }

  async abort(): Promise<void> {
    if (this.ownerValue !== "web") return;
    await this.finishActiveRunAsAborted({
      errorMessage: "Claude run aborted",
      eventMessage: "Claude run aborted.",
      interruptRemote: true,
    });
  }

  stop(): void {
    this.finishActiveRunAsAborted({
      errorMessage: "Claude provider stopped",
      eventMessage: "Claude provider stopped.",
      interruptRemote: false,
    });
    this.stopCapabilityProbe();
    this.pendingRewinds.clear();
    this.detachReclaimInput();
    try {
      this.local?.kill("SIGTERM");
    } catch {}
    this.local = null;
    this.ownerValue = "stopped";
    this.setThinking(false);
    this.setBusy(false);
    this.emitState();
  }

  private startLocal(extraArgs: string[] = []): void {
    this.detachReclaimInput();
    this.stopCapabilityProbe();
    this.reclaimingToLocal = false;
    this.finishWebPrompts(new Error("local mode active"));
    this.remoteQuery = null;
    this.remoteAbortController = null;
    const args = [
      ...extraArgs,
      ...this.opts.args,
      ...(this.opts.hookSettingsPath ? ["--settings", this.opts.hookSettingsPath] : []),
    ];
    const child = spawnCliProcess(this.opts.bin, args, {
      cwd: this.opts.cwd,
      env: this.buildEnv(),
      stdio: "inherit",
    });
    this.local = child;
    this.ownerValue = "local";
    this.emitState();
    void this.hydrateCapabilities({ owner: "local", child });

    child.on("error", (error) => {
      this.pushEvent("error", { message: error.message });
      process.stderr.write(`\n[adit cloud claude] failed to start Claude CLI: ${error.message}\n`);
      if (this.local === child) {
        this.local = null;
        this.ownerValue = "stopped";
        this.emitState();
        this.emit("exit", { code: null, signal: null });
      }
    });
    child.on("exit", (code, signal) => {
      this.setThinking(false);
      this.setBusy(false);
      if (this.suppressNextLocalExit) {
        this.suppressNextLocalExit = false;
        return;
      }
      if (this.local === child) {
        this.local = null;
        this.ownerValue = "stopped";
        this.emitState();
        this.emit("exit", { code, signal });
      }
    });
  }

  private async hydrateCapabilities(target: CapabilityHydrateTarget): Promise<void> {
    if (!this.isCapabilityHydrateTargetCurrent(target)) return;
    this.stopCapabilityProbe();
    if (!this.isCapabilityHydrateTargetCurrent(target)) return;
    const hydrateGeneration = ++this.capabilityHydrateGeneration;
    const abortController = new AbortController();
    this.capabilityProbeAbortController = abortController;
    const probe = query({
      prompt: this.createCapabilityProbeStream(abortController.signal),
      options: {
        cwd: this.opts.cwd,
        pathToClaudeCodeExecutable: this.opts.bin,
        spawnClaudeCodeProcess: spawnClaudeCliProcess,
        env: this.buildEnv(),
        settings: this.opts.hookSettingsPath,
        permissionMode: "plan",
        forkSession: false,
        abortController,
        includePartialMessages: false,
        forwardSubagentText: false,
      },
    });
    this.capabilityProbeQuery = probe;

    try {
      const [commands, mcpServers] = await Promise.all([
        probe.supportedCommands().catch(() => [] as SlashCommand[]),
        probe.mcpServerStatus().catch(() => []),
      ]);
      if (
        !this.isCapabilityHydrateTargetCurrent(target) ||
        this.capabilityHydrateGeneration !== hydrateGeneration ||
        this.capabilityProbeQuery !== probe
      ) {
        return;
      }
      this.applyClaudeCapabilitySnapshot({
        commands: commands.map(commandInfoFromClaudeSlashCommand),
        mcpServers: mcpServers.map((server) => ({
          name: readString(asRecord(server).name) ?? "",
          status: readString(asRecord(server).status) ?? "unknown",
        })).filter((server) => server.name.length > 0),
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`\n[adit cloud claude] capability hydrate failed: ${message}\n`);
      }
    } finally {
      if (this.capabilityProbeQuery === probe) {
        this.capabilityProbeQuery = null;
      }
      if (this.capabilityProbeAbortController === abortController) {
        this.capabilityProbeAbortController = null;
      }
      abortController.abort();
      try {
        probe.close();
      } catch {}
    }
  }

  private stopCapabilityProbe(): void {
    this.capabilityHydrateGeneration += 1;
    this.capabilityProbeAbortController?.abort();
    try {
      this.capabilityProbeQuery?.close?.();
    } catch {}
    this.capabilityProbeQuery = null;
    this.capabilityProbeAbortController = null;
  }

  private async runRemoteLoop(generation: number): Promise<void> {
    while (this.ownerValue === "web" && this.remoteLoopGeneration === generation) {
      let first: QueuedSdkPrompt | null;
      try {
        first = await this.nextPrompt();
      } catch {
        return;
      }
      if (!first || this.ownerValue !== "web" || this.remoteLoopGeneration !== generation) return;

      this.stopCapabilityProbe();
      const pendingSessionId = first.pendingSessionId;
      const pendingClaudeSessionId = pendingSessionId ? randomUUID() : null;
      const canonicalSessionId = pendingSessionId
        ? pendingClaudeSessionId
        : this.activeSessionId ?? this.resumeSessionId;
      const resumeId = pendingSessionId
        ? null
        : this.pickResumeSessionId({ fallbackToLatest: false });
      this.refreshActiveModel({
        sessionId: canonicalSessionId ?? resumeId,
      });
      const abortController = new AbortController();
      this.remoteAbortController = abortController;
      this.startingPrompt = first;
      this.activePromptEvent = first.promptEvent;
      const permissionMode: PermissionMode = first.mode === "plan" ? "plan" : "bypassPermissions";
      const explicitSessionId = !resumeId && canonicalSessionId && isUuid(canonicalSessionId)
        ? canonicalSessionId
        : undefined;
      const promptInput = new PushableSdkPromptStream(
        toUserMessage(first.message, pendingClaudeSessionId ?? undefined),
      );
      this.activePromptInput = {
        generation,
        displaySessionId: pendingSessionId ?? canonicalSessionId ?? resumeId,
        acceptedSessionIds: new Set(
          [
            pendingSessionId,
            pendingClaudeSessionId,
            canonicalSessionId,
            resumeId,
            this.activeSessionId,
            this.resumeSessionId,
            this.sdkSessionId,
            this.remoteSdkSessionId,
          ].filter((id): id is string => Boolean(id)),
        ),
        stream: promptInput,
      };
      const options: Options = {
        cwd: this.opts.cwd,
        pathToClaudeCodeExecutable: this.opts.bin,
        spawnClaudeCodeProcess: spawnClaudeCliProcess,
        env: this.buildEnv(),
        resume: resumeId ?? undefined,
        sessionId: explicitSessionId,
        settings: this.opts.hookSettingsPath,
        permissionMode,
        ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        forkSession: false,
        enableFileCheckpointing: true,
        abortController,
        includePartialMessages: true,
        forwardSubagentText: true,
        ...(permissionMode === "bypassPermissions"
          ? {}
          : {
              canUseTool: (toolName, input, requestOptions) =>
                this.handleToolPermission(
                  toolName,
                  input,
                  requestOptions.toolUseID,
                  requestOptions.signal,
                ),
            }),
      };

      try {
        this.remoteQuery = query({
          prompt: promptInput,
          options,
        });
        this.setBusy(true);
        this.setThinking(true);
        this.emitState();
        this.scheduleContextUsageRefresh(true);
        this.resolveStartingPrompt(first);
      } catch (error) {
        promptInput.fail(error instanceof Error ? error : new Error(String(error)));
        if (this.activePromptInput?.stream === promptInput) {
          this.activePromptInput = null;
        }
        this.rejectStartingPrompt(first, error instanceof Error ? error : new Error(String(error)));
        if (!(error instanceof AbortError)) {
          const messageText = error instanceof Error ? error.message : String(error);
          this.pushEvent("error", { message: messageText });
          process.stderr.write(`\n[adit cloud claude] SDK error: ${messageText}\n`);
        }
        this.setThinking(false);
        this.setBusy(false);
        this.remoteQuery = null;
        this.remoteAbortController = null;
        continue;
      }

      let observedSdkSessionId: string | null = null;
      try {
        for await (const message of this.remoteQuery) {
          if (this.remoteLoopGeneration !== generation) break;
          const sdkSessionId = this.handleSdkMessage(message, canonicalSessionId ?? resumeId, {
            suppressActiveFallback: Boolean(pendingSessionId),
          });
          this.scheduleContextUsageRefresh(message.type === "result");
          if (message.type === "result") {
            promptInput.close();
          }
          const boundSessionId = sdkSessionId ?? pendingClaudeSessionId;
          if (pendingSessionId && boundSessionId) {
            this.bindPendingSession(pendingSessionId, boundSessionId);
          }
          if (
            sdkSessionId &&
            canonicalSessionId &&
            sdkSessionId !== canonicalSessionId
          ) {
            observedSdkSessionId = sdkSessionId;
          }
        }
      } catch (error) {
        if (this.startingPrompt === first) {
          this.rejectStartingPrompt(first, error instanceof Error ? error : new Error(String(error)));
        }
        if (!(error instanceof AbortError)) {
          const messageText = error instanceof Error ? error.message : String(error);
          this.pushEvent("error", { message: messageText });
          process.stderr.write(`\n[adit cloud claude] SDK error: ${messageText}\n`);
        }
      } finally {
        if (!pendingSessionId) {
          this.mergeRemoteTranscriptsIntoActive(canonicalSessionId, observedSdkSessionId);
        }
        if (this.activePromptEvent === first.promptEvent) {
          this.activePromptEvent = null;
        }
        if (this.startingPrompt === first) {
          this.rejectStartingPrompt(first, new Error("Claude run ended before it started"));
        }
        promptInput.close();
        if (this.activePromptInput?.stream === promptInput) {
          this.activePromptInput = null;
        }
        this.setThinking(false);
        this.setBusy(false);
        this.remoteQuery = null;
        this.remoteAbortController = null;
      }
    }
  }

  private isCapabilityHydrateTargetCurrent(target: CapabilityHydrateTarget): boolean {
    if (target.owner === "web") {
      return this.ownerValue === "web" && this.remoteLoopGeneration === target.generation;
    }
    return this.ownerValue === "local" && this.local === target.child;
  }

  private async *createCapabilityProbeStream(
    signal: AbortSignal,
  ): AsyncIterable<SDKUserMessage> {
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  private nextPrompt(): Promise<QueuedSdkPrompt | null> {
    if (this.promptQueue.length > 0) {
      const item = this.promptQueue.shift();
      if (!item) return Promise.resolve(null);
      return Promise.resolve({
        message: item.message,
        mode: item.mode,
        pendingSessionId: item.pendingSessionId,
        localMessageId: item.localMessageId,
        promptEvent: item.promptEvent,
        resolve: item.resolve,
        reject: item.reject,
      });
    }
    return new Promise((resolve) => {
      this.promptResolvers.push(resolve);
    });
  }

  private drainPromptResolvers(): void {
    while (this.promptResolvers.length > 0 && this.promptQueue.length > 0) {
      const resolve = this.promptResolvers.shift();
      const item = this.promptQueue.shift();
      if (!resolve || !item) return;
      resolve({
        message: item.message,
        mode: item.mode,
        pendingSessionId: item.pendingSessionId,
        localMessageId: item.localMessageId,
        promptEvent: item.promptEvent,
        resolve: item.resolve,
        reject: item.reject,
      });
    }
  }

  private finishWebPrompts(error: Error): void {
    this.activePromptEvent = null;
    this.activePromptInput?.stream.close();
    this.activePromptInput = null;
    if (this.startingPrompt) {
      this.startingPrompt.reject(error);
      this.startingPrompt = null;
    }
    for (const item of this.promptQueue.splice(0)) {
      item.reject(error);
    }
    for (const resolve of this.promptResolvers.splice(0)) {
      resolve(null);
    }
    this.pendingRewinds.clear();
  }

  private resolveStartingPrompt(prompt: QueuedSdkPrompt): void {
    if (this.startingPrompt !== prompt) return;
    this.startingPrompt = null;
    prompt.resolve();
  }

  private rejectStartingPrompt(prompt: QueuedSdkPrompt, error: Error): void {
    if (this.startingPrompt !== prompt) return;
    this.startingPrompt = null;
    prompt.reject(error);
  }

  private rejectPendingRequests(error: Error): void {
    const hadPendingRequests = this.pendingPermissions.size > 0 || this.pendingQuestions.size > 0;
    for (const pending of this.pendingPermissions.values()) {
      this.emitPendingToolError(pending.request, error.message);
      pending.reject(error);
    }
    this.pendingPermissions.clear();
    for (const pending of this.pendingQuestions.values()) {
      this.emitPendingToolError({
        id: pending.request.id,
        toolName: ASK_USER_QUESTION_TOOL,
        input: pending.request.input,
        createdAt: pending.request.createdAt,
      }, error.message);
      pending.reject(error);
    }
    this.pendingQuestions.clear();
    if (!hadPendingRequests) return;
    this.pushEvent("permission-resolved", { id: "all", approved: false });
    this.pushEvent("question.rejected", { id: "all" });
  }

  private emitPendingToolError(
    request: CliPermissionRequest & { toolName: string },
    message: string,
  ): void {
    const sessionId = this.activeSessionId ??
      this.resumeSessionId ??
      this.sdkSessionId ??
      this.remoteSdkSessionId;
    const createdAt = Date.now();
    this.pushEvent("tool", {
      ...(sessionId ? { sessionId } : {}),
      messageId: sessionId
        ? this.lastAssistantMessageBySession.get(sessionId) ?? `cli-tool-${request.id}`
        : `cli-tool-${request.id}`,
      toolUseId: request.id,
      toolName: request.toolName,
      input: request.input && typeof request.input === "object" && !Array.isArray(request.input)
        ? request.input
        : {},
      error: message,
      status: "error",
      createdAt,
    });
  }

  private currentRunSessionId(): string | null {
    return this.activeSessionId ??
      this.resumeSessionId ??
      this.sdkSessionId ??
      this.remoteSdkSessionId ??
      this.activePromptInput?.displaySessionId ??
      null;
  }

  private hasActiveWebRun(): boolean {
    return this.ownerValue === "web" && (
      this.busyValue ||
      this.thinkingValue ||
      this.remoteQuery !== null ||
      this.remoteAbortController !== null ||
      this.activePromptInput !== null ||
      this.activePromptEvent !== null ||
      this.startingPrompt !== null ||
      this.pendingPermissions.size > 0 ||
      this.pendingQuestions.size > 0
    );
  }

  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptRemote: false;
  }): void;
  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptRemote: true;
  }): Promise<void>;
  private finishActiveRunAsAborted(input: {
    errorMessage: string;
    eventMessage: string;
    interruptRemote: boolean;
  }): void | Promise<void> {
    const sessionId = this.currentRunSessionId();
    const hadActiveRun = this.hasActiveWebRun();
    const remoteQuery = this.remoteQuery;
    const error = new Error(input.errorMessage);

    this.finishWebPrompts(error);
    this.rejectPendingRequests(error);
    this.remoteAbortController?.abort();
    this.remoteQuery = null;
    this.remoteAbortController = null;
    this.setThinking(false);
    this.setBusy(false);

    const emitAbortEvent = () => {
      if (!hadActiveRun) return;
      this.pushEvent("run.aborted", {
        message: input.eventMessage,
        ...(sessionId ? { sessionId } : {}),
        createdAt: Date.now(),
      });
    };

    if (!input.interruptRemote) {
      try {
        remoteQuery?.close?.();
      } catch {}
      emitAbortEvent();
      return;
    }

    return (async () => {
      try {
        await remoteQuery?.interrupt?.();
      } catch {}
      try {
        remoteQuery?.close?.();
      } catch {}
      emitAbortEvent();
    })();
  }

  private acceptsSteerSessionId(
    sessionIdInput: string,
    input: ActiveClaudePromptInput,
  ): boolean {
    const sessionId = sessionIdInput.trim();
    if (!sessionId) return true;
    if (sessionId.startsWith("pending_")) return true;
    if (input.acceptedSessionIds.has(sessionId)) return true;
    return [
      this.activeSessionId,
      this.resumeSessionId,
      this.sdkSessionId,
      this.remoteSdkSessionId,
    ].some((id) => id === sessionId);
  }

  private handleSdkMessage(
    message: SDKMessage,
    canonicalSessionId: string | null,
    opts: { suppressActiveFallback?: boolean } = {},
  ): string | null {
    const sdkSessionId = extractSessionId(message);
    if (sdkSessionId) {
      this.noteSdkSession(sdkSessionId, {
        keepActiveSession: Boolean(canonicalSessionId && sdkSessionId !== canonicalSessionId),
      });
    }
    const sessionId =
      (opts.suppressActiveFallback ? sdkSessionId : null) ??
      canonicalSessionId ??
      (opts.suppressActiveFallback ? null : this.activeSessionId) ??
      (opts.suppressActiveFallback ? null : this.resumeSessionId) ??
      sdkSessionId ??
      "pending";
    if (sdkSessionId) this.flushActivePromptEvent(sessionId);
    const messageModelId = extractModelId(message);
    if (messageModelId) this.activeModelId = messageModelId;
    this.emitState();

    if (message.type === "system" && (message as SDKSystemMessage).subtype === "init") {
      const init = message as SDKSystemMessage;
      this.updateClaudeCapabilities(init);
      if (init.session_id) {
        this.noteSdkSession(init.session_id, {
          keepActiveSession: Boolean(canonicalSessionId && init.session_id !== canonicalSessionId),
        });
        this.flushActivePromptEvent(sessionId);
      }
      return sdkSessionId;
    }

    if (message.type === "assistant") {
      this.emitAssistantMessage(message as SDKAssistantMessage, sessionId);
      return sdkSessionId;
    }

    if (message.type === "user") {
      this.emitToolResults(message as SDKUserMessage, sessionId);
      return sdkSessionId;
    }

    if (message.type === "result") {
      this.emitResultUsage(message, sessionId);
    }
    return sdkSessionId;
  }

  private updateClaudeCapabilities(init: SDKSystemMessage): void {
    const commands = Array.isArray(init.slash_commands)
      ? init.slash_commands
          .filter((command): command is string => typeof command === "string" && command.trim().length > 0)
          .map((command) => commandInfoFromClaudeSlashName(command.trim().replace(/^\//, "")))
      : [];
    this.applyClaudeCapabilitySnapshot({
      commands,
      mcpServers: Array.isArray(init.mcp_servers)
        ? init.mcp_servers
            .map((server) => ({
              name: typeof server.name === "string" ? server.name : "",
              status: typeof server.status === "string" ? server.status : "unknown",
            }))
            .filter((server) => server.name.length > 0)
        : [],
      skills: Array.isArray(init.skills)
        ? init.skills.filter((skill): skill is string => typeof skill === "string" && skill.length > 0)
        : [],
    });
  }

  private applyClaudeCapabilitySnapshot(input: {
    commands?: CliSlashCommandInfo[];
    mcpServers?: Array<{ name: string; status: string }>;
    skills?: string[];
  }): void {
    if (input.mcpServers) this.mcpServers = input.mcpServers;
    if (input.skills) this.skills = input.skills;
    if (input.commands !== undefined) {
      this.slashCommandsByName = new Map(
        withClaudeCloudNativeSlashCommands(input.commands)
          .map((command) => [command.name.toLowerCase(), command]),
      );
    }
    this.emitSlashCommands();
  }

  private emitSlashCommands(): void {
    const commands = Array.from(this.slashCommandsByName.values());
    this.pushEvent("slash-commands", {
      provider: this.provider,
      commands,
      createdAt: Date.now(),
    });
  }

  private noteSdkSession(id: string, opts: { keepActiveSession?: boolean } = {}): void {
    if (!id) return;
    const nextActiveSessionId = opts.keepActiveSession
      ? this.activeSessionId ?? this.resumeSessionId
      : id;
    const nextResumeSessionId = opts.keepActiveSession
      ? this.resumeSessionId ?? this.activeSessionId
      : id;
    const changed =
      this.sdkSessionId !== id ||
      this.remoteSdkSessionId !== id ||
      this.activeSessionId !== nextActiveSessionId ||
      this.resumeSessionId !== nextResumeSessionId;
    this.sdkSessionId = id;
    this.remoteSdkSessionId = id;
    this.activeSessionId = nextActiveSessionId;
    this.resumeSessionId = nextResumeSessionId;
    this.applyStoredContextUsageForSession(nextActiveSessionId ?? id);
    if (nextActiveSessionId) {
      this.rememberRemoteSdkSession(nextActiveSessionId, id);
    }
    this.refreshActiveModel({ sessionId: id });
    if (changed) this.emitState();
  }

  private bindPendingSession(pendingSessionId: string, sessionId: string): void {
    if (!pendingSessionId || !sessionId) return;
    const changed =
      this.activeSessionId !== sessionId ||
      this.resumeSessionId !== sessionId ||
      this.sdkSessionId !== sessionId ||
      this.remoteSdkSessionId !== sessionId;
    this.activeSessionId = sessionId;
    this.resumeSessionId = sessionId;
    this.sdkSessionId = sessionId;
    this.remoteSdkSessionId = sessionId;
    this.applyStoredContextUsageForSession(sessionId);
    this.refreshActiveModel({ sessionId });
    if (!this.boundPendingSessionIds.has(pendingSessionId)) {
      this.boundPendingSessionIds.add(pendingSessionId);
      this.pushEvent("session-bound", {
        pendingSessionId,
        sessionId,
        createdAt: Date.now(),
      });
    }
    if (changed) this.emitState();
  }

  private flushActivePromptEvent(sessionId: string): void {
    if (!this.activePromptEvent) return;
    const prompt = this.activePromptEvent;
    this.activePromptEvent = null;
    this.pushEvent("message", {
      role: "user",
      sessionId,
      ...(prompt.messageId ? { messageId: prompt.messageId } : {}),
      text: prompt.text,
      createdAt: prompt.createdAt,
    });
  }

  private emitAssistantMessage(message: SDKAssistantMessage, sessionId: string): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    const messageId = makeMessageId(message, sessionId);
    const parentToolUseId = readString((message as { parent_tool_use_id?: unknown }).parent_tool_use_id);
    const modelId = typeof message.message?.model === "string"
      ? message.message.model
      : undefined;
    if (modelId) this.activeModelId = modelId;
    const usage = normalizeClaudeUsage((message.message as { usage?: unknown }).usage);
    this.lastAssistantMessageBySession.set(sessionId, messageId);
    for (const part of content as unknown as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        this.pushEvent("message", {
          role: "assistant",
          sessionId,
          messageId,
          modelId,
          usage,
          text: part.text,
          createdAt: Date.now(),
        });
      } else if (
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        part.thinking
      ) {
        this.pushEvent("reasoning", {
          sessionId,
          messageId,
          modelId,
          usage,
          text: part.thinking,
          createdAt: Date.now(),
        });
      } else if (part.type === "tool_use" || part.type === "server_tool_use") {
        const createdAt = Date.now();
        const toolUseId = typeof part.id === "string" ? part.id : undefined;
        const toolName = typeof part.name === "string" ? part.name : "tool";
        const input = part.input ?? {};
        this.pushEvent("tool", {
          sessionId,
          messageId,
          modelId,
          usage,
          toolUseId,
          toolName,
          input,
          status: "running",
          createdAt,
        });
        if (toolName === TODO_WRITE_TOOL) {
          this.emitTodoWrite({
            sessionId,
            messageId,
            toolUseId,
            parentToolUseId,
            input,
            createdAt,
          });
        }
      }
    }
  }

  private emitTodoWrite(input: {
    sessionId: string;
    messageId: string;
    toolUseId?: string;
    parentToolUseId: string | null;
    input: unknown;
    createdAt: number;
  }): void {
    const todos = normalizeClaudeTodoWriteInput(input.input);
    if (!todos) return;
    this.pushEvent("todos.updated", {
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolUseId: input.toolUseId,
      parentToolUseId: input.parentToolUseId,
      scopeId: input.parentToolUseId ?? "main",
      todos,
      createdAt: input.createdAt,
    });
  }

  private emitResultUsage(message: SDKMessage, fallbackSessionId: string): void {
    const result = message as {
      session_id?: unknown;
      sessionId?: unknown;
      usage?: unknown;
      total_cost_usd?: unknown;
    };
    const usage = normalizeClaudeUsage(result.usage);
    if (!usage) return;
    const sessionId = fallbackSessionId ||
      (typeof result.session_id === "string"
        ? result.session_id
        : typeof result.sessionId === "string"
          ? result.sessionId
          : fallbackSessionId);
    this.pushEvent("usage", {
      sessionId,
      messageId: this.lastAssistantMessageBySession.get(sessionId),
      usage,
      cost: typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd)
        ? result.total_cost_usd
        : undefined,
      createdAt: Date.now(),
    });
  }

  private emitToolResults(message: SDKUserMessage, sessionId: string): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    const messageId = makeMessageId(message, sessionId);
    for (const part of content as unknown as Array<Record<string, unknown>>) {
      if (part.type !== "tool_result") continue;
      const toolUseId = typeof part.tool_use_id === "string"
        ? part.tool_use_id
        : typeof part.toolUseID === "string"
          ? part.toolUseID
          : "tool";
      this.pushEvent("tool", {
        sessionId,
        messageId,
        toolUseId,
        toolName: "tool",
        input: {},
        output: formatToolResult(part.content),
        status: "completed",
        createdAt: Date.now(),
      });
    }
  }

  private handleToolPermission(
    toolName: string,
    input: unknown,
    id: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    if (toolName === ASK_USER_QUESTION_TOOL) {
      return this.handleUserQuestion(input, id, signal);
    }
    if (toolName === EXIT_PLAN_MODE_TOOL) {
      return this.handlePlanApproval(input, id, signal);
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      const request: CliPermissionRequest = {
        id,
        toolName,
        input,
        createdAt: Date.now(),
      };
      const abort = () => {
        this.pendingPermissions.delete(id);
        this.pushEvent("permission-resolved", { id, approved: false });
        this.emitPendingToolError(request, "Permission request aborted.");
        reject(new Error("permission request aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingPermissions.set(id, {
        request,
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.pushEvent("permission", {
        id,
        toolName,
        input,
        createdAt: request.createdAt,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
      });
      this.emitState();
    });
  }

  private handlePlanApproval(
    input: unknown,
    id: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      const request: CliPermissionRequest = {
        id,
        toolName: EXIT_PLAN_MODE_TOOL,
        input,
        createdAt: Date.now(),
      };
      const abort = () => {
        this.pendingPermissions.delete(id);
        this.pushEvent("permission-resolved", { id, approved: false });
        this.pushEvent("plan.approval.resolved", {
          id,
          requestID: id,
          approved: false,
          sessionId: this.activeSessionId ?? this.resumeSessionId,
        });
        this.emitPendingToolError(request, "Plan approval request aborted.");
        reject(new Error("plan approval request aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingPermissions.set(id, {
        request,
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      const inputRecord = asRecord(input);
      this.pushEvent("plan.approval.requested", {
        id,
        requestID: id,
        sessionID: this.activeSessionId ?? this.resumeSessionId,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
        input: inputRecord,
        plan: readString(inputRecord.plan),
        allowedPrompts: Array.isArray(inputRecord.allowedPrompts)
          ? inputRecord.allowedPrompts
          : undefined,
        tool: {
          messageID: this.lastAssistantMessageBySession.get(this.activeSessionId ?? this.resumeSessionId ?? "") ?? "",
          callID: id,
        },
        createdAt: request.createdAt,
      });
      this.pushEvent("permission", {
        id,
        toolName: EXIT_PLAN_MODE_TOOL,
        input,
        createdAt: request.createdAt,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
      });
      this.emitState();
    });
  }

  private handleUserQuestion(
    input: unknown,
    id: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const inputRecord = asRecord(input);
    const questions = normalizeQuestionInput(inputRecord);
    if (questions.length === 0) {
      return Promise.resolve({
        behavior: "deny",
        message: "AskUserQuestion did not include any valid questions.",
        toolUseID: id,
      });
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      const request: CliQuestionRequest = {
        id,
        input: inputRecord,
        createdAt: Date.now(),
      };
      const abort = () => {
        this.pendingQuestions.delete(id);
        this.pushEvent("question.rejected", {
          id,
          requestID: id,
          sessionId: this.activeSessionId ?? this.resumeSessionId,
        });
        this.emitPendingToolError({
          id,
          toolName: ASK_USER_QUESTION_TOOL,
          input: inputRecord,
          createdAt: request.createdAt,
        }, "Question request aborted.");
        reject(new Error("question request aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pendingQuestions.set(id, {
        request,
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.pushEvent("question.asked", {
        id,
        sessionID: this.activeSessionId ?? this.resumeSessionId,
        sessionId: this.activeSessionId ?? this.resumeSessionId,
        questions,
        tool: {
          messageID: this.lastAssistantMessageBySession.get(this.activeSessionId ?? this.resumeSessionId ?? "") ?? "",
          callID: id,
        },
        createdAt: request.createdAt,
      });
      this.emitState();
    });
  }

  private attachReclaimInput(): void {
    if (this.reclaimAttached || !process.stdin.isTTY) return;
    this.reclaimAttached = true;
    this.reclaimBuffer = "";
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.on("data", this.onReclaimInput);
    } catch {
      this.reclaimAttached = false;
    }
  }

  private detachReclaimInput(): void {
    if (!this.reclaimAttached) return;
    this.reclaimAttached = false;
    process.stdin.off("data", this.onReclaimInput);
    this.reclaimBuffer = "";
    try {
      process.stdin.pause();
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
    } catch {}
  }

  private onReclaimInput = (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text === "\u0003") {
      this.stop();
      return;
    }
    this.reclaimBuffer += text;
    if (this.reclaimBuffer.length > 200) {
      this.reclaimBuffer = this.reclaimBuffer.slice(-200);
    }
    if (this.reclaimBuffer.includes(RECLAIM_COMMAND)) {
      this.reclaimBuffer = "";
      void this.releaseToLocal();
      return;
    }
    if (text.includes("\n") || text.includes("\r")) {
      process.stderr.write(
        `[adit cloud claude] Web owns this session. Type ${RECLAIM_COMMAND} to reclaim.\n`,
      );
    }
  };

  private pickResumeSessionId(opts: { fallbackToLatest: boolean }): string | null {
    const candidates = [
      this.resumeSessionId,
      this.activeSessionId,
      this.remoteSdkSessionId,
      this.sdkSessionId,
    ];
    for (const id of candidates) {
      if (id && isValidClaudeSession(id, this.opts.cwd)) {
        this.resumeSessionId = id;
        this.activeSessionId = id;
        this.refreshActiveModel({ sessionId: id });
        return id;
      }
    }
    if (!opts.fallbackToLatest) return null;
    const latest = findLastClaudeSession(this.opts.cwd);
    if (latest) {
      this.resumeSessionId = latest;
      this.activeSessionId = latest;
      this.refreshActiveModel({ sessionId: latest });
      this.emitState();
      return latest;
    }
    this.resumeSessionId = null;
    return null;
  }

  private setBusy(value: boolean): void {
    if (this.busyValue === value) return;
    this.busyValue = value;
    this.emitState();
  }

  private setThinking(value: boolean): void {
    if (this.thinkingValue === value) return;
    this.thinkingValue = value;
    this.emitState();
  }

  private scheduleBranchRefresh(force = false): void {
    const now = Date.now();
    if (this.branchRefreshPromise) return;
    if (!force && now - this.branchRefreshAt < BRANCH_REFRESH_INTERVAL_MS) return;
    this.branchRefreshAt = now;
    this.branchRefreshPromise = getCurrentBranch(this.opts.cwd)
      .then((branch) => {
        const nextBranch = readString(branch);
        if (this.currentBranch === nextBranch) return;
        this.currentBranch = nextBranch;
        this.emitState();
      })
      .catch(() => undefined)
      .finally(() => {
        this.branchRefreshPromise = null;
      });
  }

  private scheduleContextUsageRefresh(force = false): void {
    if (this.ownerValue !== "web" || !this.remoteQuery) return;
    const queryWithUsage = this.remoteQuery as Query & {
      getContextUsage?: () => Promise<unknown>;
    };
    if (typeof queryWithUsage.getContextUsage !== "function") return;

    const now = Date.now();
    if (this.contextUsageRefreshPromise) return;
    if (!force && now - this.contextUsageRefreshAt < CONTEXT_USAGE_REFRESH_INTERVAL_MS) return;
    this.contextUsageRefreshAt = now;
    const sessionId = this.currentContextUsageSessionId();
    this.contextUsageRefreshPromise = queryWithUsage.getContextUsage()
      .then((rawUsage) => {
        const usage = normalizeClaudeContextUsage(rawUsage, this.activeModelId);
        if (!usage) return;
        const previousUsage = sessionId
          ? this.contextUsageBySession.get(sessionId) ?? null
          : this.contextUsage;
        if (isSameContextUsage(previousUsage, usage)) return;
        if (sessionId) this.contextUsageBySession.set(sessionId, usage);
        if (!sessionId || sessionId === this.currentContextUsageSessionId()) {
          this.contextUsage = usage;
          this.emitState();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.contextUsageRefreshPromise = null;
      });
  }

  private emitState(): void {
    this.emit("state", this.state);
    this.pushEvent("state", {
      sessionId: this.activeSessionId ?? this.resumeSessionId,
      owner: this.ownerValue,
      busy: this.busyValue,
      thinking: this.thinkingValue,
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      sdkSessionId: this.sdkSessionId,
      activeModelId: this.activeModelId,
      currentBranch: this.currentBranch,
      contextUsage: this.contextUsage,
      lastTokenUsage: null,
      createdAt: Date.now(),
    });
  }

  private pushEvent(type: string, payload: Record<string, unknown>): void {
    this.opts.onEvent?.({ type, payload });
  }

  private pushNotice(input: {
    title: string;
    text: string;
    sessionId?: string | null;
    data?: Record<string, unknown>;
  }): void {
    this.pushEvent("notice", {
      title: input.title,
      text: input.text,
      sessionId: input.sessionId ?? this.activeSessionId ?? this.resumeSessionId,
      ...(input.data ?? {}),
      createdAt: Date.now(),
    });
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return buildClaudeCloudRelayEnv();
  }

  private currentContextUsageSessionId(): string | null {
    return this.activeSessionId ?? this.resumeSessionId ?? this.sdkSessionId ?? this.remoteSdkSessionId;
  }

  private applyStoredContextUsageForSession(sessionId: string | null): void {
    this.contextUsage = sessionId ? this.contextUsageBySession.get(sessionId) ?? null : null;
  }

  private refreshActiveModel(opts: { sessionId?: string | null } = {}): string | null {
    const modelId = resolveClaudeModel({
      cwd: this.opts.cwd,
      sessionId: opts.sessionId ?? this.activeSessionId ?? this.resumeSessionId,
    });
    if (modelId && modelId !== this.activeModelId) {
      this.activeModelId = modelId;
    }
    return this.activeModelId;
  }

  private rememberRemoteSdkSession(
    activeSessionId: string,
    sdkSessionId: string,
  ): void {
    if (!activeSessionId || !sdkSessionId || activeSessionId === sdkSessionId) return;
    let ids = this.remoteSdkSessionIdsByActiveSession.get(activeSessionId);
    if (!ids) {
      ids = new Set<string>();
      this.remoteSdkSessionIdsByActiveSession.set(activeSessionId, ids);
    }
    ids.add(sdkSessionId);
  }

  private mergeRemoteTranscriptsIntoActive(
    activeSessionId: string | null = this.activeSessionId,
    remoteSessionId: string | null = this.remoteSdkSessionId ?? this.sdkSessionId,
  ): void {
    if (!activeSessionId) return;
    const remoteSessionIds = new Set<string>();
    const remembered = this.remoteSdkSessionIdsByActiveSession.get(activeSessionId);
    if (remembered) {
      for (const id of remembered) remoteSessionIds.add(id);
    }
    if (remoteSessionId) remoteSessionIds.add(remoteSessionId);
    if (this.remoteSdkSessionId) remoteSessionIds.add(this.remoteSdkSessionId);
    if (this.sdkSessionId) remoteSessionIds.add(this.sdkSessionId);

    for (const id of remoteSessionIds) {
      if (!id || id === activeSessionId) continue;
      mergeClaudeSessionTranscript({
        cwd: this.opts.cwd,
        sourceSessionId: id,
        targetSessionId: activeSessionId,
      });
    }
  }
}

export function buildClaudeCloudRelayEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    TERM: baseEnv.TERM || "xterm-256color",
    COLORTERM: baseEnv.COLORTERM || "truecolor",
    FORCE_COLOR: baseEnv.FORCE_COLOR || "3",
    DISABLE_AUTOUPDATER: "1",
    // Cloud Coding persists live conversation state through the relay websocket.
    // Inherited ADIT hooks should keep their local timeline data until normal sync.
    ...CLAUDE_CLOUD_RELAY_ADIT_ENV,
  };
}

class PushableSdkPromptStream implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[];
  private waiter: {
    resolve: (result: IteratorResult<SDKUserMessage>) => void;
    reject: (error: Error) => void;
  } | null = null;
  private closed = false;
  private error: Error | null = null;

  constructor(first: SDKUserMessage) {
    this.queue = [first];
  }

  push(message: SDKUserMessage): void {
    if (this.error) throw this.error;
    if (this.closed) throw new Error("Claude prompt stream is closed");
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const nextMessage = this.queue.shift();
    if (nextMessage) return Promise.resolve({ value: nextMessage, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

function toUserMessage(
  message: string,
  sessionId?: string,
  opts: { priority?: SDKUserMessage["priority"]; shouldQuery?: boolean } = {},
): SDKUserMessage {
  return {
    type: "user",
    ...(sessionId ? { session_id: sessionId } : {}),
    parent_tool_use_id: null,
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(typeof opts.shouldQuery === "boolean" ? { shouldQuery: opts.shouldQuery } : {}),
    message: {
      role: "user",
      content: message,
    },
  };
}

function readClaudeRewindCheckpoints(
  cwd: string,
  sessionId: string,
  limit: number,
): ClaudeRewindCheckpoint[] {
  const file = path.join(getClaudeProjectDir(cwd), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const snapshots = new Map<string, number>();
  const checkpoints: ClaudeRewindCheckpoint[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(value);
    const type = readString(record.type);

    if (type === "file-history-snapshot") {
      const snapshot = asRecord(record.snapshot);
      const messageId = readString(snapshot.messageId);
      if (!messageId) continue;
      const backups = asRecord(snapshot.trackedFileBackups);
      snapshots.set(messageId, Object.keys(backups).length);
      continue;
    }

    if (type !== "user" || record.isSidechain === true || record.isMeta === true) continue;
    const message = asRecord(record.message);
    if (message.role !== "user") continue;
    const messageId = readString(record.uuid);
    if (!messageId) continue;
    const preview = previewClaudeUserContent(message.content);
    if (!preview) continue;
    const timestamp = Date.parse(readString(record.timestamp) ?? "") || Date.now();
    checkpoints.push({
      messageId,
      preview,
      timestamp,
      label: new Date(timestamp).toLocaleString(),
      files: snapshots.get(messageId) ?? 0,
    });
  }

  return checkpoints
    .map((checkpoint) => ({
      ...checkpoint,
      files: snapshots.get(checkpoint.messageId) ?? checkpoint.files,
    }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

function previewClaudeUserContent(content: unknown): string {
  const raw = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => readString(asRecord(part).text))
          .filter((part): part is string => Boolean(part))
          .join("\n")
      : "";
  if (!raw.trim()) return "";

  const commandName = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (commandName) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return truncatePlain(`${commandName}${args ? ` ${args}` : ""}`, 160);
  }

  return truncatePlain(raw.replace(/<[^>]+>/g, " "), 160);
}

function truncatePlain(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatRewindResult(
  result: {
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  },
  dryRun: boolean,
  fallbackFileCount?: number,
): string {
  if (result.error) return `Rewind failed: ${result.error}`;
  if (!result.canRewind) {
    return "Claude Code reported that this checkpoint cannot be rewound.";
  }

  const fileCount = Array.isArray(result.filesChanged)
    ? result.filesChanged.length
    : Math.max(0, Math.floor(fallbackFileCount ?? 0));
  const summary = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  const stats = [
    Number.isFinite(result.insertions) ? `${result.insertions} insertions` : null,
    Number.isFinite(result.deletions) ? `${result.deletions} deletions` : null,
  ].filter(Boolean).join(", ");
  const detail = stats ? ` (${stats})` : "";
  if (dryRun) {
    return `Preview only: rewinding to the selected message would change ${summary}${detail}.`;
  }
  return `Rewound files to the selected message. Changed ${summary}${detail}. Conversation history is unchanged.`;
}

function extractSessionId(message: SDKMessage): string | null {
  const maybe = message as { session_id?: unknown; sessionId?: unknown };
  if (typeof maybe.session_id === "string") return maybe.session_id;
  if (typeof maybe.sessionId === "string") return maybe.sessionId;
  return null;
}

function extractModelId(message: SDKMessage): string | null {
  const maybe = message as {
    model?: unknown;
    message?: { model?: unknown };
  };
  if (typeof maybe.message?.model === "string" && maybe.message.model.trim()) {
    return maybe.message.model.trim();
  }
  if (typeof maybe.model === "string" && maybe.model.trim()) {
    return maybe.model.trim();
  }
  return null;
}

function makeMessageId(message: SDKMessage, sessionId: string): string {
  const maybe = message as { uuid?: unknown; message?: { id?: unknown } };
  if (typeof maybe.message?.id === "string") return maybe.message.id;
  if (typeof maybe.uuid === "string") return maybe.uuid;
  return `claude-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeClaudeUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_tokens",
  ]) {
    const numberValue = usage[key];
    if (typeof numberValue === "number" && Number.isFinite(numberValue)) {
      normalized[key] = numberValue;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeClaudeContextUsage(
  value: unknown,
  fallbackModelId: string | null,
): CliAgentContextUsage | null {
  const usage = asRecord(value);
  const totalTokens = readNumber(usage.totalTokens);
  const maxTokens = readNumber(usage.maxTokens);
  if (totalTokens === null || maxTokens === null || maxTokens <= 0) return null;
  const rawPercentage = readNumber(usage.percentage) ?? totalTokens / maxTokens * 100;
  return {
    percentage: Math.max(0, Math.min(100, rawPercentage)),
    totalTokens: Math.max(0, Math.floor(totalTokens)),
    maxTokens: Math.floor(maxTokens),
    modelId: readString(usage.model) ?? fallbackModelId,
    updatedAt: Date.now(),
    source: "claude-sdk",
  };
}

function isSameContextUsage(
  current: CliAgentContextUsage | null,
  next: CliAgentContextUsage,
): boolean {
  return Boolean(
    current &&
      current.percentage === next.percentage &&
      current.totalTokens === next.totalTokens &&
      current.maxTokens === next.maxTokens &&
      current.modelId === next.modelId,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeQuestionInput(input: Record<string, unknown>): Array<{
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
}> {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
  }> = [];

  for (const rawQuestion of rawQuestions) {
    const questionRecord = asRecord(rawQuestion);
    const question = readString(questionRecord.question);
    if (!question) continue;
    const options = (Array.isArray(questionRecord.options) ? questionRecord.options : [])
      .map((rawOption) => {
        const optionRecord = asRecord(rawOption);
        const label = readString(optionRecord.label);
        if (!label) return null;
        return {
          label,
          description: readString(optionRecord.description) ?? "",
        };
      })
      .filter((option): option is { label: string; description: string } => Boolean(option));
    if (options.length === 0) continue;
    questions.push({
      question,
      header: readString(questionRecord.header) ?? "Question",
      options,
      multiple: questionRecord.multiSelect === true,
    });
  }

  return questions;
}

function buildQuestionAnswerMap(
  questions: Array<{ question: string }>,
  answers: string[][],
): Record<string, string> {
  const result: Record<string, string> = {};
  questions.forEach((question, index) => {
    const answer = answers[index] ?? [];
    result[question.question] = answer.filter(Boolean).join(", ");
  });
  return result;
}

function formatToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function commandInfoFromClaudeSlashName(name: string): CliSlashCommandInfo {
  const normalized = name.trim().replace(/^\//, "");
  const description = describeClaudeSlashCommand(normalized.toLowerCase());
  return {
    name: normalized,
    ...(description ? { description } : {}),
  };
}

function commandInfoFromClaudeSlashCommand(command: SlashCommand): CliSlashCommandInfo {
  const name = command.name.trim().replace(/^\//, "");
  const description = command.description?.trim() || describeClaudeSlashCommand(name.toLowerCase());
  return {
    name,
    ...(description ? { description } : {}),
    argumentHint: command.argumentHint || undefined,
    aliases: command.aliases,
  };
}

function withClaudeCloudNativeSlashCommands(commands: CliSlashCommandInfo[]): CliSlashCommandInfo[] {
  const merged = new Map<string, CliSlashCommandInfo>();
  for (const command of commands) {
    const name = command.name.trim().replace(/^\//, "");
    if (!name) continue;
    merged.set(name.toLowerCase(), { ...command, name });
  }
  for (const name of CLAUDE_CLOUD_NATIVE_SLASH_COMMANDS) {
    if (!merged.has(name)) {
      merged.set(name, commandInfoFromClaudeSlashName(name));
    }
  }
  return Array.from(merged.values());
}

function describeClaudeSlashCommand(name: string): string | undefined {
  switch (name) {
    case "compact":
      return "Compact the current Claude Code conversation";
    case "mcp":
      return "Show Claude MCP server status";
    case "skills":
      return "Show Claude skills and slash commands";
    case "rewind":
      return "Rewind Claude Code files when checkpointing is available";
    case "btw":
      return "Send a Claude Code by-the-way note";
    case "memory":
      return "Open Claude Code memory command";
    default:
      return undefined;
  }
}

function formatClaudeMcpServers(servers: Array<{ name: string; status: string }>): string {
  if (servers.length === 0) {
    return "Claude Code has not reported any MCP servers for this Cloud session.";
  }
  return servers
    .map((server) => `- ${server.name}: ${server.status}`)
    .join("\n");
}

function formatClaudeSkills(
  skills: string[],
  commands: Map<string, CliSlashCommandInfo>,
): string {
  const parts: string[] = [];
  if (skills.length > 0) {
    parts.push(`Skills:\n${skills.map((skill) => `- ${skill}`).join("\n")}`);
  }
  const commandList = Array.from(commands.values());
  if (commandList.length > 0) {
    parts.push(`Slash commands:\n${commandList.map((command) => `- /${command.name}`).join("\n")}`);
  }
  return parts.join("\n\n") || "Claude Code has not reported any skills or slash commands for this Cloud session.";
}

function getClaudeProjectDir(cwd: string): string {
  const projectId = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return path.join(claudeConfigDir, "projects", projectId);
}

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

function resolveClaudeModel(input: {
  cwd: string;
  sessionId?: string | null;
}): string | null {
  return (
    readLastSessionModel(input.cwd, input.sessionId) ??
    readSettingsModel(path.join(input.cwd, ".claude", "settings.local.json")) ??
    readSettingsModel(path.join(input.cwd, ".claude", "settings.json")) ??
    readSettingsModel(path.join(getClaudeConfigDir(), "settings.json")) ??
    readString(process.env.ANTHROPIC_MODEL)
  );
}

function readLastSessionModel(cwd: string, sessionId?: string | null): string | null {
  if (!sessionId || !isUuid(sessionId)) return null;
  const file = path.join(getClaudeProjectDir(cwd), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let lastModel: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const obj = asRecord(parsed);
      const message = asRecord(obj.message);
      const model = readString(message.model) ?? readString(obj.model);
      if (model) lastModel = model;
    } catch {}
  }
  return lastModel;
}

function readSettingsModel(file: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const settings = asRecord(parsed);
  const env = asRecord(settings.env);
  return (
    readString(env.ANTHROPIC_MODEL) ??
    readString(settings.model) ??
    readString(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ??
    readString(env.ANTHROPIC_DEFAULT_OPUS_MODEL) ??
    readString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
  );
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTodoStatus(value: unknown): ClaudeTodoStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : null;
}

function readTodoPriority(value: unknown): ClaudeTodoPriority | null {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}

export function normalizeClaudeTodoWriteInput(input: unknown): ClaudeTodoItem[] | null {
  const rawTodos = asRecord(input).todos;
  if (!Array.isArray(rawTodos)) return null;
  if (rawTodos.length === 0) return [];

  const todos: ClaudeTodoItem[] = [];
  rawTodos.forEach((item, index) => {
    const todo = asRecord(item);
    const content = readString(todo.content) ?? readString(todo.title) ?? readString(todo.task);
    if (!content) return;
    const priority = readTodoPriority(todo.priority);
    const activeForm = readString(todo.activeForm);
    todos.push({
      id: readString(todo.id) ?? `todo-${index}`,
      content,
      status: readTodoStatus(todo.status) ?? "pending",
      ...(priority ? { priority } : {}),
      ...(activeForm ? { activeForm } : {}),
    });
  });

  return todos.length > 0 ? todos : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function pendingSessionIdFromSlashCommand(command: CliSlashCommand): string | null {
  if (command.sessionId?.startsWith("pending_")) return command.sessionId;
  return null;
}

function isValidClaudeSession(sessionId: string, cwd: string): boolean {
  if (!isUuid(sessionId)) return false;
  const file = path.join(getClaudeProjectDir(cwd), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj?.uuid === "string" && obj.uuid.length > 0) return true;
      if (typeof obj?.messageId === "string" && obj.messageId.length > 0) return true;
      if (typeof obj?.leafUuid === "string" && obj.leafUuid.length > 0) return true;
      if (typeof obj?.message?.id === "string" && obj.message.id.length > 0) return true;
    } catch {}
  }
  return false;
}

function mergeClaudeSessionTranscript(input: {
  cwd: string;
  sourceSessionId: string;
  targetSessionId: string;
}): void {
  if (
    !isUuid(input.sourceSessionId) ||
    !isUuid(input.targetSessionId) ||
    input.sourceSessionId === input.targetSessionId
  ) {
    return;
  }

  const projectDir = getClaudeProjectDir(input.cwd);
  const sourceFile = path.join(projectDir, `${input.sourceSessionId}.jsonl`);
  const targetFile = path.join(projectDir, `${input.targetSessionId}.jsonl`);
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(sourceFile, "utf8");
  } catch {
    return;
  }

  let targetText = "";
  try {
    targetText = fs.readFileSync(targetFile, "utf8");
  } catch {}

  const targetKeys = new Set<string>();
  for (const line of targetText.split("\n")) {
    const key = transcriptLineKey(line);
    if (key) targetKeys.add(key);
  }

  const linesToAppend: string[] = [];
  let lastTargetUuid = readLastTranscriptUuid(targetText);
  for (const line of sourceText.split("\n")) {
    if (!line.trim()) continue;
    const normalized = normalizeTranscriptLineForSession(
      line,
      input.sourceSessionId,
      input.targetSessionId,
      lastTargetUuid,
    );
    if (!normalized) continue;
    const key = transcriptLineKey(normalized);
    if (key && targetKeys.has(key)) continue;
    if (key) targetKeys.add(key);
    linesToAppend.push(normalized);
    const uuid = readTranscriptUuid(normalized);
    if (uuid) lastTargetUuid = uuid;
  }

  if (linesToAppend.length === 0) return;
  fs.mkdirSync(projectDir, { recursive: true });
  const prefix = targetText && !targetText.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(targetFile, `${prefix}${linesToAppend.join("\n")}\n`);
}

function normalizeTranscriptLineForSession(
  line: string,
  sourceSessionId: string,
  targetSessionId: string,
  fallbackParentUuid: string | null,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (readString(obj.sessionId) !== sourceSessionId) return null;
  obj.sessionId = targetSessionId;
  if (obj.parentUuid === null && fallbackParentUuid) {
    obj.parentUuid = fallbackParentUuid;
  }
  return JSON.stringify(obj);
}

function transcriptLineKey(line: string): string | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line.trim();
  }
  const obj = asRecord(parsed);
  return (
    readString(obj.uuid) ??
    readString(obj.messageId) ??
    readString(obj.leafUuid) ??
    readString(obj.promptId) ??
    line.trim()
  );
}

function readTranscriptUuid(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return readString(asRecord(parsed).uuid);
}

function readLastTranscriptUuid(text: string): string | null {
  let uuid: string | null = null;
  for (const line of text.split("\n")) {
    const next = readTranscriptUuid(line);
    if (next) uuid = next;
  }
  return uuid;
}

function findLastClaudeSession(cwd: string): string | null {
  const projectDir = getClaudeProjectDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(projectDir);
  } catch {
    return null;
  }
  const candidates = files
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const id = name.slice(0, -".jsonl".length);
      if (!isUuid(id) || !isValidClaudeSession(id, cwd)) return null;
      try {
        return { id, mtime: fs.statSync(path.join(projectDir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { id: string; mtime: number } => Boolean(item))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.id ?? null;
}
