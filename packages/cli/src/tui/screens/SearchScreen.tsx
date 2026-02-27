/**
 * Search screen — text search with highlighted results.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AditEvent } from "@adit/core";

interface SearchScreenProps {
  onSearch: (query: string) => void;
  events: AditEvent[];
  selectedIndex: number;
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

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

function getSummary(event: AditEvent): string {
  if (event.promptText)
    return truncate(event.promptText.replace(/\n/g, " "), 60);
  if (event.toolName) return event.toolName;
  if (event.responseText)
    return truncate(event.responseText.replace(/\n/g, " "), 60);
  return event.eventType;
}

export function SearchScreen({
  onSearch,
  events,
  selectedIndex,
}: SearchScreenProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useInput(
    (input, key) => {
      if (key.return && !submitted) {
        setSubmitted(true);
        onSearch(query);
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input && !key.escape) {
        setQuery((q) => q + input);
      }
    },
    { isActive: !submitted },
  );

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box flexDirection="row" marginBottom={1}>
        <Text bold>Search: </Text>
        <Text color="cyan">{query}</Text>
        {!submitted && <Text dimColor>_</Text>}
      </Box>

      {submitted && events.length === 0 && (
        <Text dimColor>No results found for "{query}"</Text>
      )}

      {submitted && events.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>
            {events.length} result{events.length !== 1 ? "s" : ""}:
          </Text>
          {events.map((event, idx) => (
            <Box key={event.id} flexDirection="row">
              <Text inverse={idx === selectedIndex}>
                {idx === selectedIndex ? ">" : " "}{" "}
              </Text>
              <Text dimColor>{formatTime(event.startedAt)} </Text>
              <Text color="cyan">{actorSymbol(event.actor)} </Text>
              <Text>{getSummary(event)}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {submitted ? "[Esc] back" : "Type query and press [Enter]"}
        </Text>
      </Box>
    </Box>
  );
}
