import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  CliAgentProvider,
  CliAgentRelayEvent,
  CliAgentState,
  CliPermissionRequest,
  CliQuestionResponse,
} from "./types.js";
import {
  CodexAppServerClient,
  type CodexJsonRpcMessage,
} from "./codex-app-server-client.js";

interface PendingPrompt {
  message: string;
  mode: "build" | "plan";
  pendingSessionId: string | null;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingPermission {
  request: CliPermissionRequest;
  method: string;
  params: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingQuestion {
  id: string;
  method: string;
  params: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface CodexCliProviderOptions {
  bin: string;
  args: string[];
  cwd: string;
  onEvent?: (event: CliAgentRelayEvent) => void;
}

const RECLAIM_COMMAND = "/local";
const TERMINAL_RECLAIM_RESET = [
  "\x1b[?1004l", // Focus in/out reporting.
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l", // Mouse modes.
  "\x1b[?2004l", // Bracketed paste.
  "\x1b[?1l", // Application cursor keys.
  "\x1b[=0u\x1b[<u\x1b[<u\x1b[<u", // Kitty/CSI-u keyboard protocol.
  "\x1b[>4;0m", // xterm modifyOtherKeys.
  "\x1b[?25h", // Cursor visible.
].join("");

export class CodexCliProvider extends EventEmitter implements CliAgentProvider {
  readonly provider = "codex" as const;
  private local: ChildProcess | null = null;
  private appServer: CodexAppServerClient | null = null;
  private ownerValue: CliAgentState["owner"] = "stopped";
  private busyValue = false;
  private thinkingValue = false;
  private activeSessionId: string | null = null;
  private resumeSessionId: string | null = null;
  private sdkSessionId: string | null = null;
  private activeModelId: string | null = null;
  private promptQueue: PendingPrompt[] = [];
  private promptActive = false;
  private activeTurnId: string | null = null;
  private loadedThreadIds = new Set<string>();
  private boundPendingSessionIds = new Set<string>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingQuestions = new Map<string, PendingQuestion>();
  private lastAssistantMessageBySession = new Map<string, string>();
  private reclaimAttached = false;
  private reclaimBuffer = "";
  private suppressNextLocalExit = false;

  constructor(private readonly opts: CodexCliProviderOptions) {
    super();
    this.startLocal();
  }

  get state(): CliAgentState {
    return {
      owner: this.ownerValue,
      busy: this.busyValue,
      thinking: this.thinkingValue,
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      sdkSessionId: this.sdkSessionId,
      activeModelId: this.activeModelId,
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
    this.sdkSessionId = id;
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
    if (this.ownerValue === "web") return;
    if (this.ownerValue !== "local") {
      throw Object.assign(new Error("local Codex owner is not available"), {
        statusCode: 409,
      });
    }
    if (this.busyValue || this.thinkingValue) {
      throw Object.assign(new Error("local Codex is busy"), {
        statusCode: 409,
      });
    }

    await this.ensureAppServer();
    const resumeId = this.activeSessionId ?? this.resumeSessionId;
    if (resumeId) {
      await this.resumeThread(resumeId);
    }

    this.suppressNextLocalExit = true;
    const oldLocal = this.local;
    this.local = null;
    try {
      oldLocal?.kill("SIGTERM");
    } catch {}

    this.ownerValue = "web";
    this.emitState();
    restoreTerminalForCodexReclaim();
    process.stderr.write(
      `\n[adit cloud codex] Web has taken over Codex CLI. Type ${RECLAIM_COMMAND} here to reclaim local control.\n`,
    );
    this.attachReclaimInput();
  }

  async releaseToLocal(): Promise<void> {
    if (this.ownerValue !== "web") return;
    this.detachReclaimInput();
    process.stderr.write("\n[adit cloud codex] releasing Web control back to local Codex CLI...\n");
    this.finishWebPrompts(new Error("Web control released to local CLI"));
    this.rejectPendingRequests(new Error("Web control released to local CLI"));
    this.appServer?.stop();
    this.appServer = null;
    this.loadedThreadIds = new Set<string>();
    const resumeId = this.resumeSessionId ?? this.activeSessionId;
    this.startLocal(resumeId ? ["resume", resumeId] : []);
  }

  async switchSession(sessionId: string): Promise<void> {
    if (!sessionId.trim()) {
      throw Object.assign(new Error("Codex session not found for this project"), {
        statusCode: 404,
      });
    }

    if (this.ownerValue === "local") {
      this.suppressNextLocalExit = true;
      const oldLocal = this.local;
      this.local = null;
      try {
        oldLocal?.kill("SIGTERM");
      } catch {}
      this.activeSessionId = sessionId;
      this.resumeSessionId = sessionId;
      this.sdkSessionId = sessionId;
      this.emitState();
      this.startLocal(["resume", sessionId]);
      return;
    }

    if (this.ownerValue === "web") {
      await this.ensureAppServer();
      await this.resumeThread(sessionId);
      this.finishWebPrompts(new Error("Codex session switched"));
      this.setBusy(false);
      this.setThinking(false);
      return;
    }
  }

  async sendPrompt(
    prompt: string,
    opts: { mode?: "build" | "plan"; pendingSessionId?: string | null } = {},
  ): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Codex session"), {
        statusCode: 409,
      });
    }
    const trimmed = prompt.trim();
    if (!trimmed) return;

    await new Promise<void>((resolve, reject) => {
      this.promptQueue.push({
        message: trimmed,
        mode: opts.mode === "plan" ? "plan" : "build",
        pendingSessionId: opts.pendingSessionId ?? null,
        resolve,
        reject,
      });
      void this.drainPromptQueue();
    });
  }

