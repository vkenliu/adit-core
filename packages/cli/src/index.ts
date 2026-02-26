#!/usr/bin/env node

/**
 * ADIT CLI — AI Development Intent Tracker
 *
 * The main command-line interface for inspecting and managing
 * the ADIT timeline.
 */

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { showCommand } from "./commands/show.js";
import { revertCommand, undoCommand } from "./commands/revert.js";
import { labelCommand, searchCommand } from "./commands/label.js";
import { diffCommand, promptCommand, envCommand } from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportCommand } from "./commands/export.js";

const program = new Command();

program
  .name("adit")
  .description("AI Development Intent Tracker — The Transparent Time Machine")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize ADIT in the current project")
  .action(() => initCommand({ cwd: process.cwd() }));

program
  .command("list")
  .alias("ls")
  .description("Show timeline entries")
  .option("-l, --limit <n>", "Number of entries to show", "20")
  .option("-a, --actor <actor>", "Filter by actor (assistant|user|tool)")
  .option("-t, --type <type>", "Filter by event type")
  .option("-c, --checkpoints", "Only show checkpoint events")
  .option("-q, --query <text>", "Search by text")
  .option("-e, --expand", "Show expanded summaries")
  .action((opts) =>
    listCommand({
      limit: parseInt(opts.limit, 10),
      actor: opts.actor,
      type: opts.type,
      checkpoints: opts.checkpoints,
      query: opts.query,
      expand: opts.expand,
    }),
  );

program
  .command("show <id>")
  .description("Show full event details")
  .action((id) => showCommand(id));

program
  .command("revert <id>")
  .description("Revert working tree to a checkpoint")
  .option("-y, --yes", "Skip confirmation")
  .action((id, opts) => revertCommand(id, { yes: opts.yes }));

program
  .command("undo")
  .description("Revert to parent of last checkpoint")
  .option("-y, --yes", "Skip confirmation")
  .action((opts) => undoCommand({ yes: opts.yes }));

program
  .command("label <id> <label>")
  .description("Add a label to an event")
  .action((id, label) => labelCommand(id, label));

program
  .command("search <query>")
  .description("Search events by text")
  .option("-l, --limit <n>", "Max results", "20")
  .action((query, opts) =>
    searchCommand(query, { limit: parseInt(opts.limit, 10) }),
  );

program
  .command("diff <id>")
  .description("Show diff for a checkpoint event")
  .option("-n, --max-lines <n>", "Max lines to show")
  .option("-f, --file <path>", "Filter by file path")
  .action((id, opts) =>
    diffCommand(id, {
      maxLines: opts.maxLines ? parseInt(opts.maxLines, 10) : undefined,
      file: opts.file,
    }),
  );

program
  .command("prompt <id>")
  .description("Show prompt text for an event")
  .action((id) => promptCommand(id));

program
  .command("env <id>")
  .description("Show environment snapshot for an event")
  .action((id) => envCommand(id));

program
  .command("doctor")
  .description("Validate ADIT installation health")
  .action(() => doctorCommand());

program
  .command("export <id>")
  .description("Export an event bundle")
  .option("-f, --format <fmt>", "Output format (json|jsonl)", "json")
  .option("-o, --output <path>", "Output file path")
  .action((id, opts) =>
    exportCommand(id, { format: opts.format, output: opts.output }),
  );

program.parse();
