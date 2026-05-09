import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installCodexHooks } from "./hooks-bootstrap.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-hooks-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("installCodexHooks", () => {
  it("enables Codex hooks in project config while installed", () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    try {
      const installed = installCodexHooks({
        cwd: dir,
        codexHome,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      const config = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
      const userConfig = readFileSync(join(codexHome, "config.toml"), "utf8");

      expect(config).toContain("[features]");
      expect(config).toContain("hooks = true");
      expect(config).not.toContain("codex_hooks");
      expect(readFileSync(installed.settingsPath, "utf8")).toContain("UserPromptSubmit");
      expect(userConfig).toContain("# >>> adit-cloud-codex from=adit-cloud-codex-test");
      expect(userConfig).toContain("[hooks.state.");
      expect(userConfig).toContain(".codex/hooks.json:post_tool_use:0:0");
      expect(userConfig).toContain("trusted_hash = \"sha256:");

      installed.cleanup();
      expect(() => readFileSync(join(dir, ".codex", "config.toml"), "utf8")).toThrow();
      expect(() => readFileSync(join(codexHome, "config.toml"), "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores an existing project Codex config on cleanup", () => {
    const dir = tempDir();
    const codexHome = join(dir, "codex-home");
    try {
      const codexDir = join(dir, ".codex");
      const configPath = join(codexDir, "config.toml");
      const originalConfig = "model = \"gpt-5.5\"\n\n[features]\ncodex_hooks = true\nhooks = false\n";
      const userConfigPath = join(codexHome, "config.toml");
      const originalUserConfig = [
        "model = \"gpt-5.5\"",
        "",
        "# >>> adit-cloud-codex from=other-session",
        "[hooks.state.\"/tmp/other/hooks.json:stop:0:0\"]",
        "enabled = true",
        "trusted_hash = \"sha256:other\"",
        "# <<< adit-cloud-codex from=other-session",
        "",
      ].join("\n");
      mkdirSync(codexDir, { recursive: true });
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(configPath, originalConfig);
      writeFileSync(userConfigPath, originalUserConfig);

      const installed = installCodexHooks({
        cwd: dir,
        codexHome,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-codex-test",
      });

      expect(readFileSync(configPath, "utf8")).toContain("hooks = true");
      expect(readFileSync(configPath, "utf8")).not.toContain("codex_hooks");
      expect(readFileSync(userConfigPath, "utf8")).toContain("# >>> adit-cloud-codex");

      installed.cleanup();
      expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
      expect(readFileSync(userConfigPath, "utf8")).toBe(originalUserConfig);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