  async answerPermission(
    id: string,
    approved: boolean,
    _reason?: string,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(id);
    if (!pending) {
      throw Object.assign(new Error("permission request not found"), {
        statusCode: 404,
      });
    }
    this.pendingPermissions.delete(id);
    this.pushEvent("permission-resolved", { id, approved });
    pending.resolve(buildApprovalResponse(pending.method, pending.params, approved));
  }

  async answerQuestion(response: CliQuestionResponse): Promise<void> {
    const pending = this.pendingQuestions.get(response.id);
    if (!pending) {
      throw Object.assign(new Error("question request not found"), {
        statusCode: 404,
      });
    }
    this.pendingQuestions.delete(response.id);
    if (response.rejected) {
      this.pushEvent("question.rejected", {
        id: response.id,
        requestID: response.id,
      });
      pending.resolve(buildQuestionResponse(pending.method, pending.params, []));
      return;
    }
    this.pushEvent("question.replied", {
      id: response.id,
      requestID: response.id,
    });
    pending.resolve(buildQuestionResponse(pending.method, pending.params, response.answers));
  }

  async abort(): Promise<void> {
    if (this.ownerValue !== "web") return;
    const threadId = this.activeSessionId ?? this.resumeSessionId;
    const turnId = this.activeTurnId;
    this.finishWebPrompts(new Error("Codex run aborted"));
    if (threadId && turnId) {
      try {
        await this.appServer?.request("turn/interrupt", { threadId, turnId });
      } catch {}
    }
    this.activeTurnId = null;
    this.setThinking(false);
    this.setBusy(false);
    this.pushEvent("error", { message: "Codex run aborted." });
  }

