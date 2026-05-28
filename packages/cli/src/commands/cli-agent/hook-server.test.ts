import { describe, expect, it } from "vitest";
import { startCliAgentHookServer, type CliAgentHookEvent } from "./hook-server.js";

describe("startCliAgentHookServer", () => {
  it("normalizes Codex thread_id payloads into sessionId", async () => {
    const server = await startCliAgentHookServer();
    try {
      const sessionId = "019e0d36-9fd9-7c40-add5-01d6d8bc49d3";
      const eventPromise = new Promise<CliAgentHookEvent>((resolve) => {
        server.events.once("hook", (event) => resolve(event as CliAgentHookEvent));
      });

      const response = await fetch(server.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "SessionStart",
          thread_id: sessionId,
        }),
      });

      expect(response.status).toBe(204);
      await expect(eventPromise).resolves.toMatchObject({
        type: "SessionStart",
        body: {
          thread_id: sessionId,
          sessionId,
        },
      });
    } finally {
      await server.close();
    }
  });
});
