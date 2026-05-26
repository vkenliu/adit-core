/**
 * Tests for portable hook command construction and parsing.
 */

import { describe, expect, it } from "vitest";
import { buildAditHookCommand, isAditHookCommand, parseHookArgs } from "./command.js";

describe("Hook Command Helpers", () => {
  it("builds commands with explicit platform arguments", () => {
    const command = buildAditHookCommand("npx adit-hook", "codex", "stop");

    expect(command).toBe("npx adit-hook --platform codex stop");
  });

  it("parses platform flag before hook type", () => {
    expect(parseHookArgs(["--platform", "cursor", "prompt-submit"])).toEqual({
      platform: "cursor",
      hookType: "prompt-submit",
    });
  });

  it("parses platform flag after hook type", () => {
    expect(parseHookArgs(["stop", "--platform=gemini"])).toEqual({
      platform: "gemini",
      hookType: "stop",
    });
  });

  it("keeps old positional hook commands working", () => {
    expect(parseHookArgs(["session-start"])).toEqual({
      platform: null,
      hookType: "session-start",
    });
  });

  it("identifies ADIT hook commands with Windows paths", () => {
    expect(isAditHookCommand('node "C:\\tools\\hooks\\dist\\index.js" stop')).toBe(true);
  });

  it("identifies ADIT hook commands with mixed-case Windows paths", () => {
    expect(isAditHookCommand('node "C:\\Users\\me\\AppData\\Roaming\\npm\\ADIT-HOOK.CMD" stop')).toBe(true);
    expect(isAditHookCommand('node "C:\\tools\\Hooks\\Dist\\Index.js" stop')).toBe(true);
  });
});
