import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveExecutable: vi.fn(),
  spawnCliSync: vi.fn(),
}));

vi.mock("./cli-process.js", () => ({
  resolveExecutable: (...args: unknown[]) => mocks.resolveExecutable(...args),
  spawnCliSync: (...args: unknown[]) => mocks.spawnCliSync(...args),
}));

import {
  MAC_CODEX_APP_CLI,
  codexBinaryMismatchDebugLines,
  selectCodexExecutable,
} from "./codex-binary-resolver.js";

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  setPlatform(originalPlatform);
  process.env = { ...originalEnv };
});

describe("selectCodexExecutable", () => {
  it("uses an explicit --bin before any automatic candidate", () => {
    mockExecutables({
      "codex-dev": "/tools/codex-dev",
      codex: "/opt/homebrew/bin/codex",
    });
    mockAppServerSupport({ "/tools/codex-dev": true });

    expect(selectCodexExecutable(" codex-dev ")).toMatchObject({
      bin: "codex-dev",
      executable: "/tools/codex-dev",
      source: "--bin",
      supportsAppServer: true,
    });
    expect(mocks.resolveExecutable).toHaveBeenCalledWith("codex-dev");
    expect(mocks.resolveExecutable).not.toHaveBeenCalledWith("codex");
  });

  it("keeps ADIT_CODEX_BIN ahead of CODEX_CLI_PATH and PATH", () => {
    process.env.ADIT_CODEX_BIN = "codex-adit";
    process.env.CODEX_CLI_PATH = "codex-env";
    mockExecutables({
      "codex-adit": "/tools/codex-adit",
      "codex-env": "/tools/codex-env",
      codex: "/opt/homebrew/bin/codex",
    });
    mockAppServerSupport({ "/tools/codex-adit": true });

    expect(selectCodexExecutable(undefined)).toMatchObject({
      bin: "codex-adit",
      executable: "/tools/codex-adit",
      source: "ADIT_CODEX_BIN",
    });
  });

  it("uses PATH codex before the macOS Codex.app fallback", () => {
    setPlatform("darwin");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    mockExecutables({
      codex: "/opt/homebrew/bin/codex",
      [MAC_CODEX_APP_CLI]: MAC_CODEX_APP_CLI,
    });
    mockAppServerSupport({
      "/opt/homebrew/bin/codex": true,
      [MAC_CODEX_APP_CLI]: true,
    });

    expect(selectCodexExecutable(undefined)).toMatchObject({
      bin: "codex",
      executable: "/opt/homebrew/bin/codex",
      source: "PATH",
    });
  });

  it("falls back to Codex.app on macOS when PATH codex is unavailable", () => {
    setPlatform("darwin");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    mockExecutables({
      [MAC_CODEX_APP_CLI]: MAC_CODEX_APP_CLI,
    });
    mockAppServerSupport({ [MAC_CODEX_APP_CLI]: true });

    expect(selectCodexExecutable(undefined)).toMatchObject({
      bin: MAC_CODEX_APP_CLI,
      executable: MAC_CODEX_APP_CLI,
      source: "Codex.app",
    });
  });

  it("uses a later app-server-capable candidate without emitting normal warnings", () => {
    setPlatform("darwin");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    mockExecutables({
      codex: "/opt/homebrew/bin/codex",
      [MAC_CODEX_APP_CLI]: MAC_CODEX_APP_CLI,
    });
    mockAppServerSupport({
      "/opt/homebrew/bin/codex": false,
      [MAC_CODEX_APP_CLI]: true,
    });

    const selection = selectCodexExecutable(undefined);

    expect(selection).toMatchObject({
      executable: MAC_CODEX_APP_CLI,
      source: "Codex.app",
      supportsAppServer: true,
    });
    expect(selection.debugLines).toEqual([
      "PATH Codex CLI does not expose app-server: /opt/homebrew/bin/codex",
    ]);
  });
});

describe("codexBinaryMismatchDebugLines", () => {
  it("records version mismatches as debug-only diagnostics", () => {
    mockExecutables({
      codex: "/opt/homebrew/bin/codex",
      [MAC_CODEX_APP_CLI]: MAC_CODEX_APP_CLI,
    });
    mockVersions({
      "/opt/homebrew/bin/codex": "codex-cli 0.134.0",
      [MAC_CODEX_APP_CLI]: "codex-cli 0.133.0-alpha.1",
    });

    expect(codexBinaryMismatchDebugLines("/opt/homebrew/bin/codex")).toEqual([
      "Codex binary resolved: /opt/homebrew/bin/codex (codex-cli 0.134.0)",
      `Ignoring Codex.app: ${MAC_CODEX_APP_CLI} (codex-cli 0.133.0-alpha.1) differs from selected Codex CLI`,
    ]);
  });
});

function mockExecutables(executables: Record<string, string>): void {
  mocks.resolveExecutable.mockImplementation((command: string) => executables[command] ?? null);
}

function mockAppServerSupport(support: Record<string, boolean>): void {
  mocks.spawnCliSync.mockImplementation((command: string, args: string[]) => ({
    status: args[0] === "app-server" && support[command] ? 0 : 1,
  }));
}

function mockVersions(versions: Record<string, string>): void {
  mocks.spawnCliSync.mockImplementation((command: string, args: string[]) => ({
    status: args[0] === "--version" && versions[command] ? 0 : 1,
    stdout: versions[command] ?? "",
    stderr: "",
  }));
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}
