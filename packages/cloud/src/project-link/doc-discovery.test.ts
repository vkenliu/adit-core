/**
 * Tests for project document discovery.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { discoverDocuments, loadDocSettings } from "./doc-discovery.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-doc-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("discoverDocuments", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = tempDir();
  });

  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("discovers a README.md at project root", () => {
    writeFileSync(join(projectRoot, "README.md"), "# My Project\n");

    const docs = discoverDocuments(projectRoot, {});

    expect(docs.length).toBe(1);
    expect(docs[0].fileName).toBe("README.md");
    expect(docs[0].sourcePath).toBe("README.md");
    expect(docs[0].status).toBe("new");
    expect(docs[0].content).toBe("# My Project\n");
    expect(docs[0].contentHash).toBeTruthy();
  });

  it("discovers documents in docs/ subdirectory", () => {
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "architecture.md"), "# Architecture\n");

    const docs = discoverDocuments(projectRoot, {});

    expect(docs.length).toBe(1);
    expect(docs[0].sourcePath).toBe("docs/architecture.md");
  });

  it("classifies unchanged documents based on cached hash", () => {
    const content = "# My Project\n";
    writeFileSync(join(projectRoot, "README.md"), content);
    const hash = hashContent(content);

    const docs = discoverDocuments(projectRoot, { "README.md": hash });

    expect(docs.length).toBe(1);
    expect(docs[0].status).toBe("unchanged");
  });

  it("classifies changed documents based on cached hash", () => {
    writeFileSync(join(projectRoot, "README.md"), "# Updated Project\n");

    const docs = discoverDocuments(projectRoot, { "README.md": "old-hash" });

    expect(docs.length).toBe(1);
    expect(docs[0].status).toBe("changed");
  });

  it("sorts documents: new, changed, unchanged", () => {
    writeFileSync(join(projectRoot, "README.md"), "readme\n");
    writeFileSync(join(projectRoot, "PLAN.md"), "plan\n");
    writeFileSync(join(projectRoot, "AGENTS.md"), "agents\n");

    const docs = discoverDocuments(projectRoot, {
      "README.md": "old-hash", // changed
      "PLAN.md": hashContent("plan\n"), // unchanged
      // AGENTS.md not in cache → new
    });

    expect(docs[0].status).toBe("new"); // AGENTS.md
    expect(docs[1].status).toBe("changed"); // README.md
    expect(docs[2].status).toBe("unchanged"); // PLAN.md
  });

  it("skips files exceeding 500KB", () => {
    const largeContent = "x".repeat(600 * 1024);
    writeFileSync(join(projectRoot, "README.md"), largeContent);

    const docs = discoverDocuments(projectRoot, {});
    expect(docs.length).toBe(0);
  });

  it("uses custom patterns when provided", () => {
    writeFileSync(join(projectRoot, "README.md"), "readme\n");
    writeFileSync(join(projectRoot, "CUSTOM.md"), "custom\n");

    const docs = discoverDocuments(projectRoot, {}, { patterns: ["CUSTOM.md"] });

    expect(docs.length).toBe(1);
    expect(docs[0].fileName).toBe("CUSTOM.md");
  });

  it("returns empty array when no files match", () => {
    const docs = discoverDocuments(projectRoot, {});
    expect(docs).toEqual([]);
  });
});

describe("loadDocSettings", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = tempDir();
  });

  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("returns undefined when no settings.json exists", () => {
    expect(loadDocSettings(projectRoot)).toBeUndefined();
  });

  it("returns undefined when settings.json has no projectLink key", () => {
    writeFileSync(join(projectRoot, "settings.json"), JSON.stringify({ other: true }));
    expect(loadDocSettings(projectRoot)).toBeUndefined();
  });

  it("returns custom doc patterns from settings.json", () => {
    writeFileSync(
      join(projectRoot, "settings.json"),
      JSON.stringify({
        projectLink: {
          docPatterns: ["*.md", "docs/**/*.md"],
          excludePatterns: ["vendor/**"],
        },
      }),
    );

    const opts = loadDocSettings(projectRoot);
    expect(opts).toBeDefined();
    expect(opts!.patterns).toEqual(["*.md", "docs/**/*.md"]);
    expect(opts!.excludePatterns).toEqual(["vendor/**"]);
  });
});
