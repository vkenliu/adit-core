import { describe, expect, it } from "vitest";
import {
  codexThreadModeOverrides,
  codexTurnModeOverrides,
  normalizeCodexReclaimInput,
  promptInputForCodexMode,
} from "./codex-cli-provider.js";

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

describe("Codex prompt modes", () => {
  it("wraps plan prompts with read-only planning instructions", () => {
    const prompt = promptInputForCodexMode("add login", "plan");

    expect(prompt).toContain("ADIT Plan mode is active.");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("User request:\nadd login");
  });

  it("leaves build prompts unchanged", () => {
    expect(promptInputForCodexMode("add login", "build")).toBe("add login");
  });

  it("uses read-only sandbox overrides in plan mode", () => {
    expect(codexThreadModeOverrides("plan")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    expect(codexTurnModeOverrides("plan")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
    });
  });

  it("uses full-access sandbox overrides in build mode", () => {
    expect(codexThreadModeOverrides("build")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    expect(codexTurnModeOverrides("build")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
    });
  });
});
