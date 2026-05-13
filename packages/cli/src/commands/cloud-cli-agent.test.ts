import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  mergeCloudCliAgentArgs,
  registerCloudCliAgentCommands,
} from "./cloud-cli-agent.js";

interface CapturedRun {
  provider: "claude" | "codex";
  bin?: string;
  arg?: string[];
}

async function parseCloudAgentCommand(args: string[]): Promise<CapturedRun> {
  const runs: CapturedRun[] = [];
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });

  const cloudCmd = program.command("cloud");
  registerCloudCliAgentCommands(cloudCmd, {
    claude: async (opts = {}) => {
      runs.push({
        provider: "claude",
        bin: opts.bin,
        arg: opts.arg,
      });
    },
    codex: async (opts = {}) => {
      runs.push({
        provider: "codex",
        bin: opts.bin,
        arg: opts.arg,
      });
    },
  });

  await program.parseAsync(["node", "adit", ...args], { from: "node" });
  expect(runs).toHaveLength(1);
  return runs[0];
}

describe("cloud CLI agent command passthrough", () => {
  it("passes Claude --continue as a natural trailing arg", async () => {
    await expect(
      parseCloudAgentCommand(["cloud", "claude", "--continue"]),
    ).resolves.toEqual({
      provider: "claude",
      bin: "claude",
      arg: ["--continue"],
    });
  });

  it("passes multiple unknown Claude options in order", async () => {
    await expect(
      parseCloudAgentCommand([
        "cloud",
        "claude",
        "--model",
        "sonnet",
        "--continue",
      ]),
    ).resolves.toEqual({
      provider: "claude",
      bin: "claude",
      arg: ["--model", "sonnet", "--continue"],
    });
  });

  it("passes Codex resume as a natural trailing arg", async () => {
    await expect(
      parseCloudAgentCommand(["cloud", "codex", "resume"]),
    ).resolves.toEqual({
      provider: "codex",
      bin: "codex",
      arg: ["resume"],
    });
  });

  it("passes Codex resume options in order", async () => {
    await expect(
      parseCloudAgentCommand(["cloud", "codex", "resume", "--last"]),
    ).resolves.toEqual({
      provider: "codex",
      bin: "codex",
      arg: ["resume", "--last"],
    });
  });

  it("keeps wrapper --bin while passing remaining Codex args", async () => {
    await expect(
      parseCloudAgentCommand([
        "cloud",
        "codex",
        "--bin",
        "codex-dev",
        "resume",
      ]),
    ).resolves.toEqual({
      provider: "codex",
      bin: "codex-dev",
      arg: ["resume"],
    });
  });

  it("keeps the legacy --arg passthrough form", async () => {
    await expect(
      parseCloudAgentCommand(["cloud", "claude", "--arg", "--continue"]),
    ).resolves.toEqual({
      provider: "claude",
      bin: "claude",
      arg: ["--continue"],
    });
  });

  it("merges legacy --arg values before natural trailing args", () => {
    expect(mergeCloudCliAgentArgs(["--search"], ["resume"])).toEqual([
      "--search",
      "resume",
    ]);
  });
});
