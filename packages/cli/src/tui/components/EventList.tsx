/**
 * Scrollable event list for the timeline.
 */

import React from "react";
import { Box, Text } from "ink";
import type { AditEvent } from "@adit/core";
import type { SortField } from "../../commands/list.js";
import { getEventSummary } from "../../utils/summary.js";

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
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const time = d.toLocaleTimeString("en-US", { hour12: false });
    return `${month}/${day} ${time}`;
  } catch {
    return iso.substring(5, 19).replace("T", " ");
  }
}

function getSummary(event: AditEvent): string {
  return getEventSummary(event, 50);
}

function sortIndicator(column: string, sortField?: SortField): string {
  if (!sortField) return "";
  if (
    (column === "TIME" && sortField === "TIME") ||
    (column === "ACTOR" && sortField === "ACTOR")
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
          {"  "}TIME{sortIndicator("TIME", sortField)}{"           "}ACTOR{sortIndicator("ACTOR", sortField)}{"  "}SUMMARY
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
