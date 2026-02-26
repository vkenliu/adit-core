/**
 * Colored diff output component.
 */

import React from "react";
import { Box, Text } from "ink";

interface DiffViewProps {
  diffText: string | null;
  title?: string;
}

export function DiffView({
  diffText,
  title,
}: DiffViewProps): React.ReactElement {
  if (!diffText) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No diff available</Text>
      </Box>
    );
  }

  const lines = diffText.split("\n");

  return (
    <Box flexDirection="column" paddingX={1}>
      {title && (
        <Text bold>{title}</Text>
      )}
      {lines.map((line, idx) => {
        let color: "green" | "red" | "cyan" | "yellow" | undefined;
        let dimColor = false;

        if (line.startsWith("+++") || line.startsWith("---")) {
          color = "cyan";
        } else if (line.startsWith("+")) {
          color = "green";
        } else if (line.startsWith("-")) {
          color = "red";
        } else if (line.startsWith("@@")) {
          color = "yellow";
        } else if (line.startsWith("diff ") || line.startsWith("index ")) {
          dimColor = true;
        }

        return (
          <Text key={idx} color={color} dimColor={dimColor} wrap="truncate">
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
