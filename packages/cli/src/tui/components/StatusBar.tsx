/**
 * Bottom status bar showing session info and keybinding hints.
 */

import React from "react";
import { Box, Text } from "ink";
import type { AditSession } from "@adit/core";
import type { Screen } from "../hooks/useKeyboard.js";
import type { SortField } from "../../commands/list.js";

interface StatusBarProps {
  session: AditSession | null;
  eventCount: number;
  screen: Screen;
  sortField?: SortField;
}

export function StatusBar({
  session,
  eventCount,
  screen,
  sortField,
}: StatusBarProps): React.ReactElement {
  const sessionInfo = session
    ? `Session: ${session.id.substring(0, 10)} (${session.platform})`
    : "No active session";

  const sortLabel = sortField ? ` | Sort: ${sortField}` : "";

  const hints =
    screen === "timeline"
      ? "[q]uit  [/]search  [f]ilter  [s]ort  [d]iff  [e]nv  [?]help"
      : "[Esc]back  [q]uit  [?]help";

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      paddingX={1}
    >
      <Text dimColor>
        {sessionInfo} | Events: {eventCount}{sortLabel}
      </Text>
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
