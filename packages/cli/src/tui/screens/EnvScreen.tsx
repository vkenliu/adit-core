/**
 * Environment snapshot screen — displays env details + drift indicators.
 */

import React from "react";
import { Box, Text } from "ink";
import type { EnvSnapshot } from "@adit/core";

interface EnvScreenProps {
  snapshot: EnvSnapshot | null;
}

function parseJsonSafe(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function EnvScreen({
  snapshot,
}: EnvScreenProps): React.ReactElement {
  if (!snapshot) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Environment Snapshot</Text>
        <Text dimColor>No environment snapshot available.</Text>
        <Box marginTop={1}>
          <Text dimColor>[Esc] back</Text>
        </Box>
      </Box>
    );
  }

  const runtimes = parseJsonSafe(snapshot.runtimeVersionsJson);
  const system = parseJsonSafe(snapshot.systemResourcesJson);
  const container = parseJsonSafe(snapshot.containerInfo);
  const shell = parseJsonSafe(snapshot.shellInfo);
  const pkgMgr = parseJsonSafe(snapshot.packageManagerJson);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Environment Snapshot</Text>
      <Text dimColor>{"─".repeat(40)}</Text>

      <Text bold dimColor>Git</Text>
      <Box flexDirection="row">
        <Text dimColor>Branch:{"    "}</Text>
        <Text>{snapshot.gitBranch ?? "unknown"}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>HEAD:{"      "}</Text>
        <Text>{snapshot.gitHeadSha?.substring(0, 10) ?? "unknown"}</Text>
      </Box>

      <Text bold dimColor>{""}Runtimes</Text>
      <Box flexDirection="row">
        <Text dimColor>Node:{"      "}</Text>
        <Text>{snapshot.nodeVersion ?? "not found"}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>Python:{"    "}</Text>
        <Text>{snapshot.pythonVersion ?? "not found"}</Text>
      </Box>
      {runtimes &&
        Object.entries(runtimes).map(([k, v]) => (
          <Box key={k} flexDirection="row">
            <Text dimColor>{k}:{"  ".repeat(Math.max(1, 5 - k.length))}</Text>
            <Text>{String(v)}</Text>
          </Box>
        ))}

      <Text bold dimColor>{""}Dependencies</Text>
      <Box flexDirection="row">
        <Text dimColor>Lock file:{"  "}</Text>
        <Text>{snapshot.depLockPath ?? "none"}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>Lock hash:{"  "}</Text>
        <Text>{snapshot.depLockHash ?? "n/a"}</Text>
      </Box>
      {pkgMgr && (
        <Box flexDirection="row">
          <Text dimColor>Pkg mgr:{"   "}</Text>
          <Text>
            {String(pkgMgr.name)} {String(pkgMgr.version ?? "")}
          </Text>
        </Box>
      )}

      <Text bold dimColor>{""}System</Text>
      <Box flexDirection="row">
        <Text dimColor>OS:{"        "}</Text>
        <Text>{snapshot.osInfo ?? "unknown"}</Text>
      </Box>
      {system && (
        <>
          <Box flexDirection="row">
            <Text dimColor>Arch:{"      "}</Text>
            <Text>{String(system.arch ?? "unknown")}</Text>
          </Box>
          <Box flexDirection="row">
            <Text dimColor>CPU:{"       "}</Text>
            <Text>{String(system.cpuModel ?? "unknown")}</Text>
          </Box>
        </>
      )}
      {container && (
        <Box flexDirection="row">
          <Text dimColor>Container:{"  "}</Text>
          <Text color={(container.inDocker as boolean) ? "yellow" : undefined}>
            {(container.inDocker as boolean) ? "Docker" : "None"}
          </Text>
        </Box>
      )}
      {shell && (
        <Box flexDirection="row">
          <Text dimColor>Shell:{"     "}</Text>
          <Text>
            {String(shell.shell ?? "unknown")} {String(shell.version ?? "")}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          Captured: {snapshot.capturedAt} | [Esc] back
        </Text>
      </Box>
    </Box>
  );
}
