import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  AbortError,
  query,
  type Options,
  type PermissionResult,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CliAgentProvider,
  CliAgentRelayEvent,
  CliAgentState,
  CliPermissionRequest,
} from "./types.js";

interface PendingPrompt {
  message: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ClaudeCodeProviderOptions {
  bin: string;
  args: string[];
  cwd: string;
  hookSettingsPath?: string;
  onEvent?: (event: CliAgentRelayEvent) => void;
}

const RECLAIM_COMMAND = "/local";

export class ClaudeCodeProvider extends EventEmitter implements CliAgentProvider {
  readonly provider = "claude-code" as const;
  private local: ChildProcess | null = null;
  private remoteQuery: Query | null = null;
  private remoteAbortController: AbortController | null = null;
  private ownerValue: CliAgentState["owner"] = "stopped";
  private busyValue = false;
  private thinkingValue = false;
  private activeSessionId: string | null = null;
  private resumeSessionId: string | null = null;
  private sdkSessionId: string | null = null;
  private promptQueue: PendingPrompt[] = [];
  private promptResolvers: Array<(value: SDKUserMessage | null) => void> = [];
  private pendingPromptEvents: string[] = [];
  private pendingPermissions = new Map<string, {
    request: CliPermissionRequest;
    resolve: (result: PermissionResult) => void;
    reject: (error: Error) => void;
  }>();
  private reclaimBuffer = "";
  private reclaimAttached = false;
  private suppressNextLocalExit = false;

  constructor(private readonly opts: ClaudeCodeProviderOptions) {
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
    };
  }

