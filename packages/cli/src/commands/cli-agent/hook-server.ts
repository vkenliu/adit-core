import http, { type Server } from "node:http";
import { EventEmitter } from "node:events";

export interface CliAgentHookEvent {
  type: string;
  body: Record<string, unknown>;
}

export interface HookServer {
  port: number;
  endpoint: string;
  events: EventEmitter;
  close(): Promise<void>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSessionId(body: Record<string, unknown>): string | null {
  return (
    readString(body.session_id) ??
    readString(body.sessionId) ??
    readString(body.thread_id) ??
    readString(body.threadId) ??
    (readString(body.transcript_path) ?? readString(body.transcriptPath))
      ?.match(/([0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12})\.jsonl$/i)?.[1] ??
    null
  );
}

export async function startCliAgentHookServer(): Promise<HookServer> {
  const events = new EventEmitter();

  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/hook")) {
      response.writeHead(404).end();
      return;
    }

    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const body = parsed as Record<string, unknown>;
          const type = readString(body.hook_event_name) ??
            readString(body.event) ??
            "hook";
          const sessionId = readSessionId(body);
          events.emit("hook", {
            type,
            body: {
              ...body,
              ...(sessionId ? { sessionId } : {}),
            },
          } satisfies CliAgentHookEvent);
        }
      } catch {
        // Hook delivery should never break the local CLI agent.
      }
      response.writeHead(204).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Unable to bind local CLI agent hook server");
  }

  return {
    port: address.port,
    endpoint: `http://127.0.0.1:${address.port}/hook`,
    events,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
