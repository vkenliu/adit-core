import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SpawnedProcess, SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const WINDOWS_SHELL_EXTENSIONS = new Set([".bat", ".cmd"]);
const WINDOWS_NATIVE_EXTENSIONS = new Set([".com", ".exe"]);
const WINDOWS_IGNORED_SHIM_EXTENSIONS = new Set([".ps1"]);

export function resolveExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (hasPathSeparator(trimmed)) {
    return fs.existsSync(trimmed) ? trimmed : null;
  }

  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [trimmed], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  return pickExecutableCandidate(trimmed, splitExecutableCandidates(result.stdout));
}

export function pickExecutableCandidate(
  command: string,
  candidates: string[],
): string | null {
  const usable = candidates.map((candidate) => candidate.trim()).filter(Boolean);
  if (usable.length === 0) return null;
  if (process.platform !== "win32") return usable[0] ?? null;

  const commandExt = path.win32.extname(command).toLowerCase();
  if (commandExt) {
    return usable.find((candidate) =>
      path.win32.extname(candidate).toLowerCase() === commandExt
    ) ?? usable[0] ?? null;
  }

  return usable
    .filter((candidate) => !WINDOWS_IGNORED_SHIM_EXTENSIONS.has(path.win32.extname(candidate).toLowerCase()))
    .sort((left, right) => windowsExecutableScore(left) - windowsExecutableScore(right))[0]
    ?? usable[0]
    ?? null;
}

export function spawnCliProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, args, {
    ...options,
    shell: options.shell ?? shouldUseWindowsShell(command),
    windowsHide: options.windowsHide ?? true,
  });
}

export function spawnCliSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, {
    ...options,
    shell: options.shell ?? shouldUseWindowsShell(command),
    windowsHide: options.windowsHide ?? true,
  });
}

export function spawnClaudeCliProcess(options: ClaudeSpawnOptions): SpawnedProcess {
  return spawnCliProcess(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
  }) as SpawnedProcess;
}

export function shouldUseWindowsShell(command: string): boolean {
  return process.platform === "win32" &&
    WINDOWS_SHELL_EXTENSIONS.has(path.win32.extname(command).toLowerCase());
}

function splitExecutableCandidates(stdout: string): string[] {
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function windowsExecutableScore(candidate: string): number {
  const ext = path.win32.extname(candidate).toLowerCase();
  if (WINDOWS_NATIVE_EXTENSIONS.has(ext)) return 0;
  if (WINDOWS_SHELL_EXTENSIONS.has(ext)) return 1;
  if (!ext) return 2;
  return 3;
}
