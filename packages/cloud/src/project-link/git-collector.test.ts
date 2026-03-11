/**
 * Tests for git metadata collection utilities.
 *
 * Pure functions (projectNameFromRemoteUrl) are tested directly.
 * Git-dependent functions are tested with a temporary git repository.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  projectNameFromRemoteUrl,
  collectBranches,
  collectCurrentBranch,
  collectCommitLogs,
  collectCommitCount,
  collectDefaultBranch,
  collectRemoteUrl,
  resolveCommitBranches,
} from "./git-collector.js";

describe("projectNameFromRemoteUrl", () => {
  it("extracts name from HTTPS URL with .git suffix", () => {
    expect(projectNameFromRemoteUrl("https://github.com/user/my-repo.git")).toBe("my-repo");
  });

  it("extracts name from HTTPS URL without .git suffix", () => {
    expect(projectNameFromRemoteUrl("https://github.com/user/my-repo")).toBe("my-repo");
  });

  it("extracts name from SSH URL", () => {
    expect(projectNameFromRemoteUrl("git@github.com:user/my-repo.git")).toBe("my-repo");
  });

  it("extracts name from SSH URL without .git", () => {
    expect(projectNameFromRemoteUrl("git@github.com:user/my-repo")).toBe("my-repo");
  });

  it("handles nested paths", () => {
    expect(projectNameFromRemoteUrl("https://gitlab.com/org/sub/my-repo.git")).toBe("my-repo");
  });

  it("handles bare names", () => {
    expect(projectNameFromRemoteUrl("my-repo")).toBe("my-repo");
  });
});

describe("Git Collector (with temp repo)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = join(tmpdir(), `adit-git-test-${randomBytes(8).toString("hex")}`);
    mkdirSync(repoDir, { recursive: true });

    // Initialize a git repo with a commit
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "pipe" });
    execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "pipe" });
    // Set default branch name explicitly
    execSync("git checkout -b main", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "README.md"), "# Test\n");
    execSync("git add . && git commit -m 'Initial commit'", { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("collectRemoteUrl throws when no remote exists", async () => {
    await expect(collectRemoteUrl(repoDir)).rejects.toThrow("No git remote 'origin'");
  });

  it("collectRemoteUrl returns URL when remote exists", async () => {
    execSync("git remote add origin https://github.com/test/repo.git", { cwd: repoDir, stdio: "pipe" });
    const url = await collectRemoteUrl(repoDir);
    expect(url).toBe("https://github.com/test/repo.git");
  });

  it("collectDefaultBranch detects main branch", async () => {
    const branch = await collectDefaultBranch(repoDir);
    expect(branch).toBe("main");
  });

  it("collectBranches lists branches with SHA", async () => {
    const branches = await collectBranches(repoDir);
    expect(branches.length).toBeGreaterThanOrEqual(1);
    const main = branches.find((b) => b.name === "main");
    expect(main).toBeDefined();
    expect(main!.headSha).toBeTruthy();
  });

  it("collectCommitLogs returns commits", async () => {
    // Add a second commit
    writeFileSync(join(repoDir, "file.txt"), "hello\n");
    execSync("git add . && git commit -m 'Add file'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir);
    expect(commits.length).toBe(2);
    expect(commits[0].message).toBe("Add file");
    expect(commits[1].message).toBe("Initial commit");
    expect(commits[0].authorEmail).toBe("test@example.com");
  });

  it("collectCommitLogs returns incremental commits since SHA", async () => {
    // Get the first commit SHA
    const firstSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    // Add two more commits
    writeFileSync(join(repoDir, "a.txt"), "a\n");
    execSync("git add . && git commit -m 'Add a'", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "b.txt"), "b\n");
    execSync("git add . && git commit -m 'Add b'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, firstSha);
    expect(commits.length).toBe(2);
    expect(commits[0].message).toBe("Add b");
    expect(commits[1].message).toBe("Add a");
  });

  it("collectCommitLogs handles commit messages with pipe characters", async () => {
    writeFileSync(join(repoDir, "pipe.txt"), "content\n");
    execSync("git add . && git commit -m 'fix: handle a|b|c cases'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir);
    const latest = commits[0];
    expect(latest.message).toBe("fix: handle a|b|c cases");
  });

  it("collectCommitLogs captures multi-line commit body", async () => {
    writeFileSync(join(repoDir, "body.txt"), "content\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    // Use git commit with a multi-line message (subject + body)
    execSync(
      "git commit -m 'feat: add new feature' -m 'This is the body explaining the change.\n\nIt spans multiple lines with a blank line.'",
      { cwd: repoDir, stdio: "pipe" },
    );

    const commits = await collectCommitLogs(repoDir);
    const latest = commits[0];
    expect(latest.message).toContain("feat: add new feature");
    expect(latest.message).toContain("This is the body explaining the change.");
    expect(latest.message).toContain("It spans multiple lines");
  });

  it("collectCommitLogs handles commit body with pipe and special chars", async () => {
    writeFileSync(join(repoDir, "special.txt"), "content\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync(
      "git commit -m 'fix: edge case' -m 'Handle input|output pipes and special chars: <>&'",
      { cwd: repoDir, stdio: "pipe" },
    );

    const commits = await collectCommitLogs(repoDir);
    const latest = commits[0];
    expect(latest.message).toContain("fix: edge case");
    expect(latest.message).toContain("input|output pipes");
  });

  it("collectCurrentBranch returns current branch name", async () => {
    const branch = await collectCurrentBranch(repoDir);
    expect(branch).toBe("main");
  });

  it("collectCurrentBranch returns branch after checkout", async () => {
    execSync("git checkout -b feature/test", { cwd: repoDir, stdio: "pipe" });
    const branch = await collectCurrentBranch(repoDir);
    expect(branch).toBe("feature/test");
  });

  it("collectCurrentBranch returns null in detached HEAD state", async () => {
    const sha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();
    execSync(`git checkout ${sha}`, { cwd: repoDir, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const branch = await collectCurrentBranch(repoDir);
    expect(branch).toBeNull();
  });

  it("collectCommitLogs tags commits with branch when provided via options", async () => {
    writeFileSync(join(repoDir, "tagged.txt"), "content\n");
    execSync("git add . && git commit -m 'Tagged commit'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, { branch: "main" });
    expect(commits.length).toBe(2);
    expect(commits[0].branch).toBe("main");
    expect(commits[1].branch).toBe("main");
  });

  it("collectCommitLogs leaves branch undefined when not provided", async () => {
    const commits = await collectCommitLogs(repoDir);
    expect(commits[0].branch).toBeUndefined();
  });

  it("collectCommitLogs works with options object and sinceCommitSha", async () => {
    const firstSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    writeFileSync(join(repoDir, "opt.txt"), "options\n");
    execSync("git add . && git commit -m 'Options commit'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, {
      sinceCommitSha: firstSha,
      branch: "feature/x",
    });
    expect(commits.length).toBe(1);
    expect(commits[0].message).toBe("Options commit");
    expect(commits[0].branch).toBe("feature/x");
  });

  it("collectCommitLogs still accepts legacy string argument for backward compat", async () => {
    const firstSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf-8" }).trim();

    writeFileSync(join(repoDir, "compat.txt"), "compat\n");
    execSync("git add . && git commit -m 'Compat commit'", { cwd: repoDir, stdio: "pipe" });

    const commits = await collectCommitLogs(repoDir, firstSha);
    expect(commits.length).toBe(1);
    expect(commits[0].message).toBe("Compat commit");
    expect(commits[0].branch).toBeUndefined();
  });

  it("collectCommitCount returns total count", async () => {
    const count = await collectCommitCount(repoDir);
    expect(count).toBe(1);

    writeFileSync(join(repoDir, "x.txt"), "x\n");
    execSync("git add . && git commit -m 'Second'", { cwd: repoDir, stdio: "pipe" });

    const count2 = await collectCommitCount(repoDir);
    expect(count2).toBe(2);
  });

  it("resolveCommitBranches assigns correct branch per commit", async () => {
    // Create a feature branch with its own commit
    execSync("git checkout -b feature/x", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execSync("git add . && git commit -m 'Feature commit'", { cwd: repoDir, stdio: "pipe" });

    // Switch back to main and add another commit
    execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "main.txt"), "main\n");
    execSync("git add . && git commit -m 'Main commit'", { cwd: repoDir, stdio: "pipe" });

    // Collect all commits from main (2: "Main commit" + "Initial commit")
    const mainCommits = await collectCommitLogs(repoDir);
    expect(mainCommits.length).toBe(2);

    // Collect branches
    const branches = await collectBranches(repoDir);

    // Resolve branches
    await resolveCommitBranches(repoDir, mainCommits, branches, "main");

    // "Main commit" should be on main (only reachable from main)
    const mainCommit = mainCommits.find((c) => c.message === "Main commit");
    expect(mainCommit).toBeDefined();
    expect(mainCommit!.branch).toBe("main");

    // "Initial commit" is reachable from both branches; feature/x should
    // win because non-default branches are processed first
    const initialCommit = mainCommits.find((c) => c.message === "Initial commit");
    expect(initialCommit).toBeDefined();
    expect(initialCommit!.branch).toBe("feature/x");
  });

  it("resolveCommitBranches attributes feature branch commits correctly", async () => {
    // Create two feature branches with distinct commits
    execSync("git checkout -b feature/a", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "a.txt"), "a\n");
    execSync("git add . && git commit -m 'Commit on A'", { cwd: repoDir, stdio: "pipe" });

    execSync("git checkout main", { cwd: repoDir, stdio: "pipe" });
    execSync("git checkout -b feature/b", { cwd: repoDir, stdio: "pipe" });
    writeFileSync(join(repoDir, "b.txt"), "b\n");
    execSync("git add . && git commit -m 'Commit on B'", { cwd: repoDir, stdio: "pipe" });

    // Collect commits from feature/b (sees "Commit on B" + "Initial commit")
    const commits = await collectCommitLogs(repoDir);
    const branches = await collectBranches(repoDir);

    await resolveCommitBranches(repoDir, commits, branches, "main");

    const commitB = commits.find((c) => c.message === "Commit on B");
    expect(commitB).toBeDefined();
    expect(commitB!.branch).toBe("feature/b");
  });

  it("resolveCommitBranches handles empty commits array", async () => {
    const branches = await collectBranches(repoDir);
    const result = await resolveCommitBranches(repoDir, [], branches, "main");
    expect(result).toEqual([]);
  });

  it("resolveCommitBranches handles empty branches array", async () => {
    const commits = await collectCommitLogs(repoDir);
    await resolveCommitBranches(repoDir, commits, [], "main");
    // All commits should have no branch assigned
    for (const c of commits) {
      expect(c.branch).toBeUndefined();
    }
  });
});