  get permissions(): CliPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((item) => item.request);
  }

  noteLocalSession(id: string): void {
    if (!id) return;
    const changed = this.activeSessionId !== id || this.resumeSessionId !== id;
    this.activeSessionId = id;
    this.resumeSessionId = id;
    if (!changed) return;
    this.emitState();
    for (const prompt of this.pendingPromptEvents.splice(0)) {
      this.pushEvent("message", {
        role: "user",
        sessionId: id,
        text: prompt,
        createdAt: Date.now(),
      });
    }
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
    this.emitState();
    process.stderr.write(
      `\n[adit cloud claude] Web has taken over Claude Code. Type ${RECLAIM_COMMAND} here to reclaim local control.\n`,
    );
    this.attachReclaimInput();
    void this.runRemoteLoop();
  }

  async releaseToLocal(): Promise<void> {
    if (this.ownerValue !== "web") return;
    process.stderr.write("\n[adit cloud claude] releasing Web control back to local Claude CLI...\n");
    this.finishWebPrompts(new Error("Web control released to local CLI"));
    for (const pending of this.pendingPermissions.values()) {
      pending.reject(new Error("Web control released to local CLI"));
    }
    this.pendingPermissions.clear();
    this.pushEvent("permission-resolved", { id: "all", approved: false });
    this.remoteAbortController?.abort();
    try {
      await this.remoteQuery?.interrupt?.();
    } catch {}
    this.remoteQuery?.close?.();
    this.remoteQuery = null;
    this.remoteAbortController = null;
    this.detachReclaimInput();
    const resumeId = this.pickResumeSessionId({ fallbackToLatest: true });
    this.startLocal(resumeId ? ["--resume", resumeId] : []);
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (this.ownerValue !== "web") {
      throw Object.assign(new Error("Web has not taken over this Claude session"), {
        statusCode: 409,
      });
    }
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const sessionId = this.activeSessionId ?? this.resumeSessionId;
    if (sessionId) {
      this.pushEvent("message", {
        role: "user",
        sessionId,
        text: trimmed,
        createdAt: Date.now(),
      });
    } else {
      this.pendingPromptEvents.push(trimmed);
    }

    await new Promise<void>((resolve, reject) => {
      this.promptQueue.push({ message: trimmed, resolve, reject });
      this.drainPromptResolvers();
    });
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
    pending.resolve(result);
  }

  async abort(): Promise<void> {
    if (this.ownerValue !== "web") return;
    this.finishWebPrompts(new Error("Claude run aborted"));
    this.remoteAbortController?.abort();
    try {
      await this.remoteQuery?.interrupt?.();
    } catch {}
    this.remoteQuery?.close?.();
    this.remoteQuery = null;
    this.remoteAbortController = null;
    this.setThinking(false);
    this.setBusy(false);
    this.pushEvent("error", { message: "Claude run aborted." });
  }

  stop(): void {
    this.finishWebPrompts(new Error("Claude provider stopped"));
    this.remoteAbortController?.abort();
    this.remoteQuery?.close?.();
    this.remoteQuery = null;
    this.remoteAbortController = null;
    for (const pending of this.pendingPermissions.values()) {
      pending.reject(new Error("Claude provider stopped"));
    }
    this.pendingPermissions.clear();
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
    this.finishWebPrompts(new Error("local mode active"));
    this.remoteQuery = null;
    this.remoteAbortController = null;
    const args = [
      ...extraArgs,
      ...this.opts.args,
      ...(this.opts.hookSettingsPath ? ["--settings", this.opts.hookSettingsPath] : []),
    ];
    const child = spawn(this.opts.bin, args, {
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
      process.stderr.write(`\n[adit cloud claude] failed to start Claude CLI: ${error.message}\n`);
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

  private async runRemoteLoop(): Promise<void> {
    while (this.ownerValue === "web") {
      let first: SDKUserMessage | null;
      try {
        first = await this.nextPrompt();
      } catch {
        return;
      }
      if (!first || this.ownerValue !== "web") return;

      const canonicalSessionId = this.activeSessionId;
      const resumeId = this.pickResumeSessionId({ fallbackToLatest: false });
      const abortController = new AbortController();
      this.remoteAbortController = abortController;
      const options: Options = {
        cwd: this.opts.cwd,
        resume: resumeId ?? undefined,
        settings: this.opts.hookSettingsPath,
        permissionMode: "default",
        forkSession: false,
        abortController,
        includePartialMessages: true,
        forwardSubagentText: true,
        canUseTool: (toolName, input, requestOptions) =>
          this.handleToolPermission(
            toolName,
            input,
            requestOptions.toolUseID,
            requestOptions.signal,
          ),
      };

      this.remoteQuery = query({
        prompt: this.createPromptStream(first),
        options,
      });
      this.setBusy(true);
      this.setThinking(true);
      this.emitState();

      try {
        for await (const message of this.remoteQuery) {
          this.handleSdkMessage(message, canonicalSessionId ?? resumeId);
        }
      } catch (error) {
        if (!(error instanceof AbortError)) {
          const messageText = error instanceof Error ? error.message : String(error);
          this.pushEvent("error", { message: messageText });
          process.stderr.write(`\n[adit cloud claude] SDK error: ${messageText}\n`);
        }
      } finally {
        this.setThinking(false);
        this.setBusy(false);
        this.remoteQuery = null;
        this.remoteAbortController = null;
      }
    }
  }

  private async *createPromptStream(
    first: SDKUserMessage,
  ): AsyncIterable<SDKUserMessage> {
    yield first;
  }

  private nextPrompt(): Promise<SDKUserMessage | null> {
    if (this.promptQueue.length > 0) {
      const item = this.promptQueue.shift();
      if (!item) return Promise.resolve(null);
      item.resolve();
      return Promise.resolve(toUserMessage(item.message));
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
      item.resolve();
      resolve(toUserMessage(item.message));
    }
  }

  private finishWebPrompts(error: Error): void {
    for (const item of this.promptQueue.splice(0)) {
      item.reject(error);
    }
    for (const resolve of this.promptResolvers.splice(0)) {
      resolve(null);
    }
  }

  private handleSdkMessage(message: SDKMessage, fallbackSessionId: string | null): void {
    const sdkSessionId = extractSessionId(message);
    if (sdkSessionId) {
      this.sdkSessionId = sdkSessionId;
      if (!this.resumeSessionId && isValidClaudeSession(sdkSessionId, this.opts.cwd)) {
        this.resumeSessionId = sdkSessionId;
        this.activeSessionId = sdkSessionId;
      }
    }
    const sessionId = fallbackSessionId ?? this.activeSessionId ?? this.resumeSessionId ?? sdkSessionId ?? "pending";
    this.emitState();

    if (message.type === "system" && (message as SDKSystemMessage).subtype === "init") {
      const init = message as SDKSystemMessage;
      if (init.session_id) this.noteLocalSession(init.session_id);
      return;
    }

    if (message.type === "assistant") {
      this.emitAssistantMessage(message as SDKAssistantMessage, sessionId);
      return;
    }

    if (message.type === "user") {
      this.emitToolResults(message as SDKUserMessage, sessionId);
      return;
    }

    if (message.type === "result") {
      this.setThinking(false);
      this.setBusy(false);
    }
  }

  private emitAssistantMessage(message: SDKAssistantMessage, sessionId: string): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    const messageId = makeMessageId(message, sessionId);
    const modelId = typeof message.message?.model === "string"
      ? message.message.model
      : undefined;
    for (const part of content as unknown as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string" && part.text) {
        this.pushEvent("message", {
          role: "assistant",
          sessionId,
          messageId,
          modelId,
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
          text: part.thinking,
          createdAt: Date.now(),
        });
      } else if (part.type === "tool_use" || part.type === "server_tool_use") {
        this.pushEvent("tool", {
          sessionId,
          messageId,
          modelId,
          toolUseId: typeof part.id === "string" ? part.id : undefined,
          toolName: typeof part.name === "string" ? part.name : "tool",
          input: part.input ?? {},
          status: "running",
          createdAt: Date.now(),
        });
      }
    }
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
      this.sdkSessionId,
    ];
    for (const id of candidates) {
      if (id && isValidClaudeSession(id, this.opts.cwd)) {
        this.resumeSessionId = id;
        this.activeSessionId = id;
        return id;
      }
    }
    if (!opts.fallbackToLatest) return null;
    const latest = findLastClaudeSession(this.opts.cwd);
    if (latest) {
      this.resumeSessionId = latest;
      this.activeSessionId = latest;
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

  private emitState(): void {
    this.emit("state", this.state);
    this.pushEvent("state", {
      owner: this.ownerValue,
      busy: this.busyValue,
      thinking: this.thinkingValue,
      activeSessionId: this.activeSessionId,
      resumeSessionId: this.resumeSessionId,
      sdkSessionId: this.sdkSessionId,
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
}

function toUserMessage(message: string): SDKUserMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: message,
    },
  };
}

function extractSessionId(message: SDKMessage): string | null {
  const maybe = message as { session_id?: unknown; sessionId?: unknown };
  if (typeof maybe.session_id === "string") return maybe.session_id;
  if (typeof maybe.sessionId === "string") return maybe.sessionId;
  return null;
}

function makeMessageId(message: SDKMessage, sessionId: string): string {
  const maybe = message as { uuid?: unknown; message?: { id?: unknown } };
  if (typeof maybe.message?.id === "string") return maybe.message.id;
  if (typeof maybe.uuid === "string") return maybe.uuid;
  return `claude-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function formatToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function getClaudeProjectDir(cwd: string): string {
  const projectId = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return path.join(claudeConfigDir, "projects", projectId);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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
