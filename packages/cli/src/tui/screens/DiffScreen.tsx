/**
 * Diff viewer screen — shows syntax-highlighted diff for a checkpoint event.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { DiffView } from "../components/DiffView.js";
import type { AditEvent } from "@varveai/adit-core";

interface DiffScreenProps {
  event: AditEvent | null;
  getDiff: (eventId: string) => string | null;
}

export function DiffScreen({
  event,
  getDiff,
}: DiffScreenProps): React.ReactElement {
  const [diffText, setDiffText] = useState<string | null>(null);

  useEffect(() => {
    if (event?.id) {
      const text = getDiff(event.id);
      setDiffText(text);
    }
  }, [event, getDiff]);

  if (!event) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>No event selected. Press [Esc] to go back.</Text>
      </Box>
    );
  }

  if (!event.checkpointSha) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          Event {event.id.substring(0, 10)} has no checkpoint. Press [Esc] to
          go back.
        </Text>
      </Box>
    );
  }

  const title = `Diff for checkpoint ${event.checkpointSha.substring(0, 10)} (event ${event.id.substring(0, 10)})`;

  return (
    <Box flexDirection="column" width="100%">
      <DiffView diffText={diffText} title={title} />
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>[Esc] back to timeline</Text>
      </Box>
    </Box>
  );
}
