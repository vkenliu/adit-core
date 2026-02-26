/**
 * Scrollable event list for the timeline.
 */

import React from "react";
import { Box, Text } from "ink";
import type { AditEvent } from "@adit/core";
import type { SortField } from "../../commands/list.js";

interface EventListProps {
  events: AditEvent[];
  selectedIndex: number;
  height: number;
  sortField?: SortField;
}

function actorSymbol(actor: string): string {
  switch (actor) {
    case "assistant":
      return "[A]";
    case "user":
      return "[U]";
    case "tool":
      return "[T]";
    case "system":
      return "[S]";
    default:
      return "[?]";
  }
}

function actorColor(
  actor: string,
): "green" | "cyan" | "yellow" | "magenta" | "white" {
  switch (actor) {
    case "assistant":
      return "green";
    case "user":
      return "cyan";
    case "tool":
      return "yellow";
    case "system":
      return "magenta";
    default:
      return "white";
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return iso.substring(11, 19);
  }
}

function getSummary(event: AditEvent): string {
  if (event.promptText) {
    return truncate(event.promptText.replace(/\n/g, " "), 50);
  }
  if (event.toolName) {
    return event.toolName;
  }
  if (event.checkpointSha) {
    return `checkpoint ${event.checkpointSha.substring(0, 8)}`;
  }
  if (event.responseText) {
    return truncate(event.responseText.replace(/\n/g, " "), 50);
  }
  return event.eventType;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

function sortIndicator(column: string, sortField?: SortField): string {
  if (!sortField) return "";
  if (
    (column === "TIME" && sortField === "TIME") ||
    (column === "ACTOR" && sortField === "ACTOR") ||
    (column === "SEQ" && sortField === "SEQ")
  ) {
    return sortField === "ACTOR" ? " ↑" : " ↓";
  }
  return "";
}

export function EventList({
  events,
  selectedIndex,
  height,
  sortField,
}: EventListProps): React.ReactElement {
  // Calculate visible window
  const visibleHeight = Math.max(height - 2, 5);
  const halfVisible = Math.floor(visibleHeight / 2);
  let scrollStart = Math.max(0, selectedIndex - halfVisible);
  const scrollEnd = Math.min(events.length, scrollStart + visibleHeight);
  if (scrollEnd === events.length) {
    scrollStart = Math.max(0, scrollEnd - visibleHeight);
  }
  const visible = events.slice(scrollStart, scrollEnd);

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" paddingX={1}>
        <Text bold dimColor>
          {"  "}TIME{sortIndicator("TIME", sortField)}{"     "}ACTOR{sortIndicator("ACTOR", sortField)}{"  "}SUMMARY
        </Text>
      </Box>
      {visible.map((event, idx) => {
        const actualIndex = scrollStart + idx;
        const isSelected = actualIndex === selectedIndex;
        const time = formatTime(event.startedAt);
        const actor = actorSymbol(event.actor);
        const color = actorColor(event.actor);
        const summary = getSummary(event);
        const hasCheckpoint = !!event.checkpointSha;

        return (
          <Box key={event.id} flexDirection="row" paddingX={1}>
            <Text inverse={isSelected}>
              {isSelected ? ">" : " "}{" "}
            </Text>
            <Text inverse={isSelected} dimColor={!isSelected}>
              {time}
            </Text>
            <Text inverse={isSelected}>{" "}</Text>
            <Text inverse={isSelected} color={color}>
              {actor}
            </Text>
            <Text inverse={isSelected}>{" "}</Text>
            <Text inverse={isSelected} bold={hasCheckpoint}>
              {summary}
            </Text>
            {hasCheckpoint && !isSelected && (
              <Text color="green">{" "}*</Text>
            )}
          </Box>
        );
      })}
      {events.length > visibleHeight && (
        <Box paddingX={1}>
          <Text dimColor>
            [{scrollStart + 1}-{scrollEnd} of {events.length}]
          </Text>
        </Box>
      )}
    </Box>
  );
}
