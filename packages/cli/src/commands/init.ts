/**
 * `adit init` — Initialize ADIT in the current project.
 *
 * Creates the .adit/ data directory, initializes the database,
 * and installs hooks for detected (or specified) AI platforms via adapters.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { loadConfig, openDatabase, closeDatabase, findGitRoot } from "@adit/core";
import type { Platform } from "@adit/core";
import { isGitRepo } from "@adit/engine";
import {
  getAdapter,
  listAdapters,
  detectPlatforms,
  resolveAditHookBinary,
} from "@adit/hooks/adapters";
import {
  renderProjectOverviewTemplate,
  renderArchitectureTemplate,
  renderApiReferenceTemplate,
  renderDataModelTemplate,
} from "@adit/plans";

export async function initCommand(opts: {
  cwd?: string;
  platform?: string;
  force?: boolean;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();

  console.log();
  console.log("  ADIT — AI Development Intent Tracker");
  console.log("  =====================================");
  console.log();

  // Verify we're in a git repo
  if (!(await isGitRepo(cwd))) {
    console.error("  [x] Not a git repository. Run 'git init' first.");
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const gitRoot = findGitRoot(cwd) ?? cwd;

  // --- Step 1: Clean up if --force ---
  if (opts.force) {
    console.log("  Removing existing hooks (--force)...");
    for (const adapter of listAdapters()) {
      if (adapter.hookMappings.length === 0) continue;
      try {
        const result = await adapter.validateInstallation(gitRoot);
        if (result.valid) {
          await adapter.uninstallHooks(gitRoot);
          console.log(`    [~] Removed ${adapter.displayName} hooks`);
        }
      } catch {
        // best-effort cleanup
      }
    }
    console.log();
  }

  // --- Step 2: Data directory & database ---
  console.log("  Setup");
  console.log("  -----");

  mkdirSync(config.dataDir, { recursive: true });
  console.log(`  [+] Data directory: ${config.dataDir}`);

  const db = openDatabase(config.dbPath);
  closeDatabase(db);
  console.log(`  [+] Database: ${config.dbPath}`);

  // Add .adit/ to .gitignore if not already there
  const gitignorePath = join(gitRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".adit/")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.adit/\n");
      console.log("  [+] Added .adit/ to .gitignore");
    } else {
      console.log("  [+] .gitignore already includes .adit/");
    }
  } else {
    writeFileSync(gitignorePath, ".adit/\n");
    console.log("  [+] Created .gitignore with .adit/");
  }

  // --- Step 3: Platform detection & hook installation ---
  console.log();
  console.log("  Platforms");
  console.log("  ---------");

  const aditBinaryPath = resolveAditHookBinary();
  const installed: string[] = [];
  const skipped: string[] = [];

  if (opts.platform) {
    // Explicit platform specified
    const platform = opts.platform as Platform;
    try {
      const adapter = getAdapter(platform);
      await adapter.installHooks(gitRoot, aditBinaryPath);
      installed.push(adapter.displayName);
      console.log(`  [+] ${adapter.displayName} — ${adapter.hookMappings.length} hook events installed`);
    } catch (err) {
      skipped.push(platform);
      console.log(`  [x] ${platform} — install failed: ${(err as Error).message}`);
    }
  } else {
    // Auto-detect: install hooks for all detected platforms
    const platforms = detectPlatforms(gitRoot);
    if (platforms.length === 0) {
      console.log("  [ ] No AI platforms detected in this project.");
      console.log("      Supported: Claude Code (.claude/), OpenCode (.opencode/)");
      console.log("      Run 'adit plugin install <platform>' to add one manually.");
    } else {
      for (const platform of platforms) {
        try {
          const adapter = getAdapter(platform);
          // Skip stub adapters (no hook mappings)
          if (adapter.hookMappings.length === 0) {
            skipped.push(adapter.displayName);
            console.log(`  [-] ${adapter.displayName} — detected but not yet supported`);
            continue;
          }
          await adapter.installHooks(gitRoot, aditBinaryPath);
          installed.push(adapter.displayName);
          console.log(`  [+] ${adapter.displayName} — ${adapter.hookMappings.length} hook events installed`);
        } catch (err) {
          skipped.push(platform);
          console.log(`  [x] ${platform} — install failed: ${(err as Error).message}`);
        }
      }
    }
  }

  // --- Step 4: Generate document templates ---
  console.log();
  console.log("  Project Documents");
  console.log("  -----------------");

  const docsDir = join(gitRoot, "docs");
  const projectName = basename(gitRoot);
  const defaultDocTypes: Array<{ file: string; renderer: (title: string) => string }> = [
    { file: "project-overview.md", renderer: renderProjectOverviewTemplate },
    { file: "architecture.md", renderer: renderArchitectureTemplate },
    { file: "api-reference.md", renderer: renderApiReferenceTemplate },
    { file: "data-model.md", renderer: renderDataModelTemplate },
  ];

  let docsCreated = 0;
  let docsExisting = 0;

  for (const { file, renderer } of defaultDocTypes) {
    const filePath = join(docsDir, file);
    if (existsSync(filePath)) {
      docsExisting++;
      console.log(`  [=] ${file} already exists`);
    } else {
      if (docsCreated === 0) mkdirSync(docsDir, { recursive: true });
      writeFileSync(filePath, renderer(projectName), "utf-8");
      docsCreated++;
      console.log(`  [+] Created ${file}`);
    }
  }

  if (docsCreated > 0) {
    console.log("      Fill in content manually or use /generate-docs in Claude Code");
  } else if (docsExisting === defaultDocTypes.length) {
    console.log("  All default templates already present.");
  }

  // --- Step 5: Install doc generation skill for Claude Code ---
  const claudeDir = join(gitRoot, ".claude");
  if (existsSync(claudeDir)) {
    const skillsDir = join(claudeDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const skillPath = join(skillsDir, "generate-docs.md");
    if (!existsSync(skillPath) || opts.force) {
      writeFileSync(skillPath, GENERATE_DOCS_SKILL, "utf-8");
      console.log("  [+] Installed generate-docs skill for Claude Code");
      console.log("      Use /generate-docs in Claude Code to auto-fill project documents");
    }
  }

  // --- Summary ---
  console.log();
  if (installed.length > 0) {
    console.log("  Done! ADIT is ready.");
    console.log();
    console.log(`  Installed for: ${installed.join(", ")}`);
    console.log("  Run 'adit list' to view the timeline after your first prompt.");
  } else {
    console.log("  Done! ADIT data directory is ready.");
    console.log();
    console.log("  No platform hooks were installed.");
    console.log("  Run 'adit plugin install <platform>' when you're ready to add one.");
  }
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.join(", ")}`);
  }
  console.log();
}

/** Skill content for generate-docs — installed to .claude/skills/ */
const GENERATE_DOCS_SKILL = `---
name: generate-docs
description: Analyze codebase and generate project documentation following adit spec
---

Analyze the current codebase and generate project documentation following the adit document specification.

## Context

This project uses adit for AI-assisted planning. The planning pipeline needs structured project documents as context. Your job is to analyze the codebase and fill in document templates.

## Steps

1. Check what document templates exist in the \`docs/\` directory. If none exist, list what's missing and suggest the user run \`adit docs scaffold <type>\` first.
2. For each template file in \`docs/\`:
   a. Read the template to understand which sections need content.
   b. Analyze the relevant parts of the codebase:
      - \`package.json\` — dependencies, scripts, project metadata
      - Directory structure (\`src/\`, \`app/\`, \`lib/\`, etc.) — modules and organization
      - \`prisma/schema.prisma\` or ORM configs — data models
      - API route files — endpoints
      - Config files — tech stack, conventions
      - Test files — testing patterns
   c. Fill in each section with specific, accurate content derived from the codebase.
   d. Remove the HTML comment placeholders (<!-- ... -->) and replace with real content.
3. Run \`adit docs validate\` to check the quality scores.
4. If any documents score below 60%, improve the content and re-validate.

## Rules

- Be specific: reference actual file paths, function names, dependencies, and patterns.
- Do NOT invent content — only document what actually exists in the codebase.
- Keep each section concise but informative (2-5 sentences minimum per section).
- Preserve the H2 heading structure exactly — do not rename or remove required sections.
- All analysis happens locally. No code leaves this machine.
`;