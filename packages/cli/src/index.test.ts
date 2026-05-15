import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createProgram, normalizeLegacyIntentCompleteArgs } from "./index.js";

function findCommand(program: Command, ...path: string[]): Command {
  let current = program;
  for (const name of path) {
    const next = current.commands.find(
      (command) => command.name() === name || command.aliases().includes(name),
    );
    if (!next) throw new Error(`Missing command: ${path.join(" ")}`);
    current = next;
  }
  return current;
}

function configureOutput(
  program: Command,
  write: (text: string) => void,
): void {
  program.configureOutput({
    writeOut: write,
    writeErr: write,
  });
  for (const command of program.commands) {
    configureOutput(command, write);
  }
}

async function parseAndCapture(args: string[]): Promise<string> {
  const chunks: string[] = [];
  const program = createProgram();
  program.exitOverride();
  configureOutput(program, (text) => chunks.push(text));

  await program.parseAsync(["node", "adit", ...args], { from: "node" });
  return chunks.join("");
}

describe("CLI help", () => {
  it("lists the current top-level commands", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("cloud");
    expect(help).toContain("docs");
    expect(help).toContain("self-update [options]");
    expect(help).toContain("help [command...]");
  });

  it("lists cloud coding and project commands", () => {
    const cloudHelp = findCommand(createProgram(), "cloud").helpInformation();

    expect(cloudHelp).toContain("claude [options] [cliArgs...]");
    expect(cloudHelp).toContain("codex [options] [cliArgs...]");
    expect(cloudHelp).toContain("link [options]");
    expect(cloudHelp).toContain("intent [options]");
  });

  it("documents the actual intent completion syntax", () => {
    const intentHelp = findCommand(
      createProgram(),
      "cloud",
      "intent",
    ).helpInformation();

    expect(intentHelp).toContain(
      "Usage: adit cloud intent [options] [command]",
    );
    expect(intentHelp).toContain("--id <id>");
    expect(intentHelp).toContain("complete [options] <id>");
  });

  it("supports nested help paths beyond one level", async () => {
    const help = await parseAndCapture(["help", "cloud", "intent"]);

    expect(help).toContain("Usage: adit cloud intent [options] [command]");
    expect(help).toContain("complete [options] <id>");
    expect(help).not.toContain("Usage: adit cloud [options] [command]");
  });

  it("shows leaf help for intent completion", async () => {
    const help = await parseAndCapture(["help", "cloud", "intent", "complete"]);

    expect(help).toContain("Usage: adit cloud intent complete [options] <id>");
    expect(help).toContain("--phase <number>");
  });

  it("supports nested help for leaf commands", async () => {
    const help = await parseAndCapture(["help", "docs", "scaffold"]);

    expect(help).toContain("Usage: adit docs scaffold [options] [type]");
    expect(help).toContain("-o, --output <path>");
  });

  it("rewrites the legacy intent completion syntax", () => {
    expect(
      normalizeLegacyIntentCompleteArgs([
        "node",
        "adit",
        "cloud",
        "intent",
        "--id",
        "intent-123",
        "complete",
        "--phase",
        "2",
      ]),
    ).toEqual([
      "node",
      "adit",
      "cloud",
      "intent",
      "complete",
      "intent-123",
      "--phase",
      "2",
    ]);
  });

  it("does not rewrite the current intent completion syntax", () => {
    const args = [
      "node",
      "adit",
      "cloud",
      "intent",
      "complete",
      "intent-123",
      "--phase",
      "2",
    ];

    expect(normalizeLegacyIntentCompleteArgs(args)).toBe(args);
  });
});
