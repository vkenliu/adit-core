/**
 * Event detail panel — shows full details of the selected event.
 */

import React from "react";
import { Box, Text } from "ink";
import { parseLabels, parseDiffStats, parseError, type AditEvent } from "@adit/core";

interface EventDetailProps {
  event: AditEvent | null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function prettyJson(json: string, maxLen: number): string {
  try {
    const parsed = JSON.parse(json);
    const pretty = JSON.stringify(parsed, null, 2);
    return truncate(pretty.replace(/\n/g, " "), maxLen);
  } catch {
    return truncate(json.replace(/\n/g, " "), maxLen);
  }
}

export function EventDetail({
  event,
}: EventDetailProps): React.ReactElement {
  if (!event) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No event selected</Text>
      </Box>
    );
  }

  const labels = parseLabels(event.labelsJson);
  const stats = parseDiffStats(event.diffStatJson);
  const error = parseError(event.errorJson);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Event Detail</Text>
      <Text dimColor>{"─".repeat(30)}</Text>

      <Box flexDirection="row">
        <Text dimColor>ID:{"        "}</Text>
        <Text>{event.id}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>Type:{"      "}</Text>
        <Text>{event.eventType}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>Actor:{"     "}</Text>
        <Text>{event.actor}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>Seq:{"       "}</Text>
        <Text>{String(event.sequence)}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>Status:{"    "}</Text>
        <Text color={event.status === "error" ? "red" : "green"}>
          {event.status}
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>Started:{"   "}</Text>
        <Text>{event.startedAt}</Text>
      </Box>

      {event.endedAt && (
        <Box flexDirection="row">
          <Text dimColor>Ended:{"     "}</Text>
          <Text>{event.endedAt}</Text>
          <Text dimColor> ({formatDuration(event.startedAt, event.endedAt)})</Text>
        </Box>
      )}

      <Box flexDirection="row">
        <Text dimColor>Session:{"   "}</Text>
        <Text>{event.sessionId}</Text>
      </Box>

      {event.parentEventId && (
        <Box flexDirection="row">
          <Text dimColor>Parent:{"    "}</Text>
          <Text>{event.parentEventId}</Text>
        </Box>
      )}

      {event.clientId && (
        <Box flexDirection="row">
          <Text dimColor>Client:{"    "}</Text>
          <Text>{event.clientId}</Text>
        </Box>
      )}

      {event.gitBranch && (
        <Box flexDirection="row">
          <Text dimColor>Branch:{"    "}</Text>
          <Text>{event.gitBranch}</Text>
          {event.gitHeadSha && (
            <Text dimColor> @ {event.gitHeadSha.substring(0, 8)}</Text>
          )}
        </Box>
      )}

      {event.checkpointSha && (
        <Box flexDirection="row">
          <Text dimColor>Checkpoint:</Text>
          <Text color="green"> {event.checkpointSha.substring(0, 10)}</Text>
        </Box>
      )}

      {event.checkpointRef && (
        <Box flexDirection="row">
          <Text dimColor>Ref:{"       "}</Text>
          <Text>{event.checkpointRef}</Text>
        </Box>
      )}

      {event.envSnapshotId && (
        <Box flexDirection="row">
          <Text dimColor>Env Snap:{"  "}</Text>
          <Text>{event.envSnapshotId}</Text>
        </Box>
      )}

      {event.planTaskId && (
        <Box flexDirection="row">
          <Text dimColor>Plan Task:{" "}</Text>
          <Text>{event.planTaskId}</Text>
        </Box>
      )}

      {event.toolName && (
        <Box flexDirection="row">
          <Text dimColor>Tool:{"      "}</Text>
          <Text color="yellow">{event.toolName}</Text>
        </Box>
      )}

      {event.promptText && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Prompt:</Text>
          <Text wrap="truncate">
            {truncate(event.promptText.replace(/\n/g, " "), 200)}
          </Text>
        </Box>
      )}

      {event.cotText && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Chain of Thought:</Text>
          <Text wrap="truncate">
            {truncate(event.cotText.replace(/\n/g, " "), 200)}
          </Text>
        </Box>
      )}

      {event.responseText && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Response:</Text>
          <Text wrap="truncate">
            {truncate(event.responseText.replace(/\n/g, " "), 200)}
          </Text>
        </Box>
      )}

      {event.toolInputJson && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Tool Input:</Text>
          <Text wrap="truncate">{prettyJson(event.toolInputJson, 200)}</Text>
        </Box>
      )}

      {event.toolOutputJson && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Tool Output:</Text>
          <Text wrap="truncate">{prettyJson(event.toolOutputJson, 200)}</Text>
        </Box>
      )}

      {stats.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Files ({stats.length}):</Text>
          {stats.slice(0, 8).map((f) => (
            <Text key={f.path}>
              <Text color={f.status === "A" ? "green" : f.status === "D" ? "red" : "yellow"}>
                {f.status}
              </Text>
              {" "}
              {f.path}
            </Text>
          ))}
          {stats.length > 8 && (
            <Text dimColor>... and {stats.length - 8} more</Text>
          )}
        </Box>
      )}

      {labels.length > 0 && (
        <Box flexDirection="row" marginTop={1}>
          <Text dimColor>Labels: </Text>
          <Text color="cyan">{labels.join(", ")}</Text>
        </Box>
      )}

      {error && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>Error: {error.category}</Text>
          <Text color="red">{truncate(error.message, 100)}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>[d]iff [p]rompt [e]nv [l]abel [r]evert</Text>
      </Box>
    </Box>
  );
}
