import { describe, it, expect } from "vitest";
import { diffEnvironments } from "./differ.js";
import type { EnvSnapshot } from "@adit/core";

function makeSnapshot(overrides: Partial<EnvSnapshot> = {}): EnvSnapshot {
  return {
    id: "snap-001",
    sessionId: "session-001",
    gitBranch: "main",
    gitHeadSha: "abc1234",
    modifiedFiles: "[]",
    depLockHash: "deadbeef12345678",
    depLockPath: "pnpm-lock.yaml",
    envVarsJson: "{}",
    nodeVersion: "v20.0.0",
    pythonVersion: "Python 3.11.0",
    osInfo: "linux 5.15.0",
    containerInfo: null,
    runtimeVersionsJson: null,
    shellInfo: null,
    systemResourcesJson: null,
    packageManagerJson: null,
    capturedAt: "2026-01-01T00:00:00.000Z",
    vclockJson: "{}",
    deletedAt: null,
    ...overrides,
  };
}

describe("diffEnvironments", () => {
  it("returns no changes for identical snapshots", () => {
    const snap = makeSnapshot();
    const diff = diffEnvironments(snap, snap);
    expect(diff.changes).toHaveLength(0);
    expect(diff.severity).toBe("none");
  });

  it("detects git branch change as warning", () => {
    const prev = makeSnapshot({ gitBranch: "main" });
    const curr = makeSnapshot({ gitBranch: "feature/new-thing" });
    const diff = diffEnvironments(prev, curr);

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].field).toBe("gitBranch");
    expect(diff.changes[0].category).toBe("git");
    expect(diff.changes[0].severity).toBe("warning");
    expect(diff.changes[0].oldValue).toBe("main");
    expect(diff.changes[0].newValue).toBe("feature/new-thing");
    expect(diff.severity).toBe("warning");
  });

  it("detects HEAD SHA change as info", () => {
    const prev = makeSnapshot({ gitHeadSha: "abc1234" });
    const curr = makeSnapshot({ gitHeadSha: "def5678" });
    const diff = diffEnvironments(prev, curr);

    const headChange = diff.changes.find((c) => c.field === "gitHeadSha");
    expect(headChange).toBeDefined();
    expect(headChange!.severity).toBe("info");
  });

  it("detects dependency lockfile hash change as warning", () => {
    const prev = makeSnapshot({ depLockHash: "hash1111" });
    const curr = makeSnapshot({ depLockHash: "hash2222" });
    const diff = diffEnvironments(prev, curr);

    const depChange = diff.changes.find((c) => c.field === "depLockHash");
    expect(depChange).toBeDefined();
    expect(depChange!.category).toBe("dependency");
    expect(depChange!.severity).toBe("warning");
  });

  it("detects node version change as warning", () => {
    const prev = makeSnapshot({ nodeVersion: "v20.0.0" });
    const curr = makeSnapshot({ nodeVersion: "v22.0.0" });
    const diff = diffEnvironments(prev, curr);

    const nodeChange = diff.changes.find((c) => c.field === "nodeVersion");
    expect(nodeChange).toBeDefined();
    expect(nodeChange!.category).toBe("runtime");
    expect(nodeChange!.severity).toBe("warning");
  });

  it("detects OS change as breaking", () => {
    const prev = makeSnapshot({ osInfo: "linux 5.15.0" });
    const curr = makeSnapshot({ osInfo: "darwin 23.0.0" });
    const diff = diffEnvironments(prev, curr);

    const osChange = diff.changes.find((c) => c.field === "osInfo");
    expect(osChange).toBeDefined();
    expect(osChange!.severity).toBe("breaking");
    expect(diff.severity).toBe("breaking");
  });

  it("detects modified files changes", () => {
    const prev = makeSnapshot({ modifiedFiles: JSON.stringify(["a.ts", "b.ts"]) });
    const curr = makeSnapshot({ modifiedFiles: JSON.stringify(["a.ts", "c.ts", "d.ts"]) });
    const diff = diffEnvironments(prev, curr);

    const fileChange = diff.changes.find((c) => c.field === "modifiedFiles");
    expect(fileChange).toBeDefined();
    expect(fileChange!.category).toBe("git");
  });

  it("detects new runtime versions via JSON fields", () => {
    const prev = makeSnapshot({ runtimeVersionsJson: null });
    const curr = makeSnapshot({ runtimeVersionsJson: JSON.stringify({ rust: "1.75.0", go: "1.21.0" }) });
    const diff = diffEnvironments(prev, curr);

    const runtimeChange = diff.changes.find((c) => c.field === "runtimeVersions");
    expect(runtimeChange).toBeDefined();
    expect(runtimeChange!.category).toBe("runtime");
  });

  it("detects container change via JSON field comparison", () => {
    const prev = makeSnapshot({ containerInfo: null });
    const curr = makeSnapshot({ containerInfo: JSON.stringify({ inDocker: true }) });
    const diff = diffEnvironments(prev, curr);

    const containerChange = diff.changes.find((c) => c.field === "containerInfo");
    expect(containerChange).toBeDefined();
    expect(containerChange!.category).toBe("system");
  });

  it("detects multiple changes and computes highest severity", () => {
    const prev = makeSnapshot({
      gitBranch: "main",
      nodeVersion: "v20.0.0",
      osInfo: "linux 5.15.0",
    });
    const curr = makeSnapshot({
      gitBranch: "develop",
      nodeVersion: "v22.0.0",
      osInfo: "linux 6.0.0",
    });
    const diff = diffEnvironments(prev, curr);

    expect(diff.changes.length).toBeGreaterThanOrEqual(3);
    // osInfo change is "breaking"
    expect(diff.severity).toBe("breaking");
  });

  it("handles null values in both old and new gracefully", () => {
    const prev = makeSnapshot({ pythonVersion: null });
    const curr = makeSnapshot({ pythonVersion: null });
    const diff = diffEnvironments(prev, curr);

    const pyChange = diff.changes.find((c) => c.field === "pythonVersion");
    expect(pyChange).toBeUndefined(); // No change when both are null
  });

  it("detects when a runtime appears (null → value)", () => {
    const prev = makeSnapshot({ pythonVersion: null });
    const curr = makeSnapshot({ pythonVersion: "Python 3.12.0" });
    const diff = diffEnvironments(prev, curr);

    const pyChange = diff.changes.find((c) => c.field === "pythonVersion");
    expect(pyChange).toBeDefined();
    expect(pyChange!.oldValue).toBeNull();
    expect(pyChange!.newValue).toBe("Python 3.12.0");
  });
});
