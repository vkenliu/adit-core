import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cleanupStaleClaudeCloudSettings,
  installClaudeHooks,
  installCodexHooks,
} from "./hooks-bootstrap.js";

function tempDir(): string {
  const dir = join(tmpdir(), `adit-codex-hooks-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeClaudeCloudSettings(path: string, port: number): void {
  const command = `curl -sS --fail --max-time 3 -X POST -H 'content-type: application/json' --data-binary @- 'http://127.0.0.1:${port}/hook?from=adit-cloud-cli-${port}' >/dev/null || true`;
  writeFileSync(
    path,
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command,
                  timeout: 5000,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
}

describe("installClaudeHooks", () => {
  it("removes managed temporary settings files on cleanup", () => {
    const dir = tempDir();
    try {
      const claudeDir = join(dir, ".claude");
      const baseSettingsPath = join(claudeDir, "settings.local.json");
      const managedSettingsPath = join(claudeDir, "adit-cloud-test.settings.local.json");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(baseSettingsPath, JSON.stringify({ model: "claude-sonnet" }, null, 2));

      const installed = installClaudeHooks({
        cwd: dir,
        endpoint: "http://127.0.0.1:1234/hook",
        marker: "from=adit-cloud-cli-1234",
        settingsPath: managedSettingsPath,
      });

      expect(installed.settingsPath).toBe(managedSettingsPath);
      expect(readFileSync(managedSettingsPath, "utf8")).toContain("claude-sonnet");
      expect(readFileSync(managedSettingsPath, "utf8")).toContain("from=adit-cloud-cli-1234");

      installed.cleanup();
      expect(existsSync(managedSettingsPath)).toBe(false);
      expect(existsSync(baseSettingsPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanupStaleClaudeCloudSettings", () => {
  it("removes inactive managed settings files and keeps active ones", async () => {
    const dir = tempDir();
    try {
      const claudeDir = join(dir, ".claude");
      const activePath = join(claudeDir, "adit-cloud-active.settings.local.json");
      const stalePath = join(claudeDir, "adit-cloud-stale.settings.local.json");
      const userSettingsPath = join(claudeDir, "settings.local.json");
      mkdirSync(claudeDir, { recursive: true });
      writeClaudeCloudSettings(activePath, 1234);
      writeClaudeCloudSettings(stalePath, 5678);
      writeFileSync(userSettingsPath, "{}");

      const removed = await cleanupStaleClaudeCloudSettings({
        cwd: dir,
        isPortActive: async (port) => port === 1234,
      });

      expect(removed).toContain(stalePath);
      expect(removed).not.toContain(activePath);
      expect(existsSync(activePath)).toBe(true);
      expect(existsSync(stalePath)).toBe(false);
      expect(existsSync(userSettingsPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes old managed settings files when no cloud hook port can be read", async () => {
    const dir = tempDir();
    try {
      const claudeDir = join(dir, ".claude");
      const oldPath = join(claudeDir, "adit-cloud-old.settings.local.json");
      const freshPath = join(claudeDir, "adit-cloud-fresh.settings.local.json");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(oldPath, "{ invalid json");
      writeFileSync(freshPath, "{ invalid json");
      const oldTime = new Date(Date.now() - 60_000);
      utimesSync(oldPath, oldTime, oldTime);

      const removed = await cleanupStaleClaudeCloudSettings({
        cwd: dir,
        maxAgeMs: 1_000,
      });

      expect(removed).toContain(oldPath);
      expect(removed).not.toContain(freshPath);
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(freshPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
