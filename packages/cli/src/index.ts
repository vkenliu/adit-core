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
import {
  labelCommand,
  labelRemoveCommand,
  labelListCommand,
  searchCommand,
} from "./commands/label.js";
import {
  diffCommand,
  promptCommand,
  envCommand,
  envLatestCommand,
  envDiffCommand,
  envHistoryCommand,
} from "./commands/diff.js";
import { doctorCommand } from "./commands/doctor.js";
import { exportCommand, exportSessionCommand } from "./commands/export.js";
import { statusCommand } from "./commands/status.js";
import { configCommand } from "./commands/config.js";
import {
  pluginInstallCommand,
  pluginUninstallCommand,
  pluginListCommand,
  pluginValidateCommand,
} from "./commands/plugin.js";
import {
  cloudLoginCommand,
  cloudLogoutCommand,
  cloudSyncCommand,
  cloudStatusCommand,
  cloudResetCredentialsCommand,
} from "./commands/cloud.js";
import { dbClearEventsCommand } from "./commands/db.js";
import {
  transcriptEnableCommand,
  transcriptDisableCommand,
  transcriptStatusCommand,
  transcriptUploadCommand,
  transcriptResetCommand,
} from "./commands/transcript.js";
import { launchTui } from "./tui/index.js";

const program = new Command();