  stop(): void {
    this.finishWebPrompts(new Error("Codex provider stopped"));
    this.rejectPendingRequests(new Error("Codex provider stopped"));
    this.detachReclaimInput();
    this.appServer?.stop();
    this.appServer = null;
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
    this.finishWebPrompts(new Error("local mode active"));
    this.appServer?.stop();
    this.appServer = null;
    const child = spawn(this.opts.bin, [...extraArgs, ...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.buildEnv(),
      stdio: "inherit",
      windowsHide: true,
    });
    this.local = child;
    this.ownerValue = "local";
    this.emitState();

    child.on("error", (error) => {
      this.pushEvent("error", { message: error.message });
      process.stderr.write(`\n[adit cloud codex] failed to start Codex CLI: ${error.message}\n`);
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

  private async drainPromptQueue(): Promise<void> {
    if (this.promptActive || this.busyValue || this.ownerValue !== "web") return;
    const item = this.promptQueue.shift();
    if (!item) return;
    this.promptActive = true;
    try {
      await this.ensureAppServer();
      const threadId = await this.ensureThreadForPrompt(item.pendingSessionId);
      this.pushEvent("message", {
        role: "user",
        sessionId: threadId,
        text: item.message,
        createdAt: Date.now(),
      });
      const result = asRecord(await this.appServer?.request("turn/start", {
        threadId,
        input: [{ type: "text", text: item.message, text_elements: [] }],
        cwd: this.opts.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      }));
      const turn = asRecord(result?.turn);
      this.activeTurnId = readString(turn?.id) ?? this.activeTurnId;
      this.setBusy(true);
      this.setThinking(true);
      item.resolve();
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
      this.pushEvent("error", {
        message: error instanceof Error ? error.message : String(error),
        createdAt: Date.now(),
      });
    } finally {
      this.promptActive = false;
    }
  }

  private async ensureThreadForPrompt(pendingSessionId: string | null): Promise<string> {
    if (pendingSessionId) {
      const threadId = await this.startThread();
      this.bindPendingSession(pendingSessionId, threadId);
      return threadId;
    }

    const existing = this.activeSessionId ?? this.resumeSessionId;
    if (existing) {
      if (!this.loadedThreadIds.has(existing)) {
        await this.resumeThread(existing);
      }
      return existing;
    }

    return this.startThread();
  }

  private async ensureAppServer(): Promise<void> {
    if (this.appServer?.isRunning) return;
    const client = new CodexAppServerClient({
      bin: this.opts.bin,
      cwd: this.opts.cwd,
      env: this.buildEnv(),
      onNotification: (message) => this.handleAppNotification(message),
      onServerRequest: (message) => this.handleAppServerRequest(message),
      onError: (error) => {
        this.pushEvent("error", { message: error.message, createdAt: Date.now() });
      },
    });
    this.appServer = client;
    await client.start();
  }

  private async startThread(): Promise<string> {
    await this.ensureAppServer();
    const result = asRecord(await this.appServer?.request("thread/start", {
      cwd: this.opts.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    }));
    const thread = asRecord(result?.thread);
    const threadId = readString(thread?.id);
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    this.noteThread(thread, result);
    return threadId;
  }

  private async resumeThread(threadId: string): Promise<void> {
    await this.ensureAppServer();
    const result = asRecord(await this.appServer?.request("thread/resume", {
      threadId,
      cwd: this.opts.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      persistExtendedHistory: true,
    }));
    const thread = asRecord(result?.thread);
    const resumedId = readString(thread?.id) ?? threadId;
    this.noteThread({ ...(thread ?? {}), id: resumedId }, result);
    this.emitThreadTurns(thread);
  }

  private handleAppNotification(message: CodexJsonRpcMessage): void {
    const method = message.method;
    const params = asRecord(message.params) ?? {};
    if (method === "error") {
      this.pushEvent("error", {
        message: readString(params.message) ?? "Codex app-server error",
        createdAt: Date.now(),
      });
      return;
    }

    if (method === "thread/started") {
      this.noteThread(asRecord(params.thread), null);
      return;
    }

    if (method === "thread/status/changed") {
      const status = asRecord(params.status);
      const active = status?.type === "active";
      this.setBusy(active);
      this.setThinking(active);
      return;
    }

    if (method === "turn/started") {
      this.activeTurnId = readString(asRecord(params.turn)?.id) ?? this.activeTurnId;
      this.setBusy(true);
      this.setThinking(true);
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      const status = readString(turn?.status);
      if (status === "failed") {
        const error = asRecord(turn?.error);
        this.pushEvent("error", {
          message: readString(error?.message) ?? "Codex turn failed",
          createdAt: Date.now(),
        });
      }
      this.activeTurnId = null;
      this.setThinking(false);
      this.setBusy(false);
      void this.drainPromptQueue();
      return;
    }

    if (method === "item/started") {
      this.emitThreadItem(asRecord(params.item), {
        threadId: readString(params.threadId),
        running: true,
      });
      return;
    }

    if (method === "item/completed") {
      this.emitThreadItem(asRecord(params.item), {
        threadId: readString(params.threadId),
        running: false,
      });
      return;
    }

    if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      const text = readString(params.delta);
      const sessionId = readString(params.threadId);
      const messageId = readString(params.itemId);
      if (text && sessionId && messageId) {
        this.lastAssistantMessageBySession.set(sessionId, messageId);
        this.pushEvent("assistant-delta", {
          sessionId,
          messageId,
          text,
          modelId: this.activeModelId ?? undefined,
          createdAt: Date.now(),
        });
      }
      return;
    }

    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      const text = readString(params.delta);
      const sessionId = readString(params.threadId);
      const messageId = readString(params.itemId);
      if (text && sessionId && messageId) {
        this.pushEvent("reasoning", {
          sessionId,
          messageId,
          text,
          createdAt: Date.now(),
        });
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const sessionId = readString(params.threadId);
      const usage = normalizeCodexUsage(asRecord(asRecord(params.tokenUsage)?.last));
      if (sessionId && usage) {
        this.pushEvent("usage", {
          sessionId,
          messageId: this.lastAssistantMessageBySession.get(sessionId),
          usage,
          createdAt: Date.now(),
        });
      }
    }
  }

  private handleAppServerRequest(message: CodexJsonRpcMessage): Promise<unknown> {
    if (message.id === undefined || !message.method) {
      return Promise.resolve(null);
    }
    const id = String(message.id);
    const params = asRecord(message.params) ?? {};
    const sessionId = readString(params.threadId) ?? this.activeSessionId ?? this.resumeSessionId;

    if (
      message.method === "item/tool/requestUserInput" ||
      message.method === "mcpServer/elicitation/request"
    ) {
      return new Promise((resolve, reject) => {
        this.pendingQuestions.set(id, {
          id,
          method: message.method ?? "",
          params,
          resolve,
          reject,
        });
        this.pushEvent("question.asked", {
          id,
          sessionId,
          questions: normalizeCodexQuestions(message.method ?? "", params),
          createdAt: Date.now(),
        });
        this.emitState();
      });
    }

    if (
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval" ||
      message.method === "item/permissions/requestApproval" ||
      message.method === "applyPatchApproval" ||
      message.method === "execCommandApproval"
    ) {
      return new Promise((resolve, reject) => {
        const toolName = approvalToolName(message.method ?? "", params);
        const request: CliPermissionRequest = {
          id,
          toolName,
          input: params,
          createdAt: Date.now(),
        };
        this.pendingPermissions.set(id, {
          request,
          method: message.method ?? "",
          params,
          resolve,
          reject,
        });
        this.pushEvent("permission", {
          id,
          toolName,
          input: params,
          createdAt: request.createdAt,
          sessionId,
        });
        this.emitState();
      });
    }

    return Promise.reject(new Error(`Unsupported Codex app-server request: ${message.method}`));
  }

  private noteThread(thread: Record<string, unknown> | null, result: Record<string, unknown> | null): void {
    const threadId = readString(thread?.id);
    if (!threadId) return;
    this.activeSessionId = threadId;
    this.resumeSessionId = threadId;
    this.sdkSessionId = threadId;
    this.loadedThreadIds.add(threadId);
    const modelId = readString(result?.model);
    if (modelId) this.activeModelId = modelId;
    this.emitState();
  }

  private emitThreadTurns(thread: Record<string, unknown> | null): void {
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const threadId = readString(thread?.id);
    for (const turn of turns) {
      const record = asRecord(turn);
      const items = Array.isArray(record?.items) ? record.items : [];
      for (const item of items) {
        this.emitThreadItem(asRecord(item), { threadId, running: false });
      }
    }
  }

  private emitThreadItem(
    item: Record<string, unknown> | null,
    opts: { threadId: string | null; running: boolean },
  ): void {
    if (!item) return;
    const type = readString(item.type);
    const sessionId = opts.threadId ?? this.activeSessionId ?? this.resumeSessionId;
    const id = readString(item.id);
    if (!type || !sessionId || !id) return;
    const createdAt = Date.now();

    if ((type === "agentMessage" || type === "plan") && !opts.running) {
      const text = readString(item.text);
      if (!text) return;
      this.lastAssistantMessageBySession.set(sessionId, id);
      this.pushEvent("message", {
        role: "assistant",
        sessionId,
        messageId: id,
        modelId: this.activeModelId ?? undefined,
        text,
        createdAt,
      });
      return;
    }

    if (type === "reasoning" && !opts.running) {
      const content = [
        ...readStringArray(item.summary),
        ...readStringArray(item.content),
      ].join("\n");
      if (!content) return;
      this.pushEvent("reasoning", {
        sessionId,
        messageId: id,
        text: content,
        createdAt,
      });
      return;
    }

    if (type === "commandExecution") {
      const command = readString(item.command) ?? "command";
      const status = readString(item.status);
      this.pushEvent("tool", {
        sessionId,
        messageId: this.lastAssistantMessageBySession.get(sessionId) ?? `codex-tools-${sessionId}`,
        toolUseId: id,
        toolName: "Bash",
        input: {
          command,
          cwd: readString(item.cwd),
          source: item.source,
          commandActions: item.commandActions,
        },
        output: readString(item.aggregatedOutput) ?? undefined,
        error: status === "failed" ? readString(item.aggregatedOutput) ?? "Command failed" : undefined,
        status: opts.running || status === "inProgress"
          ? "running"
          : status === "completed"
            ? "completed"
            : "error",
        createdAt,
      });
      return;
    }

    if (type === "fileChange") {
      const status = readString(item.status);
      this.pushEvent("tool", {
        sessionId,
        messageId: this.lastAssistantMessageBySession.get(sessionId) ?? `codex-tools-${sessionId}`,
        toolUseId: id,
        toolName: "apply_patch",
        input: { changes: item.changes },
        output: status === "completed" ? safeJson(item.changes) : undefined,
        error: status === "failed" || status === "declined" ? `File change ${status}` : undefined,
        status: opts.running || status === "inProgress"
          ? "running"
          : status === "completed"
            ? "completed"
            : "error",
        createdAt,
      });
      return;
    }

    if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") {
      const toolName = readString(item.tool) ?? readString(item.server) ?? type;
      const status = readString(item.status);
      this.pushEvent("tool", {
        sessionId,
        messageId: this.lastAssistantMessageBySession.get(sessionId) ?? `codex-tools-${sessionId}`,
        toolUseId: id,
        toolName,
        input: asRecord(item.arguments) ?? { query: item.query },
        output: item.result !== undefined ? safeJson(item.result) : undefined,
        error: item.error !== undefined ? safeJson(item.error) : undefined,
        status: opts.running || status === "inProgress" || status === "running"
          ? "running"
          : item.error ? "error" : "completed",
        createdAt,
      });
    }
  }

  private bindPendingSession(pendingSessionId: string, sessionId: string): void {
    if (!pendingSessionId || !sessionId) return;
    this.activeSessionId = sessionId;
    this.resumeSessionId = sessionId;
    this.sdkSessionId = sessionId;
    if (!this.boundPendingSessionIds.has(pendingSessionId)) {
      this.boundPendingSessionIds.add(pendingSessionId);
      this.pushEvent("session-bound", {
        pendingSessionId,
        sessionId,
        createdAt: Date.now(),
      });
    }
    this.emitState();
  }

  private finishWebPrompts(error: Error): void {
    for (const item of this.promptQueue.splice(0)) {
      item.reject(error);
    }
    this.promptActive = false;
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.reject(error);
    }
    this.pendingPermissions.clear();
    for (const pending of this.pendingQuestions.values()) {
      pending.reject(error);
    }
    this.pendingQuestions.clear();
    this.pushEvent("permission-resolved", { id: "all", approved: false });
    this.pushEvent("question.rejected", { id: "all" });
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

  private emitState(): void {
    this.emit("state", this.state);
    this.pushEvent("state", {
      owner: this.ownerValue,
      busy: this.busyValue,
      thinking: this.thinkingValue,
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      sdkSessionId: this.sdkSessionId,
      activeModelId: this.activeModelId,
      createdAt: Date.now(),
    });
  }

  private pushEvent(type: string, payload: Record<string, unknown>): void {
    this.opts.onEvent?.({ type, payload });
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      COLORTERM: process.env.COLORTERM || "truecolor",
      FORCE_COLOR: process.env.FORCE_COLOR || "3",
      DISABLE_AUTOUPDATER: "1",
    };
  }

