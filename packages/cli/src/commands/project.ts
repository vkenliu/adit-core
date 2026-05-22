/**
 * `adit project` — Project-level lifecycle commands.
 *
 * These commands manage ADIT's local footprint for the current git project,
 * above the lower-level per-platform hooks.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@varveai/adit-core";
import { deleteCheckpointRef, listCheckpointRefs } from "@varveai/adit-engine";
import { uninstallInstalledPlatformHooks } from "./plugin.js";

export interface ProjectUninstallResult {
  ok: boolean;
  action: "project-uninstall";
  projectRoot: string;
  dataDir: string;
  uninstalled: string[];
  dataRemoved: boolean;
  generatedFilesRemoved: number;
  checkpointRefsRemoved: number;
  errors?: string[];
}

const initGeneratedFiles = [
  ".claude/skills/generate-docs.md",
  ".opencode/commands/generate-docs.md",
  ".cursor/rules/generate-docs.mdc",
];

export async function projectUninstallCommand(opts?: {
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const config = loadConfig();

  if (!opts?.yes) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        action: "project-uninstall",
        error: "--yes is required",
        projectRoot: config.projectRoot,
        dataDir: config.dataDir,
      }));
    } else {
      console.log();
      console.log("  This will uninstall ADIT from the current project.");
      console.log();
      console.log(`  Project:        ${config.projectRoot}`);
      console.log(`  Data directory: ${config.dataDir}`);
      console.log();
      console.log("  It will remove installed ADIT hooks, delete the local .adit/ data directory,");
      console.log("  and delete git checkpoint refs under refs/adit/checkpoints/.");
      console.log();
      console.log("  Run with --yes to confirm.");
      console.log();
    }
    process.exitCode = 1;
    return;
  }

  const result = await uninstallProject(config.projectRoot, config.dataDir);

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log();
  for (const displayName of result.uninstalled) {
    console.log(`  [~] Removed ${displayName} hooks`);
  }
  if (result.uninstalled.length === 0) {
    console.log("  No ADIT hooks found to remove.");
  }
  if (result.dataRemoved) {
    console.log(`  [~] Removed data directory: ${result.dataDir}`);
  } else {
    console.log(`  [-] Data directory not found: ${result.dataDir}`);
  }
  console.log(
    `  [~] Removed ${result.generatedFilesRemoved} init-generated file${result.generatedFilesRemoved === 1 ? "" : "s"}`,
  );
  console.log(
    `  [~] Removed ${result.checkpointRefsRemoved} checkpoint ref${result.checkpointRefsRemoved === 1 ? "" : "s"}`,
  );
  for (const err of result.errors ?? []) {
    console.error(`  [x] ${err}`);
  }
  console.log();

  if (!result.ok) process.exitCode = 1;
}

export async function uninstallProject(
  projectRoot: string,
  dataDir: string,
): Promise<ProjectUninstallResult> {
  const errors: string[] = [];
  const hooksResult = await uninstallInstalledPlatformHooks(projectRoot);
  errors.push(...hooksResult.errors);

  const generatedCleanup = removeInitGeneratedFiles(projectRoot);
  errors.push(...generatedCleanup.errors);

  let dataRemoved = false;
  if (existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      dataRemoved = true;
    } catch (err) {
      errors.push(`Failed to remove data directory: ${(err as Error).message}`);
    }
  }

  let checkpointRefsRemoved = 0;
  try {
    const refs = await listCheckpointRefs(projectRoot);
    for (const ref of refs) {
      if (await deleteCheckpointRef(projectRoot, ref.stepId)) {
        checkpointRefsRemoved++;
      } else {
        errors.push(`Failed to remove checkpoint ref: ${ref.stepId}`);
      }
    }
  } catch (err) {
    errors.push(`Failed to list checkpoint refs: ${(err as Error).message}`);
  }

  return {
    ok: errors.length === 0,
    action: "project-uninstall",
    projectRoot,
    dataDir,
    uninstalled: hooksResult.uninstalled,
    dataRemoved,
    generatedFilesRemoved: generatedCleanup.removed,
    checkpointRefsRemoved,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function removeInitGeneratedFiles(projectRoot: string): {
  removed: number;
  errors: string[];
} {
  const errors: string[] = [];
  let removed = 0;

  for (const relativePath of initGeneratedFiles) {
    const filePath = join(projectRoot, relativePath);
    if (!existsSync(filePath)) continue;
    try {
      rmSync(filePath, { force: true });
      removed++;
    } catch (err) {
      errors.push(`Failed to remove ${relativePath}: ${(err as Error).message}`);
    }
  }

  return { removed, errors };
}