program
  .name("adit")
  .description("AI Development Intent Tracker — The Transparent Time Machine")
  .version("0.2.0");

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
  .option("-s, --sort <field>", "Sort by field: SEQ, ACTOR, or TIME (default: TIME)")
  .option("--json", "Output as JSON")
  .action((opts) =>
    listCommand({
      limit: parseInt(opts.limit, 10),
      actor: opts.actor,
      type: opts.type,
      checkpoints: opts.checkpoints,
      query: opts.query,
      expand: opts.expand,
      sort: opts.sort ? opts.sort.toUpperCase() : undefined,
      json: opts.json,
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

// Label management
const labelCmd = program
  .command("label")
  .description("Manage labels on events");

labelCmd
  .command("add <id> <label>")
  .description("Add a label to an event")
  .action((id, label) => labelCommand(id, label));

labelCmd
  .command("remove <id> <label>")
  .description("Remove a label from an event")
  .action((id, label) => labelRemoveCommand(id, label));

labelCmd
  .command("list")
  .description("List all labels or events with a specific label")
  .option("--label <name>", "Filter by label name")
  .option("--json", "Output as JSON")
  .action((opts) => labelListCommand({ label: opts.label, json: opts.json }));

// Search
program
  .command("search <query>")
  .description("Search events by text")
  .option("-l, --limit <n>", "Max results", "20")
  .option("-a, --actor <actor>", "Filter by actor")
  .option("-t, --type <type>", "Filter by event type")
  .option("--from <date>", "Start date (ISO 8601)")
  .option("--to <date>", "End date (ISO 8601)")
  .option("--branch <branch>", "Filter by git branch")
  .option("--has-checkpoint", "Only events with checkpoints")
  .option("--format <fmt>", "Output format (json)")
  .option("--json", "Output as JSON")
  .action((query, opts) =>
    searchCommand(query, {
      limit: parseInt(opts.limit, 10),
      actor: opts.actor,
      type: opts.type,
      from: opts.from,
      to: opts.to,
      branch: opts.branch,
      hasCheckpoint: opts.hasCheckpoint,
      format: opts.format,
      json: opts.json,
    }),
  );

program
  .command("diff <id>")
  .description("Show diff for a checkpoint event")
  .option("-n, --max-lines <n>", "Max lines to show")
  .option("-o, --offset-lines <n>", "Skip first N lines")
  .option("-f, --file <path>", "Filter by file path")
  .action((id, opts) =>
    diffCommand(id, {
      maxLines: opts.maxLines ? parseInt(opts.maxLines, 10) : undefined,
      offsetLines: opts.offsetLines
        ? parseInt(opts.offsetLines, 10)
        : undefined,
      file: opts.file,
    }),
  );

program
  .command("prompt <id>")
  .description("Show prompt text for an event")
  .option("-m, --max-chars <n>", "Max characters to show")
  .option("-o, --offset <n>", "Character offset to start from")
  .action((id, opts) =>
    promptCommand(id, {
      maxChars: opts.maxChars ? parseInt(opts.maxChars, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
    }),
  );

// Environment snapshot commands
const envCmd = program
  .command("env")
  .description("Environment snapshot commands");

envCmd
  .command("show <id>")
  .description("Show environment snapshot for an event")
  .action((id) => envCommand(id));

envCmd
  .command("latest")
  .description("Show the most recent environment snapshot")
  .option("--json", "Output as JSON")
  .action((opts) => envLatestCommand({ json: opts.json }));

envCmd
  .command("diff <id1> <id2>")
  .description("Compare two environment snapshots")
  .option("--json", "Output as JSON")
  .action((id1, id2, opts) => envDiffCommand(id1, id2, { json: opts.json }));

envCmd
  .command("history")
  .description("List environment snapshot history")
  .option("-l, --limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action((opts) => envHistoryCommand({ limit: parseInt(opts.limit, 10), json: opts.json }));

program
  .command("status")
  .description("Show ADIT status for the current project")
  .option("--json", "Output as JSON")
  .action((opts) => statusCommand({ json: opts.json }));

program
  .command("doctor")
  .description("Validate ADIT installation health")
  .option("--fix", "Attempt automatic fixes")
  .option("--json", "Output as JSON")
  .action((opts) => doctorCommand({ fix: opts.fix, json: opts.json }));

// Export commands
const exportCmd = program
  .command("export")
  .description("Export event data");

exportCmd
  .command("event <id>")
  .description("Export a single event bundle")
  .option("-f, --format <fmt>", "Output format (json)", "json")
  .option("-o, --output <path>", "Output file path")
  .action((id, opts) =>
    exportCommand(id, { format: opts.format, output: opts.output }),
  );

exportCmd
  .command("session [session-id]")
  .description("Export entire session")
  .option("-f, --format <fmt>", "Output format (json|jsonl|markdown)", "json")
  .option("-o, --output <path>", "Output file path")
  .option("--from <date>", "Start date filter")
  .option("--to <date>", "End date filter")
  .option("--include-diffs", "Include full diffs")
  .option("--include-env", "Include environment snapshots")
  .option("--gzip", "Compress output with gzip")
  .action((sessionId, opts) =>
    exportSessionCommand(sessionId, {
      format: opts.format,
      output: opts.output,
      from: opts.from,
      to: opts.to,
      includeDiffs: opts.includeDiffs,
      includeEnv: opts.includeEnv,
      gzip: opts.gzip,
    }),
  );

// Config
program
  .command("config")
  .description("Show ADIT configuration")
  .option("--json", "Output as JSON")
  .action((opts) => configCommand({ json: opts.json }));

// Plugin management
const pluginCmd = program
  .command("plugin")
  .description("Manage platform plugin integrations");

pluginCmd
  .command("install [platform]")
  .description("Install ADIT hooks for a platform")
  .option("--json", "Output as JSON")
  .action((platform, opts) => pluginInstallCommand(platform, { json: opts.json }));

pluginCmd
  .command("uninstall [platform]")
  .description("Remove ADIT hooks for a platform")
  .option("--json", "Output as JSON")
  .action((platform, opts) => pluginUninstallCommand(platform, { json: opts.json }));

pluginCmd
  .command("list")
  .description("List available platform adapters")
  .option("--json", "Output as JSON")
  .action((opts) => pluginListCommand({ json: opts.json }));

pluginCmd
  .command("validate [platform]")
  .description("Validate platform plugin installation")
  .option("--json", "Output as JSON")
  .action((platform, opts) => pluginValidateCommand(platform, { json: opts.json }));

// Cloud sync
const cloudCmd = program
  .command("cloud")
  .description("Cloud sync commands");

cloudCmd
  .command("login")
  .description("Authenticate with adit-cloud via device code flow")
  .option("-s, --server <url>", "Cloud server URL")
  .action((opts) => cloudLoginCommand({ server: opts.server }));

cloudCmd
  .command("logout")
  .description("Clear stored cloud credentials")
  .action(() => cloudLogoutCommand());

cloudCmd
  .command("sync")
  .description("Push unsynced records to cloud")
  .option("--json", "Output as JSON")
  .action((opts) => cloudSyncCommand({ json: opts.json }));

cloudCmd
  .command("status")
  .description("Show cloud sync status")
  .option("--json", "Output as JSON")
  .action((opts) => cloudStatusCommand({ json: opts.json }));

cloudCmd
  .command("reset-credentials")
  .description("Force-clear all credentials and sync state")
  .option("-y, --yes", "Skip confirmation")
  .action((opts) => cloudResetCredentialsCommand({ yes: opts.yes }));

// Transcript upload management (under cloud)
const transcriptCmd = cloudCmd
  .command("transcript")
  .description("Manage transcript upload to cloud");

transcriptCmd
  .command("enable")
  .description("Enable automatic transcript upload (default)")
  .action(() => transcriptEnableCommand());

transcriptCmd
  .command("disable")
  .description("Disable automatic transcript upload")
  .action(() => transcriptDisableCommand());

transcriptCmd
  .command("status")
  .description("Show transcript upload status")
  .option("--json", "Output as JSON")
  .action((opts) => transcriptStatusCommand({ json: opts.json }));

transcriptCmd
  .command("upload")
  .description("Manually trigger transcript uploads")
  .option("--json", "Output as JSON")
  .action((opts) => transcriptUploadCommand({ json: opts.json }));

transcriptCmd
  .command("reset <id>")
  .description("Reset a failed transcript for re-upload")
  .option("--json", "Output as JSON")
  .action((id, opts) => transcriptResetCommand(id, { json: opts.json }));

// Database management
const dbCmd = program
  .command("db")
  .description("Database management commands");

dbCmd
  .command("clear-events")
  .description("Delete all local events, sessions, diffs, and env snapshots")
  .option("-y, --yes", "Skip confirmation")
  .option("--json", "Output as JSON")
  .action((opts) => dbClearEventsCommand({ yes: opts.yes, json: opts.json }));

// TUI — interactive terminal interface
program
  .command("tui")
  .description("Launch the interactive terminal UI")
  .action(() => launchTui());

program.parse();
