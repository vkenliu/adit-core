import { describe, expect, it, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  spawnSync: (...args: unknown[]) => mocks.spawnSync(...args),
}));

import {
  pickExecutableCandidate,
  resolveExecutable,
  shouldUseWindowsShell,
  spawnCliProcess,
} from "./cli-process.js";

const originalPlatform = process.platform;

afterEach(() => {
  vi.clearAllMocks();
  setPlatform(originalPlatform);
});

describe("cli process helpers", () => {
  it("prefers Windows cmd shims over extensionless npm shims", () => {
    setPlatform("win32");

    expect(pickExecutableCandidate("claude", [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.ps1",
    ])).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("prefers native Windows executables when available", () => {
    setPlatform("win32");

    expect(pickExecutableCandidate("codex", [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
      "C:\\Program Files\\Codex\\codex.exe",
    ])).toBe("C:\\Program Files\\Codex\\codex.exe");
  });

  it("resolves a command using where output on Windows", () => {
    setPlatform("win32");
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: [
        "C:\\Users\\me\\AppData\\Roaming\\npm\\codex",
        "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
      ].join("\r\n"),
    });

    expect(resolveExecutable("codex")).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd");
    expect(mocks.spawnSync).toHaveBeenCalledWith("where", ["codex"], expect.objectContaining({
      encoding: "utf8",
    }));
  });

  it("enables shell spawning for Windows cmd and bat shims", () => {
    setPlatform("win32");
    mocks.spawn.mockReturnValue({});

    expect(shouldUseWindowsShell("C:\\Tools\\claude.cmd")).toBe(true);
    expect(shouldUseWindowsShell("C:\\Tools\\codex.exe")).toBe(false);

    spawnCliProcess("C:\\Tools\\claude.cmd", ["--version"], {
      cwd: "C:\\project",
      stdio: "inherit",
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "C:\\Tools\\claude.cmd",
      ["--version"],
      expect.objectContaining({
        cwd: "C:\\project",
        shell: true,
        windowsHide: true,
      }),
    );
  });
});

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}
