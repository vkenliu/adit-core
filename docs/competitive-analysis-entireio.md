# Competitive Analysis: Entire CLI vs ADIT Core

**Date:** 2026-03-08 (updated)
**Source:** https://github.com/entireio/cli (v0.5.0, 3.4k stars, 30 contributors)
**Branch:** `feature/competitive-analysis-entireio`

## Overview

Entire CLI and ADIT Core solve the same problem: recording AI-assisted development
sessions as a flight recorder alongside git history. Both capture sessions, create
checkpoints, and provide rewind/recovery.

| Dimension | Entire CLI | ADIT Core |
|---|---|---|
| **Language** | Go (single binary) | TypeScript (pnpm monorepo, 6 packages) |
| **Distribution** | Homebrew / `go install` | npm (requires Node.js) |
| **Storage** | Git branch (`entire/checkpoints/v1`) | SQLite (`.adit/adit.sqlite`) |
| **Cloud** | None (piggybacks on `git push`) | Full cloud sync engine |
| **Version** | v0.5.0, 23 releases, 2099 commits | v0.2.0, development stage |

---

## Feature Comparison

### 1. Hook Lifecycle (Enable / Disable)

| Capability | Entire | ADIT | Status |
|---|---|---|---|
| Install hooks | `entire enable` | `adit init` | Both |
| Remove hooks | `entire disable` | `adit plugin uninstall --all` | **Implemented** |
| Force reinstall | `entire enable --force` | `adit init --force` | **Implemented** |
| Select agent | `entire enable --agent <name>` | `adit init --platform <name>` | Both |
| Multi-select agent picker | Interactive multi-select | Not implemented | Entire |
| Local vs project settings | `--local` / `--project` flags | Env vars only | Entire |
| Remove data dir | Manual | `adit plugin uninstall --clean` | **Implemented** |
| Detect hook managers | Warns about Husky/Lefthook/Overcommit | No | Entire |
| Hook chaining | Chains with existing git hooks | Appends alongside existing hooks | **Implemented** |

### 2. Session & Checkpoint Tracking

| Capability | Entire | ADIT | Advantage |
|---|---|---|---|
| Session tracking | UUID, git-branch based | ULID, SQLite-based | ADIT (queryable) |
| Event granularity | Session-level metadata | 16 event types with parent hierarchy | **ADIT** |
| Chain-of-thought capture | Part of transcript blob | Dedicated `cot_text` field | **ADIT** |
| Sequence numbering | N/A | Atomic auto-increment per session | **ADIT** |
| Model name tracking | Captures per session (v0.5.0) | Via tool input metadata | Both |
| Token usage tracking | `CalculateTokenUsage()` per agent | Not implemented | Entire |
| Squash-merge support | Resume/rewind work after squash | Cross-branch fallback + SHA reachability | **Implemented** |
| Concurrent sessions | Warns, tracks separately | `clientId` + vector clocks | ADIT |

### 3. Rewind / Recovery

| Capability | Entire | ADIT | Status |
|---|---|---|---|
| Interactive picker | `entire rewind` | `adit snapshot revert` (no ID) | **Implemented** |
| Revert by ID | Via picker only | `adit snapshot revert <id>` | Both |
| Undo last change | Not documented | `adit snapshot undo` | ADIT |
| Dependency warnings | Not documented | Detects lockfile changes | **ADIT** |
| Dirty tree warnings | Not documented | Yes, with `--yes` skip | **ADIT** |
| Revert audit trail | Not documented | Records `revert` event | **ADIT** |
| Squash-merge rewind | Supported (v0.5.0) | SHA reachability guard + fallback | **Implemented** |

### 4. Session Resume

| Capability | Entire | ADIT | Status |
|---|---|---|---|
| Resume command | `entire resume <branch>` | `adit snapshot resume [branch]` | **Implemented** |
| Restore session metadata | From checkpoint branch | Restores from branch checkpoint | Both |
| Print continue commands | Per-agent resume instructions | Per-adapter `getResumeCommand()` | **Implemented** |
| Session context display | Not documented | Last 5 events + session info | **ADIT** |
| Branch switching | Implicit | `adit resume <branch>` auto-switches | Both |
| Dependency warnings | Not documented | Detects lockfile changes | **ADIT** |
| Dirty tree safety | Not documented | Warns + blocks (or `--yes` skip) | **ADIT** |
| Squash-merge resume | Supported (v0.5.0) | Cross-branch fallback for merged branches | **Implemented** |

### 5. Secret Redaction

| Capability | Entire | ADIT | Status |
|---|---|---|---|
| Key-name redaction | N/A | `redactSensitiveKeys()` | Both |
| Shannon entropy scoring | > 4.5 threshold | > 4.5 threshold, configurable | **Implemented** |
| Pattern matching | gitleaks built-in rules | 35+ regex patterns (similar coverage) | **Implemented** |
| Always-on | Cannot be disabled | Available as opt-in module | ADIT (flexible) |
| Skip rules | `signature`, `*id`, `*ids`, image/base64 | `id`, `hash`, `sha`, `signature`, etc. | Both |
| Custom patterns | No | `customPatterns` config option | **ADIT** |
| False positive tuning | Fixed in v0.4.6 (over-aggressive) | Configurable threshold + skip fields | **ADIT** |

### 6. Agent Support