  private attachReclaimInput(): void {
    if (this.reclaimAttached || !process.stdin.isTTY) return;
    this.reclaimAttached = true;
    this.reclaimBuffer = "";
    try {
      restoreTerminalForCodexReclaim();
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
    if (text.includes("\u0003")) {
      this.stop();
      return;
    }
    this.reclaimBuffer = applyReclaimText(
      this.reclaimBuffer,
      normalizeCodexReclaimInput(text),
    );
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
        `[adit cloud codex] Web owns this session. Type ${RECLAIM_COMMAND} to reclaim.\n`,
      );
    }
  };
}

function restoreTerminalForCodexReclaim(): void {
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {}
  try {
    if (process.stderr.isTTY) {
      process.stderr.write(TERMINAL_RECLAIM_RESET);
    }
  } catch {}
}

export function normalizeCodexReclaimInput(text: string): string {
  return text
    .replace(/\x1b\[(\d+)(?:;[0-9:]+)?u/g, (_match, rawCode: string) =>
      decodeCsiUCode(Number(rawCode)),
    )
    .replace(/\x1b\[(?:I|O)/g, "")
    .replace(/\x1b\[[?=>]?[0-9;:]*[A-Za-z~]/g, "");
}

function decodeCsiUCode(code: number): string {
  if (code === 13) return "\n";
  if (code === 9) return "\t";
  if (code === 8 || code === 127) return "\b";
  if (code < 32 || !Number.isFinite(code)) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function applyReclaimText(buffer: string, text: string): string {
  let next = buffer;
  for (const char of text) {
    if (char === "\b" || char === "\x7f") {
      next = next.slice(0, -1);
    } else {
      next += char;
    }
  }
  return next;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeCodexUsage(value: Record<string, unknown> | null): Record<string, number> | undefined {
  if (!value) return undefined;
  const usage = {
    input_tokens: readNumber(value.inputTokens) ?? 0,
    output_tokens: readNumber(value.outputTokens) ?? 0,
    reasoning_tokens: readNumber(value.reasoningOutputTokens) ?? 0,
    cache_read_input_tokens: readNumber(value.cachedInputTokens) ?? 0,
  };
  return Object.values(usage).some((item) => item > 0) ? usage : undefined;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function approvalToolName(method: string, params: Record<string, unknown>): string {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    return "Bash";
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return "apply_patch";
  }
  if (method === "item/permissions/requestApproval") {
    return "CodexPermissions";
  }
  return readString(params.toolName) ?? "Codex";
}

function buildApprovalResponse(
  method: string,
  params: Record<string, unknown>,
  approved: boolean,
): unknown {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: approved ? "accept" : "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: approved ? "accept" : "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: approved ? asRecord(params.permissions) ?? {} : {},
      scope: "turn",
    };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: approved ? "approved" : "denied" };
  }
  return { decision: approved ? "accept" : "decline" };
}

function normalizeCodexQuestions(method: string, params: Record<string, unknown>): Array<{
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple: boolean;
  custom: boolean;
}> {
  if (method === "mcpServer/elicitation/request") {
    return [{
      question: readString(params.message) ?? readString(params.title) ?? "Codex needs input.",
      header: readString(params.title) ?? "Question",
      options: [],
      multiple: false,
      custom: true,
    }];
  }

  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  return rawQuestions.map((item) => {
    const question = asRecord(item) ?? {};
    const options = Array.isArray(question.options)
      ? question.options.map((option) => {
          const record = asRecord(option) ?? {};
          const label = readString(record.label) ?? readString(record.value) ?? "";
          return {
            label,
            description: readString(record.description) ?? "",
          };
        }).filter((option) => option.label)
      : [];
    return {
      question: readString(question.question) ?? "Codex needs input.",
      header: readString(question.header) ?? "Question",
      options,
      multiple: false,
      custom: question.isOther !== false,
    };
  });
}

function buildQuestionResponse(
  method: string,
  params: Record<string, unknown>,
  answers: string[][],
): unknown {
  if (method === "mcpServer/elicitation/request") {
    return {
      action: answers.length > 0 ? "accept" : "decline",
      content: answers.length > 0 ? { answer: answers.flat().join("\n") } : null,
      _meta: null,
    };
  }

  const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
  const mapped: Record<string, { answers: string[] }> = {};
  rawQuestions.forEach((item, index) => {
    const question = asRecord(item) ?? {};
    const id = readString(question.id) ?? `question-${index}`;
    mapped[id] = { answers: answers[index] ?? [] };
  });
  return { answers: mapped };
}
