/**
 * Bottom status bar showing session info and keybinding hints.
 */

import React from "react";
import { Box, Text } from "ink";
import type { AditSession } from "@adit/core";
import type { Screen } from "../hooks/useKeyboard.js";

interface StatusBarProps {
  session: AditSession | null;
  eventCount: number;
  screen: Screen;
}

export function StatusBar({
  session,
  eventCount,
  screen,
}: StatusBarProps): React.ReactElement {
  const sessionInfo = session
    ? `Session: ${session.id.substring(0, 10)} (${session.platform})`
    : "No active session";

  const hints =
    screen === "timeline"
      ? "[q]uit  [/]search  [f]ilter  [d]iff  [e]nv  [?]help"
      : "[Esc]back  [q]uit  [?]help";

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      paddingX={1}
    >
      <Text dimColor>
        {sessionInfo} | Events: {eventCount}
      </Text>
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
