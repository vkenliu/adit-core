/**
 * Cross-shell hook command construction.
 *
 * Hook configs are stored as command strings and may run under different
 * shells. Keep them free of shell-specific environment-prefix syntax so they
 * work in cmd.exe, PowerShell, Git Bash, and Unix shells.
 */

import type { Platform } from "@varveai/adit-core";
import type { AditHookType } from "./types.js";

export type HookPlatformArg = Platform | "claude";

export interface ParsedHookArgs {
  platform: HookPlatformArg | null;
  hookType: string | null;
}

/** Build an ADIT hook command that is portable across common shells. */
export function buildAditHookCommand(
  aditBinaryPath: string,
  platform: HookPlatformArg,
  hookType: AditHookType,
): string {
  return `${aditBinaryPath} --platform ${platform} ${hookType}`;
}

/** Parse adit-hook CLI args, preserving compatibility with old positional commands. */
export function parseHookArgs(args: readonly string[]): ParsedHookArgs {
  let platform: HookPlatformArg | null = null;
  let hookType: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--platform") {
      const value = args[index + 1];
      if (isHookPlatformArg(value)) {
        platform = value;
      }
      index++;
      continue;
    }
    if (arg?.startsWith("--platform=")) {
      const value = arg.slice("--platform=".length);
      if (isHookPlatformArg(value)) {
        platform = value;
      }
      continue;
    }
    if (!arg?.startsWith("-") && hookType === null) {
      hookType = arg;
    }
  }

  return { platform, hookType };
}

/** Check whether a command string invokes the ADIT hook dispatcher. */
export function isAditHookCommand(command: string): boolean {
  const normalized = command.replace(/\\/gu, "/");
  return normalized.includes("adit-hook") || normalized.includes("hooks/dist/index.js");
}

function isHookPlatformArg(value: string | undefined): value is HookPlatformArg {
  return value === "claude"
    || value === "claude-code"
    || value === "claude-vscode"
    || value === "cursor"
    || value === "copilot"
    || value === "opencode"
    || value === "codex"
    || value === "gemini"
    || value === "other";
}
