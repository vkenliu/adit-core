/**
 * Filter bar — actor/type filter chips.
 */

import React from "react";
import { Box, Text } from "ink";
import type { Actor, EventType } from "@adit/core";
import type { TimelineFilters } from "../hooks/useTimeline.js";

interface FilterBarProps {
  filters: TimelineFilters;
  visible: boolean;
}

const ACTORS: Actor[] = ["assistant", "user", "tool", "system"];
const EVENT_TYPES: EventType[] = [
  "prompt_submit",
  "assistant_response",
  "tool_call",
  "checkpoint",
  "env_snapshot",
  "task_completed",
  "notification",
  "subagent_start",
  "subagent_stop",
];

export function FilterBar({
  filters,
  visible,
}: FilterBarProps): React.ReactElement | null {
  if (!visible) return null;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Actor: </Text>
        {ACTORS.map((a) => (
          <Text
            key={a}
            color={filters.actor === a ? "green" : undefined}
            bold={filters.actor === a}
            dimColor={filters.actor !== a && filters.actor !== undefined}
          >
            [{a.charAt(0).toUpperCase()}]{a.slice(1)}
          </Text>
        ))}
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Type:{"  "}</Text>
        {EVENT_TYPES.map((t) => (
          <Text
            key={t}
            color={filters.eventType === t ? "green" : undefined}
            bold={filters.eventType === t}
            dimColor={
              filters.eventType !== t && filters.eventType !== undefined
            }
          >
            {t}
          </Text>
        ))}
      </Box>
      {filters.hasCheckpoint && (
        <Text color="green" bold>
          Showing only checkpoint events
        </Text>
      )}
    </Box>
  );
}
