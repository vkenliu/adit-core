/**
 * Tests for the snapshot creator.
 *
 * Verifies the code review fixes:
 * - stageChanges uses runGitOrThrow (errors are not silently swallowed)
 * - getCheckpointDiff uses diff-tree --root for first checkpoint (no parent)
 * - read-tree HEAD falls back to read-tree --empty on unborn HEAD
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the git runner before importing
vi.mock("../git/runner.js", () => ({
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
}));

vi.mock("../detector/working-tree.js", () => ({
  getChangedFiles: vi.fn(),
  getNumstat: vi.fn().mockResolvedValue([]),
}));

// Mock node:fs and node:os for temp file handling
vi.mock("node:fs", () => ({
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));
vi.mock("node:os", () => ({
  tmpdir: () => "/tmp",
}));
vi.mock("node:crypto", () => ({
  randomBytes: () => ({ toString: () => "abcdef01" }),
}));

import { createSnapshot, getCheckpointDiff } from "./creator.js";
import { runGit, runGitOrThrow } from "../git/runner.js";

const mockRunGit = vi.mocked(runGit);
const mockRunGitOrThrow = vi.mocked(runGitOrThrow);

describe("getCheckpointDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses git diff between two commits when parentSha is provided", async () => {
    mockRunGit.mockResolvedValue({
      stdout: "diff --git a/file.ts b/file.ts\n+new line\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await getCheckpointDiff("/test", "commit-sha", "parent-sha");

    expect(mockRunGit).toHaveBeenCalledWith(
      ["diff", "parent-sha", "commit-sha"],
      { cwd: "/test" },
    );
    expect(result).toContain("diff --git");
  });

  it("uses diff-tree --root when parentSha is absent (first checkpoint)", async () => {
    mockRunGit.mockResolvedValue({
      stdout: "diff --git a/file.ts b/file.ts\n+initial content\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await getCheckpointDiff("/test", "commit-sha");

    expect(mockRunGit).toHaveBeenCalledWith(
      ["diff-tree", "--root", "-p", "commit-sha"],
      { cwd: "/test" },
    );
    expect(result).toContain("initial content");
  });

  it("does not use sha^ syntax (which would fail on root commits)", async () => {
    mockRunGit.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    await getCheckpointDiff("/test", "commit-sha");

    const args = mockRunGit.mock.calls[0][0];
    // Ensure we never use the old sha^ pattern
    expect(args.join(" ")).not.toContain("^");
  });

  it("appends file filter when filePath is provided", async () => {
    mockRunGit.mockResolvedValue({
      stdout: "diff output",
      stderr: "",
      exitCode: 0,
    });

    await getCheckpointDiff("/test", "sha", "parent-sha", "src/index.ts");

    expect(mockRunGit).toHaveBeenCalledWith(
      ["diff", "parent-sha", "sha", "--", "src/index.ts"],
      { cwd: "/test" },
    );
  });

  it("appends file filter with diff-tree --root when no parent", async () => {
    mockRunGit.mockResolvedValue({
      stdout: "diff output",
      stderr: "",
      exitCode: 0,
    });

    await getCheckpointDiff("/test", "sha", undefined, "src/index.ts");

    expect(mockRunGit).toHaveBeenCalledWith(
      ["diff-tree", "--root", "-p", "sha", "--", "src/index.ts"],
      { cwd: "/test" },
    );
  });
});

describe("createSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no changes detected", async () => {
    const result = await createSnapshot(
      "/test",
      "parent-sha",
      "test message",
      "refs/adit/checkpoints/evt-001",
      [], // empty changes
    );

    expect(result).toBeNull();
  });

  it("falls back to read-tree --empty when HEAD is unborn", async () => {
    // read-tree HEAD fails (unborn)
    mockRunGit.mockResolvedValueOnce({
      stdout: "",
      stderr: "fatal: not a valid object name: HEAD",
      exitCode: 128,
    });

    // All subsequent runGitOrThrow calls succeed
    mockRunGitOrThrow
      .mockResolvedValueOnce("") // read-tree --empty
      .mockResolvedValueOnce("") // add
      .mockResolvedValueOnce("tree-sha-123") // write-tree
      .mockResolvedValueOnce("commit-sha-456") // commit-tree
      .mockResolvedValueOnce(""); // update-ref

    const result = await createSnapshot(
      "/test",
      null, // no parent
      "test message",
      "refs/adit/checkpoints/evt-001",
      [{ path: "new-file.ts", status: "A" }],
    );

    // read-tree --empty should have been called
    expect(mockRunGitOrThrow).toHaveBeenCalledWith(
      ["read-tree", "--empty"],
      expect.objectContaining({ cwd: "/test" }),
    );
    expect(result).not.toBeNull();
    expect(result!.sha).toBe("commit-sha-456");
  });

  it("uses read-tree HEAD when HEAD exists", async () => {
    // read-tree HEAD succeeds
    mockRunGit.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    mockRunGitOrThrow
      .mockResolvedValueOnce("") // add
      .mockResolvedValueOnce("tree-sha") // write-tree
      .mockResolvedValueOnce("commit-sha") // commit-tree
      .mockResolvedValueOnce(""); // update-ref

    await createSnapshot(
      "/test",
      "parent-sha",
      "test message",
      "refs/adit/checkpoints/evt-001",
      [{ path: "file.ts", status: "M" }],
    );

    // read-tree HEAD was called via runGit (not runGitOrThrow)
    expect(mockRunGit).toHaveBeenCalledWith(
      ["read-tree", "HEAD"],
      expect.objectContaining({ cwd: "/test" }),
    );
    // read-tree --empty should NOT have been called
    const readTreeEmptyCalls = mockRunGitOrThrow.mock.calls.filter(
      (call) => call[0][0] === "read-tree" && call[0][1] === "--empty",
    );
    expect(readTreeEmptyCalls).toHaveLength(0);
  });

  it("uses runGitOrThrow for staging (errors propagate)", async () => {
    // read-tree HEAD succeeds
    mockRunGit.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    // Staging fails
    mockRunGitOrThrow.mockRejectedValueOnce(
      new Error("git add failed (exit 1): fatal: pathspec 'deleted.ts' did not match any files"),
    );

    await expect(
      createSnapshot(
        "/test",
        "parent-sha",
        "test message",
        "refs/adit/checkpoints/evt-001",
        [{ path: "deleted.ts", status: "M" }],
      ),
    ).rejects.toThrow("git add failed");
  });

  it("includes -p parentSha in commit-tree when parentSha is provided", async () => {
    mockRunGit.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    mockRunGitOrThrow
      .mockResolvedValueOnce("") // add
      .mockResolvedValueOnce("tree-sha") // write-tree
      .mockResolvedValueOnce("commit-sha") // commit-tree
      .mockResolvedValueOnce(""); // update-ref

    await createSnapshot(
      "/test",
      "parent-sha-abc",
      "test message",
      "refs/adit/checkpoints/evt-001",
      [{ path: "file.ts", status: "M" }],
    );

    // commit-tree should include -p parentSha
    const commitTreeCall = mockRunGitOrThrow.mock.calls.find(
      (call) => call[0][0] === "commit-tree",
    );
    expect(commitTreeCall).toBeDefined();
    expect(commitTreeCall![0]).toContain("-p");
    expect(commitTreeCall![0]).toContain("parent-sha-abc");
  });

  it("omits -p in commit-tree when parentSha is null", async () => {
    mockRunGit.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });

    mockRunGitOrThrow
      .mockResolvedValueOnce("") // add
      .mockResolvedValueOnce("tree-sha") // write-tree
      .mockResolvedValueOnce("commit-sha") // commit-tree
      .mockResolvedValueOnce(""); // update-ref

    await createSnapshot(
      "/test",
      null,
      "test message",
      "refs/adit/checkpoints/evt-001",
      [{ path: "file.ts", status: "A" }],
    );

    const commitTreeCall = mockRunGitOrThrow.mock.calls.find(
      (call) => call[0][0] === "commit-tree",
    );
    expect(commitTreeCall).toBeDefined();
    expect(commitTreeCall![0]).not.toContain("-p");
  });
});