| Agent | Entire | ADIT | Notes |
|---|---|---|---|
| Claude Code | Full | Full | Both |
| OpenCode | Full (v0.4.6) | Full | Both |
| Gemini CLI | Full (v0.4.3) | Not implemented | **TODO** |
| Cursor | Full checkpoints (v0.4.8) | Stub only | **TODO** |
| Droid (Factory AI) | Full (v0.4.9) | No | Entire |
| GitHub Copilot | No | Stub only | Neither |
| Codex | No | Stub only | Neither |
| External plugin system | Yes (v0.5.0, lazy discovery) | `registerAdapter()` extensibility | Both |

### 7. Cloud / Sync

| Capability | Entire | ADIT | Advantage |
|---|---|---|---|
| Cloud service | None | Full implementation | **ADIT** |
| Data sync | Piggybacks on `git push` | Incremental with circuit breaker | **ADIT** |
| Auto-push sessions | On `git push` via git hook | Time + count based triggers | ADIT |
| Multi-device sync | Git merge semantics | Vector clocks, device auth | **ADIT** |
| Offline support | Fully local (git-native) | Full offline, sync when connected | Both |
| Transcript upload | N/A | Chunked, resumable upload | **ADIT** |

### 8. CLI UX & Commands

| Capability | Entire | ADIT | Advantage |
|---|---|---|---|
| Interactive TUI | No | Full Ink-based TUI | **ADIT** |
| `explain` command | AI-powered session explanation | On cloud server | Both |
| `doctor` command | Fix stuck sessions | Health checks with `--fix` | Both |
| `status` command | Styled output with session cards | Styled session cards, sectioned layout | **Implemented** |
| `clean` command | Orphaned data cleanup | No | Entire |
| `reset` command | Delete shadow branch + state | No | Entire |
| Export formats | Not documented | JSON, JSONL, Markdown, gzip | **ADIT** |
| Search | Not documented | Full-text with filters | **ADIT** |
| Auto-summarization | Via Claude CLI at commit time | On cloud server | Both |
| Accessible mode | `ACCESSIBLE=1` for screen readers | No | Entire |
| Telemetry | Posthog (opt-out) | No client-side telemetry | ADIT (privacy) |

### 9. Environment Capture

| Capability | Entire | ADIT | Advantage |
|---|---|---|---|
| Git state | Part of session metadata | Structured snapshot | **ADIT** |
| Runtime versions | Not documented | Node, Python, Rust, Go, Java, Ruby | **ADIT** |
| System resources | Not documented | CPU, memory, disk | **ADIT** |
| Container detection | Not documented | Docker/container env | **ADIT** |
| Env drift detection | Not documented | Structured diff with severity | **ADIT** |

### 10. Data Model & Architecture

| Capability | Entire | ADIT | Advantage |
|---|---|---|---|
| Storage queryability | Git objects (not queryable) | SQLite (full SQL) | **ADIT** |
| Data privacy | Git branch (can be pushed public) | Local SQLite (never pushed) | **ADIT** |
| Schema migrations | N/A (git objects) | 10 migrations, 7 tables | **ADIT** |
| Plan/intent tracking | No | SpecFlow plans | **ADIT** |
| Performance logging | Span-based instrumentation (v0.5.0) | JSONL perf logs with pruning | Both |
| Git worktree support | Explicit support | Not documented | Entire |
| Checkpoint commit linking | Commit trailers | Ref-based (`refs/adit/checkpoints/`) | Both |

---

## Remaining Features to Implement

Features 1 (enable/disable lifecycle), 3 (content-aware redaction),
4 (interactive rewind), 5 (session resume), hook chaining, styled
status output, and squash-merge support from the original analysis
have been implemented. The remaining items are:

### P1: Broader Agent Support

- **Gemini CLI adapter**: Hook config in `.gemini/settings.json`, event mapping,
  stdin JSON parsing. Entire has full support since v0.4.3 including resume/rewind.
- **Cursor adapter**: Hook config in `.cursor/hooks.json`, event mapping.
  Entire has full checkpoint support since v0.4.8.
- **Droid (Factory AI)**: Entire added this in v0.4.9. Low priority for us
  unless user demand emerges.

### P2: Nice-to-Have Improvements

- **`clean` / `reset` commands**: Cleanup orphaned data and stuck state.
  Our `doctor --fix` partially covers this but dedicated commands are clearer.
- **Accessible mode**: `ACCESSIBLE=1` for screen reader support.
- **Token usage tracking**: Per-session token/cost metrics.

---

## Where ADIT Is Stronger (Do Not Change)

- **Event granularity** -- 16 event types with nested parent hierarchy vs
  session-level capture
- **SQLite storage** -- Queryable, never accidentally pushed public, supports
  complex filtering and export
- **Interactive TUI** -- Full Ink-based terminal UI for browsing timeline, diffs,
  search, and environment data
- **Environment capture & drift detection** -- Comprehensive runtime/system snapshot
  with structured diff and severity levels
- **Cloud sync engine** -- Proper sync with device auth, vector clocks, time-windowed
  circuit breaker, and incremental transcript upload
- **SpecFlow plans** -- Intent-to-task tracking for structured development workflows
- **AI-powered explain & auto-summarization** -- Already implemented on the cloud
  server (Entire does this client-side via Claude CLI invocation)
- **Export capabilities** -- JSON, JSONL, Markdown, gzip export formats
- **Content-aware redaction** -- Configurable entropy threshold, custom patterns,
  extensible skip rules (Entire's is always-on with fixed settings)
- **Temp index technique** -- Cleaner checkpoint creation than shadow branches
- **Data privacy** -- Local SQLite is safer than a git branch that might
  accidentally be pushed to a public repository
