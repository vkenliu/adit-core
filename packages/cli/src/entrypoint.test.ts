/**
 * CLI entrypoint detection tests.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isCliEntrypoint } from "./entrypoint.js";

function tempDir(): string {
  const dir = path.join(
    tmpdir(),
    `adit-cli-entrypoint-${randomBytes(8).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("isCliEntrypoint", () => {
  it("recognizes the real CLI file path", () => {
    const dir = tempDir();
    try {
      const entrypointPath = path.join(dir, "dist", "index.js");
      mkdirSync(path.dirname(entrypointPath), { recursive: true });
      writeFileSync(entrypointPath, "#!/usr/bin/env node\n");

      expect(isCliEntrypoint(pathToFileURL(entrypointPath).href, entrypointPath)).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes package manager bin symlinks", () => {
    const dir = tempDir();
    try {
      const entrypointPath = path.join(
        dir,
        "node_modules",
        "@varveai",
        "adit-cli",
        "dist",
        "index.js",
      );
      const binDir = path.join(dir, "node_modules", ".bin");
      const binPath = path.join(binDir, "adit");

      mkdirSync(path.dirname(entrypointPath), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(entrypointPath, "#!/usr/bin/env node\n");
      symlinkSync("../@varveai/adit-cli/dist/index.js", binPath);

      expect(isCliEntrypoint(pathToFileURL(entrypointPath).href, binPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when argv path is missing or unresolved", () => {
    const dir = tempDir();
    try {
      const entrypointPath = path.join(dir, "dist", "index.js");
      mkdirSync(path.dirname(entrypointPath), { recursive: true });
      writeFileSync(entrypointPath, "#!/usr/bin/env node\n");

      expect(isCliEntrypoint(pathToFileURL(entrypointPath).href, undefined)).toBe(false);
      expect(
        isCliEntrypoint(pathToFileURL(entrypointPath).href, path.join(dir, "missing")),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
