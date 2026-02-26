/**
 * PostToolUse hook handler for Claude Code.
 *
 * Fires after every tool call. Records tool_call events
 * with the tool name, input, and output.
 */

import { redactSensitiveKeys } from "@adit/core";
import { createTimelineManager } from "@adit/engine";
import { initHookContext, readStdin } from "../common/context.js";

export async function handleToolUse(): Promise<void> {
  const input = await readStdin();

  const cwd = (input.cwd as string) ?? process.cwd();
  const toolName = input.tool_name as string | undefined;
  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const toolOutput = input.tool_output as Record<string, unknown> | undefined;

  if (!toolName) return;

  const ctx = await initHookContext(cwd);
  const timeline = createTimelineManager(ctx.db, ctx.config);

  // Redact sensitive data from tool I/O
  const safeInput = toolInput
    ? redactSensitiveKeys(toolInput, ctx.config.redactKeys)
    : null;
  const safeOutput = toolOutput
    ? redactSensitiveKeys(toolOutput, ctx.config.redactKeys)
    : null;

  // Determine actor: MCP calls vs built-in tools vs subagents
  let eventType: "tool_call" | "mcp_call" | "subagent_call" | "skill_call" =
    "tool_call";

  if (toolName.includes("/")) {
    // MCP tools use namespace/toolName format
    eventType = "mcp_call";
  } else if (toolName === "Task" || toolName === "task") {
    eventType = "subagent_call";
  } else if (toolName === "Skill" || toolName === "skill") {
    eventType = "skill_call";
  }

  await timeline.recordEvent({
    sessionId: ctx.session.id,
    eventType,
    actor: "tool",
    toolName,
    toolInputJson: safeInput ? JSON.stringify(safeInput) : null,
    toolOutputJson: safeOutput ? JSON.stringify(safeOutput) : null,
  });

  ctx.db.close();
}
