import { describe, expect, it } from "vitest";
import { stripCodexHookTrustBlocks } from "./codex-trust.js";

describe("stripCodexHookTrustBlocks", () => {
  it("removes malformed blocks when the marker appears in the end marker", () => {
    const text = [
      "model = \"gpt-5.5\"",
      "",
      "# >>> adit-cloud-codex from=old",
      "[hooks.state.\"/tmp/project/.codex/hooks.json:stop:1:0\"]",
      "enabled = true",
      "trusted_hash = \"sha256:old\"",
      "# <<< adit-cloud-codex from=current",
      "",
      "[projects.\"/tmp/project\"]",
      "trust_level = \"trusted\"",
      "",
    ].join("\n");

    const stripped = stripCodexHookTrustBlocks(text, {
      blockName: "adit-cloud-codex",
      marker: "from=current",
    });

    expect(stripped).not.toContain("adit-cloud-codex");
    expect(stripped).not.toContain("sha256:old");
    expect(stripped).toContain("model = \"gpt-5.5\"");
    expect(stripped).toContain("[projects.\"/tmp/project\"]");
  });

  it("preserves adjacent user hook state while removing a managed marker block", () => {
    const text = [
      "model = \"gpt-5.5\"",
      "",
      "[hooks.state.\"/tmp/other/hooks.json:stop:0:0\"]",
      "enabled = true",
      "trusted_hash = \"sha256:user\"",
      "",
      "# >>> adit-codex-hooks project=abc",
      "[hooks.state.\"/tmp/project/.codex/hooks.json:stop:1:0\"]",
      "enabled = true",
      "trusted_hash = \"sha256:adit\"",
      "# <<< adit-codex-hooks project=abc",
      "",
    ].join("\n");

    const stripped = stripCodexHookTrustBlocks(text, {
      blockName: "adit-codex-hooks",
      marker: "project=abc",
    });

    expect(stripped).toContain("model = \"gpt-5.5\"");
    expect(stripped).toContain("/tmp/other/hooks.json:stop:0:0");
    expect(stripped).toContain("sha256:user");
    expect(stripped).not.toContain("adit-codex-hooks");
    expect(stripped).not.toContain("sha256:adit");
  });
});
