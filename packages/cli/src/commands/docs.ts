/**
 * `adit docs` — Document scaffolding and validation commands.
 *
 * scaffold [type]  — Generate a project document template.
 * validate [path]  — Validate document(s) against structural spec.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import pc from "picocolors";
import {
  DOC_TYPES,
  DOC_TYPE_IDS,
  validateDocument,
  renderProjectOverviewTemplate,
  renderArchitectureTemplate,
  renderApiReferenceTemplate,
  renderDataModelTemplate,
  renderBusinessContextTemplate,
  renderConventionsTemplate,
} from "@adit/plans";
import { sectionHeader, horizontalRule, statusDot } from "../utils/format.js";

// ─── Template renderers by type ─────────────────────────────────

const RENDERERS: Record<string, (title: string) => string> = {
  "project-overview": renderProjectOverviewTemplate,
  architecture: renderArchitectureTemplate,
  "api-reference": renderApiReferenceTemplate,
  "data-model": renderDataModelTemplate,
  "business-context": renderBusinessContextTemplate,
  conventions: renderConventionsTemplate,
};

/** Default output directory for generated documents */
const DOCS_DIR = ".adit/docs";

// ─── scaffold ───────────────────────────────────────────────────

export async function docsScaffoldCommand(
  type?: string,
  opts?: { output?: string },
): Promise<void> {
  // If no type specified, show available types and prompt
  if (!type) {
    console.log();
    console.log(pc.bold("Available document types:"));
    console.log();
    for (const id of DOC_TYPE_IDS) {
      const spec = DOC_TYPES[id];
      console.log(`  ${pc.cyan(id.padEnd(20))} ${pc.dim(spec.description)}`);
    }
    console.log();
    console.log(pc.dim("Usage: adit docs scaffold <type>"));
    console.log();
    return;
  }

  const spec = DOC_TYPES[type];
  if (!spec) {
    console.error(pc.red(`Unknown document type: ${type}`));
    console.error(pc.dim(`Available: ${DOC_TYPE_IDS.join(", ")}`));
    process.exit(1);
  }

  const renderer = RENDERERS[type];
  if (!renderer) {
    console.error(pc.red(`Template not implemented for type: ${type}`));
    process.exit(1);
  }

  // Determine output path
  const outDir = opts?.output
    ? join(process.cwd(), opts.output)
    : join(process.cwd(), DOCS_DIR);
  const fileName = `${type}.md`;
  const filePath = join(outDir, fileName);

  // Check if file already exists
  if (existsSync(filePath)) {
    console.error(pc.yellow(`File already exists: ${filePath}`));
    console.error(pc.dim("Remove it or choose a different output path."));
    process.exit(1);
  }

  // Generate template content using project directory name as title
  const projectName = basename(process.cwd());
  const content = renderer(projectName);

  // Ensure output directory exists
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Write file
  writeFileSync(filePath, content, "utf-8");

  console.log();
  console.log(`${statusDot(true)} Created ${pc.bold(filePath)}`);
  console.log();
  console.log(pc.dim("Required sections:"));
  for (const section of spec.requiredSections) {
    console.log(pc.dim(`  ## ${section}`));
  }
  console.log();
  console.log(pc.dim("Edit the file, then run: adit docs validate"));
  console.log();
}

// ─── validate ───────────────────────────────────────────────────

interface ValidateOptions {
  json?: boolean;
  threshold?: number;
}

