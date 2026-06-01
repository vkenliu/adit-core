import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { spawnCliProcess } from "./cli-process.js";

export interface CodexJsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CodexAppServerClientOptions {
  bin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onNotification?: (message: CodexJsonRpcMessage) => void;
  onServerRequest?: (message: CodexJsonRpcMessage) => Promise<unknown>;
  onError?: (error: Error) => void;
}

const REQUEST_TIMEOUT_MS = 60_000;
export const CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE = "default_mode_request_user_input";
const CODEX_APP_SERVER_ARGS = [
  "app-server",
  "--enable",
  CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE,
  "--listen",
  "stdio://",
];
const CODEX_SYSTEM_SKILLS_TRANSIENT_ERROR_RE =
  /codex_core_skills::loader: failed to (?:read skills dir|stat skills path) .*[\/\\]skills[\/\\]\.system[\/\\].*No such file or directory/i;
const CODEX_RECOVERABLE_TOOL_ERROR_RE =
  /codex_core::tools::router: error=write_stdin failed: stdin is closed for this session/i;

export function isTransientCodexSystemSkillsError(line: string): boolean {
  return CODEX_SYSTEM_SKILLS_TRANSIENT_ERROR_RE.test(line);
}

export function isRecoverableCodexAppServerToolError(line: string): boolean {
  return CODEX_RECOVERABLE_TOOL_ERROR_RE.test(line);
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private deferredSystemSkillsStderr: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private stopped = false;

  constructor(private readonly opts: CodexAppServerClientOptions) {
    super();
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopped = false;
    const child = spawnCliProcess(this.opts.bin, CODEX_APP_SERVER_ARGS, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.handleStderr(chunk));
    child.on("error", (error) => {
      this.opts.onError?.(error);
      this.rejectAll(error);
    });
    child.on("exit", (code, signal) => {
      this.flushStderrBuffer();
      this.flushDeferredSystemSkillsStderr();
      this.child = null;
      this.rejectAll(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`));
      this.emit("exit", { code, signal });
    });

    await this.request("initialize", {
      clientInfo: {
        name: "adit-cloud",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  hasDeferredSystemSkillsStderr(): boolean {
    return this.deferredSystemSkillsStderr.length > 0;
  }

  clearDeferredSystemSkillsStderr(): void {
    this.deferredSystemSkillsStderr = [];
  }

  flushDeferredSystemSkillsStderr(): void {
    const lines = this.deferredSystemSkillsStderr;
    this.deferredSystemSkillsStderr = [];
    for (const line of lines) this.writeStderrLine(line);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(payload);
    return promise;
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: string | number, message: string, code = -32000): void {
    this.send({ id, error: { code, message } });
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.rejectAll(new Error("Codex app-server stopped"));
    try {
      child?.stdin?.end();
    } catch {}
    try {
      child?.kill("SIGTERM");
    } catch {}
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child?.stdin || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) this.handleStderrLine(line);
  }

  private flushStderrBuffer(): void {
    const line = this.stderrBuffer;
    this.stderrBuffer = "";
    if (line.trim()) this.handleStderrLine(line);
  }

  private handleStderrLine(line: string): void {
    if (!line.trim()) return;
    if (isTransientCodexSystemSkillsError(line)) {
      this.deferredSystemSkillsStderr.push(line);
      return;
    }
    if (isRecoverableCodexAppServerToolError(line) && !isAditDebugEnabled()) {
      return;
    }
    this.writeStderrLine(line);
  }

  private writeStderrLine(line: string): void {
    if (!line.trim()) return;
    process.stderr.write(`[codex app-server] ${line}\n`);
  }

  private handleLine(line: string): void {
    let message: CodexJsonRpcMessage;
    try {
      message = JSON.parse(line) as CodexJsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.opts.onNotification?.(message);
    }
  }

  private async handleServerRequest(message: CodexJsonRpcMessage): Promise<void> {
    if (message.id === undefined) return;
    try {
      const result = this.opts.onServerRequest
        ? await this.opts.onServerRequest(message)
        : null;
      this.respond(message.id, result);
    } catch (error) {
      this.respondError(
        message.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (!this.stopped) this.opts.onError?.(error);
  }
}

function isAditDebugEnabled(): boolean {
  const value = process.env.ADIT_DEBUG?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "off");
}
