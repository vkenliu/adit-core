/**
 * Tests for `adit hook` lifecycle commands.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const adapter = {
    platform: "codex",
    displayName: "Codex",
    hookMappings: [{ platformEvent: "Stop", aditHandler: "stop" }],
    hasHooks: vi.fn(),
    validateInstallation: vi.fn(),
    uninstallHooks: vi.fn(),
  };

  return {
    adapter,
    detectPlatforms: vi.fn(),
    findGitRoot: vi.fn(),
    getAdapter: vi.fn(),
    listAdapters: vi.fn(),
  };
});

vi.mock("@varveai/adit-core", () => ({
  findGitRoot: mocks.findGitRoot,
  loadConfig: vi.fn(),
}));

vi.mock("@varveai/adit-hooks/adapters", () => ({
  detectPlatforms: mocks.detectPlatforms,
  getAdapter: mocks.getAdapter,
  listAdapters: mocks.listAdapters,
  resolveAditHookBinary: vi.fn(() => "adit-hook"),
}));

import { uninstallInstalledPlatformHooks } from "./plugin.js";

describe("hook uninstall command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findGitRoot.mockReturnValue(null);
    mocks.detectPlatforms.mockReturnValue(["codex"]);
    mocks.getAdapter.mockReturnValue(mocks.adapter);
    mocks.listAdapters.mockReturnValue([mocks.adapter]);
    mocks.adapter.hasHooks.mockResolvedValue(true);
    mocks.adapter.validateInstallation.mockResolvedValue({
      valid: false,
      checks: [{ name: "Codex hook trust", ok: false, detail: "needs review" }],
    });
    mocks.adapter.uninstallHooks.mockResolvedValue(undefined);
  });

  it("uninstalls partial hook configurations even when validation fails", async () => {
    const result = await uninstallInstalledPlatformHooks("/repo");

    expect(mocks.adapter.hasHooks).toHaveBeenCalledWith("/repo");
    expect(mocks.adapter.validateInstallation).not.toHaveBeenCalled();
    expect(mocks.adapter.uninstallHooks).toHaveBeenCalledWith("/repo");
    expect(result).toEqual({
      uninstalled: ["Codex"],
      errors: [],
    });
  });
});
