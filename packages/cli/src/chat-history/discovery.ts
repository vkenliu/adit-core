/**
 * Claude Code project and session discovery.
 *
 * Discovers Claude Code projects and sessions stored under
 * `~/.claude/projects/` and matches them to the current working directory.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ClaudeProject {
  /** Escaped directory name (e.g. "-Users-kenliu-Code-adit-core") */
  dirName: string;
  /** Resolved real path (e.g. "/Users/kenliu/Code/adit-core") */
  realPath: string;
  /** Full path to the project directory under ~/.claude/projects/ */
  projectDir: string;
}

export interface ClaudeSession {
  /** Session UUID */
  id: string;
  /** Full path to the session's JSONL file */
  filePath: string;
  /** Last modification time */
  mtime: Date;
  /** File size in bytes */
  sizeBytes: number;
  /** Whether the session has a subdirectory (subagents, tool-results) */
  hasSubdir: boolean;
}

/* ------------------------------------------------------------------ */
/*  Default Claude directory                                           */
/* ------------------------------------------------------------------ */

function getDefaultClaudeDir(): string {
  return join(homedir(), ".claude", "projects");
}

/* ------------------------------------------------------------------ */
/*  Path escaping/unescaping                                           */
/* ------------------------------------------------------------------ */

/**
 * Claude Code escapes paths by replacing `/` with `-`.
 * e.g. `/Users/kenliu/Code/adit-core` → `-Users-kenliu-Code-adit-core`
 */
function unescapePath(dirName: string): string {
  // The escaped form starts with `-` (for the leading `/`)
  // and uses `-` instead of `/` for path separators.
  return dirName.replace(/-/g, "/");
}

/**
 * Escape a path to match Claude Code's directory naming convention.
 */
export function escapePath(realPath: string): string {
  return realPath.replace(/\//g, "-");
}

/* ------------------------------------------------------------------ */
/*  Discovery functions                                                */
/* ------------------------------------------------------------------ */

/**
 * Discover all Claude Code projects under `~/.claude/projects/`.
 */
export function discoverProjects(claudeDir?: string): ClaudeProject[] {
  const dir = claudeDir ?? getDefaultClaudeDir();

  if (!existsSync(dir)) {
    return [];
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const projects: ClaudeProject[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip hidden directories
    if (entry.name.startsWith(".")) continue;

    const projectDir = join(dir, entry.name);
    const realPath = unescapePath(entry.name);

    projects.push({
      dirName: entry.name,
      realPath,
      projectDir,
    });
  }

  // Sort by name for stable output
  projects.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return projects;
}

/**
 * Discover sessions for a specific Claude Code project directory.
 *
 * Sessions are JSONL files directly under the project directory, named
 * by their UUID (e.g. `<uuid>.jsonl`).
 *
 * Returns sessions sorted by mtime (newest first).
 */
export function discoverSessions(projectDir: string): ClaudeSession[] {
  if (!existsSync(projectDir)) {
    return [];
  }

  const entries = readdirSync(projectDir, { withFileTypes: true });
  const sessions: ClaudeSession[] = [];
  const dirNames = new Set<string>();

  // First pass: collect directory names (session subdirs)
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirNames.add(entry.name);
    }
  }

  // Second pass: collect JSONL session files
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".jsonl")) continue;

    const sessionId = entry.name.replace(/\.jsonl$/, "");
    const filePath = join(projectDir, entry.name);

    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      continue;
    }

    sessions.push({
      id: sessionId,
      filePath,
      mtime: stats.mtime,
      sizeBytes: stats.size,
      hasSubdir: dirNames.has(sessionId),
    });
  }

  // Sort newest first
  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return sessions;
}

/**
 * Find the Claude Code project matching the given working directory.
 *
 * Matches by comparing the escaped path to discovered project directory names.
 */
export function findCurrentProject(
  cwd: string,
  claudeDir?: string,
): ClaudeProject | null {
  const resolvedCwd = resolve(cwd);
  const escaped = escapePath(resolvedCwd);
  const projects = discoverProjects(claudeDir);

  return projects.find((p) => p.dirName === escaped) ?? null;
}
