import type { Command } from "commander";
import { cloudClaudeCommand } from "./cloud-claude.js";
import { cloudCodexCommand } from "./cloud-codex.js";

interface CloudCliAgentOptions {
  bin?: string;
  arg?: string[];
}

interface CloudCliAgentHandlers {
  claude?: typeof cloudClaudeCommand;
  codex?: typeof cloudCodexCommand;
}

export function mergeCloudCliAgentArgs(
  optionArgs: string[] | undefined,
  trailingArgs: string[] | undefined,
): string[] {
  return [...(optionArgs ?? []), ...(trailingArgs ?? [])];
}

export function registerCloudCliAgentCommands(
  cloudCmd: Command,
  handlers: CloudCliAgentHandlers = {},
): void {
  const runClaude = handlers.claude ?? cloudClaudeCommand;
  const runCodex = handlers.codex ?? cloudCodexCommand;

  cloudCmd
    .command("claude")
    .description("Connect local Claude Code CLI to adit-cloud Coding")
    .allowUnknownOption(true)
    .argument("[cliArgs...]", "Args passed to Claude Code")
    .option("--bin <name>", "Claude CLI binary", "claude")
    .option("--arg <a...>", "Extra args passed to Claude Code", [] as string[])
    .action((cliArgs: string[], opts: CloudCliAgentOptions) =>
      runClaude({
        bin: opts.bin,
        arg: mergeCloudCliAgentArgs(opts.arg, cliArgs),
      }),
    );

  cloudCmd
    .command("codex")
    .description("Connect local Codex CLI to adit-cloud Coding")
    .allowUnknownOption(true)
    .argument("[cliArgs...]", "Args passed to Codex CLI")
    .option("--bin <name>", "Codex CLI binary")
    .option("--arg <a...>", "Extra args passed to Codex CLI", [] as string[])
    .action((cliArgs: string[], opts: CloudCliAgentOptions) =>
      runCodex({
        bin: opts.bin,
        arg: mergeCloudCliAgentArgs(opts.arg, cliArgs),
      }),
    );
}
