/**
 * Resolves the Codex CLI binary used by adit-cloud Codex sessions.
 */

import fs from "node:fs";
import { resolveExecutable, spawnCliSync } from "./cli-process.js";

export interface CodexBinCandidate {
  bin: string;
  source: string;
  explicit: boolean;
}

export interface CodexExecutableSelection {
  bin: string;
  executable: string | null;
  source: string;
  supportsAppServer: boolean;
  debugLines: string[];
}

export const MAC_CODEX_APP_CLI = "/Applications/Codex.app/Contents/Resources/codex";

export function codexBinCandidates(explicitBin: string | undefined): CodexBinCandidate[] {
  if (explicitBin?.trim()) {
    return [{ bin: explicitBin.trim(), source: "--bin", explicit: true }];
  }

  const candidates: CodexBinCandidate[] = [];
  const aditCodexBin = process.env.ADIT_CODEX_BIN?.trim();
  const codexCliPath = process.env.CODEX_CLI_PATH?.trim();
  if (aditCodexBin) candidates.push({ bin: aditCodexBin, source: "ADIT_CODEX_BIN", explicit: false });
  if (codexCliPath) candidates.push({ bin: codexCliPath, source: "CODEX_CLI_PATH", explicit: false });
  candidates.push({ bin: "codex", source: "PATH", explicit: false });
  if (process.platform === "darwin" && fs.existsSync(MAC_CODEX_APP_CLI)) {
    candidates.push({ bin: MAC_CODEX_APP_CLI, source: "Codex.app", explicit: false });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.bin;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectCodexExecutable(explicitBin: string | undefined): CodexExecutableSelection {
  const candidates = codexBinCandidates(explicitBin);
  const debugLines: string[] = [];
  let firstResolved: Omit<CodexExecutableSelection, "debugLines"> | null = null;

  for (const candidate of candidates) {
    const executable = resolveExecutable(candidate.bin);
    if (!executable) {
      if (candidate.explicit) {
        return {
          bin: candidate.bin,
          executable: null,
          source: candidate.source,
          supportsAppServer: false,
          debugLines,
        };
      }
      continue;
    }

    const supportsAppServer = checkCodexAppServer(executable);
    const selection = {
      bin: candidate.bin,
      executable,
      source: candidate.source,
      supportsAppServer,
    };
    if (!firstResolved) firstResolved = selection;
    if (supportsAppServer || candidate.explicit) {
      return { ...selection, debugLines };
    }

    debugLines.push(`${candidate.source} Codex CLI does not expose app-server: ${executable}`);
  }

  if (firstResolved) return { ...firstResolved, debugLines };
  return {
    bin: candidates[0]?.bin ?? "codex",
    executable: null,
    source: candidates[0]?.source ?? "PATH",
    supportsAppServer: false,
    debugLines,
  };
}

export function codexBinaryMismatchDebugLines(selectedExecutable: string): string[] {
  const selectedVersion = codexVersion(selectedExecutable);
  if (!selectedVersion) return [];

  const alternatives: Array<{ label: string; bin: string }> = [
    { label: "PATH codex", bin: "codex" },
    { label: "Codex.app", bin: MAC_CODEX_APP_CLI },
  ];
  const seen = new Set([selectedExecutable]);
  const debugLines: string[] = [
    `Codex binary resolved: ${selectedExecutable} (${selectedVersion})`,
  ];

  for (const alternative of alternatives) {
    const executable = resolveExecutable(alternative.bin);
    if (!executable || seen.has(executable)) continue;
    seen.add(executable);
    const version = codexVersion(executable);
    if (!version || version === selectedVersion) continue;
    debugLines.push(
      `Ignoring ${alternative.label}: ${executable} (${version}) differs from selected Codex CLI`,
    );
  }

  return debugLines;
}

function checkCodexAppServer(command: string): boolean {
  const result = spawnCliSync(command, ["app-server", "--help"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function codexVersion(command: string): string | null {
  const result = spawnCliSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output || null;
}
