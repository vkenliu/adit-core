import { describe, expect, it } from "vitest";
import { normalizeCodexReclaimInput } from "./codex-cli-provider.js";

describe("normalizeCodexReclaimInput", () => {
  it("preserves normal reclaim input", () => {
    expect(normalizeCodexReclaimInput("/local\n")).toBe("/local\n");
  });

  it("decodes CSI-u reclaim input left by Codex terminal mode", () => {
    const encoded = "\x1b[I\x1b[O\x1b[47u\x1b[108u\x1b[111u\x1b[99u\x1b[97u\x1b[108u\x1b[13u";

    expect(normalizeCodexReclaimInput(encoded)).toBe("/local\n");
  });

  it("decodes modified CSI-u keys and strips unrelated CSI escapes", () => {
    const encoded = "\x1b[?1004h\x1b[47;1:3u\x1b[108;1:3u\x1b[111;1:3u\x1b[99;1:3u\x1b[97;1:3u\x1b[108;1:3u";

    expect(normalizeCodexReclaimInput(encoded)).toBe("/local");
  });
});