export async function docsValidateCommand(
  path?: string,
  opts?: ValidateOptions,
): Promise<void> {
  const threshold = opts?.threshold ?? 0.6;
  const projectRoot = process.cwd();

  // Collect documents to validate
  const docs: Array<{ filePath: string; relativePath: string; content: string }> = [];

  if (path) {
    // Validate single file
    const absPath = join(projectRoot, path);
    if (!existsSync(absPath)) {
      console.error(pc.red(`File not found: ${path}`));
      process.exit(1);
    }
    if (!absPath.toLowerCase().endsWith(".md")) {
      console.error(pc.red(`Not a markdown file: ${path}`));
      process.exit(1);
    }
    const content = readFileSync(absPath, "utf-8");
    docs.push({ filePath: absPath, relativePath: path, content });
  } else {
    // Scan docs/ directory for all .md files
    const docsDir = join(projectRoot, DOCS_DIR);
    if (!existsSync(docsDir)) {
      console.log();
      console.log(pc.yellow("No .adit/docs/ directory found."));
      console.log(pc.dim("Run 'adit docs scaffold' to generate document templates."));
      console.log();
      return;
    }

    // Simple directory scan for .md files
    const { readdirSync } = await import("node:fs");
    const { statSync } = await import("node:fs");
    for (const entry of readdirSync(docsDir)) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      const fullPath = join(docsDir, entry);
      if (!statSync(fullPath).isFile()) continue;
      const content = readFileSync(fullPath, "utf-8");
      docs.push({ filePath: fullPath, relativePath: `${DOCS_DIR}/${entry}`, content });
    }

    if (docs.length === 0) {
      console.log();
      console.log(pc.yellow("No markdown files found in .adit/docs/."));
      console.log(pc.dim("Run 'adit docs scaffold <type>' to generate templates."));
      console.log();
      return;
    }
  }

  // Validate each document
  const results = docs.map((doc) => {
    const result = validateDocument(doc.content);
    return { ...doc, ...result };
  });

  // JSON output
  if (opts?.json) {
    console.log(JSON.stringify(results.map((r) => ({
      file: r.relativePath,
      score: Math.round(r.score * 100) / 100,
      detectedType: r.detectedType,
      missingRequired: r.missingRequired,
      missingRecommended: r.missingRecommended,
      stubSections: r.stubSections,
      suggestions: r.suggestions,
    })), null, 2));
    return;
  }

  // Human-readable output
  console.log();
  console.log(pc.bold("Document Validation Report"));
  console.log(horizontalRule(50));

  let totalScore = 0;
  let allPass = true;

  for (const r of results) {
    const pass = r.score >= threshold;
    if (!pass) allPass = false;
    totalScore += r.score;

    const scoreLabel = pass
      ? pc.green(`${Math.round(r.score * 100)}%`)
      : pc.red(`${Math.round(r.score * 100)}%`);

    console.log();
    console.log(sectionHeader(r.relativePath, 50));
    console.log();
    console.log(`  ${statusDot(pass)} Score: ${scoreLabel}  ${pc.dim(`(type: ${r.detectedType})`)}`);

    if (r.missingRequired.length > 0) {
      console.log(`  ${pc.red("Missing required sections:")}`);
      for (const s of r.missingRequired) {
        console.log(`    ${pc.red("-")} ## ${s}`);
      }
    }

    if (r.stubSections.length > 0) {
      console.log(`  ${pc.yellow("Stub sections (need content):")}`);
      for (const s of r.stubSections) {
        console.log(`    ${pc.yellow("-")} ## ${s}`);
      }
    }

    if (r.missingRecommended.length > 0) {
      console.log(`  ${pc.dim("Recommended sections not present:")}`);
      for (const s of r.missingRecommended) {
        console.log(`    ${pc.dim("+")} ## ${s}`);
      }
    }
  }

  // Summary
  console.log();
  console.log(horizontalRule(50));
  const avgScore = results.length > 0 ? totalScore / results.length : 0;
  const avgLabel = allPass
    ? pc.green(`${Math.round(avgScore * 100)}%`)
    : pc.red(`${Math.round(avgScore * 100)}%`);

  console.log();
  console.log(`  ${statusDot(allPass)} Overall: ${avgLabel} across ${results.length} document(s)  ${pc.dim(`(threshold: ${Math.round(threshold * 100)}%)`)}`);

  if (!allPass) {
    console.log();
    console.log(pc.red("  Documents below threshold. Run " + pc.bold("/generate-docs") + pc.red(" in your AI coding tool to auto-fill.")));
    console.log(pc.red("  Then re-run 'adit docs validate' to check scores."));
  }

  console.log();

  // Exit code
  if (!allPass) {
    process.exit(1);
  }
}
