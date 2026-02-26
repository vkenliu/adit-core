# ADIT Core

**AI Development Intent Tracker — The Transparent Time Machine**

A local-first flight recorder for AI-assisted development that captures the complete context of every interaction, reasoning step, and code modification.

## Design Philosophy

ADIT is built on three pillars:

1. **Atomic Traceability** — Every code change links to the prompt and Chain of Thought that produced it
2. **Git-Native, Non-Polluting** — Checkpoints stored as `refs/adit/checkpoints/<id>`, never cluttering commit history
3. **Observable Execution** — Tool calls, subagent calls, and skill invocations are all recorded

## Features

- **Integrated Prompt & CoT Capture** — Records the full dialogue including Chain of Thought
- **Shadow Git Checkpoints** — Instant revert to any working state via `adit revert <id>`
- **Multi-Actor Timeline** — Distinguishes Assistant (A), User (U), Tool (T), and System (S) actions
- **Environment Snapshotting** — Captures git state, dependency versions, runtime context, Docker detection, shell info, CPU/memory, and package managers
- **Environment Drift Detection** — Automatically detects and records environment changes between sessions
- **SpecFlow Planning** — Structured Intent → Roadmap → Tasks workflow
- **Interactive TUI** — Full terminal UI built with React/Ink for browsing the timeline, diffs, search, and environment snapshots
- **Platform Adapter System** — Pluggable architecture for AI platform integration (Claude Code supported, extensible to Cursor, Copilot, and others)
- **Plugin Management** — Install, validate, and manage platform hooks via `adit plugin`
- **Advanced Search** — Full-text search with actor, type, date range, branch, and checkpoint filters
- **Flexible Export** — Export events and sessions as JSON, JSONL, or Markdown reports with optional gzip compression
- **Cloud-Ready Data Model** — ULIDs + Vector Clocks for future multi-client sync
- **Revert Safety** — Detects dependency file changes on revert and warns to re-install
- **Fail-Open Hooks** — Recording errors never block the AI agent

## Architecture

TypeScript pnpm monorepo with five packages:

| Package | Description |
|---------|-------------|
| `@adit/core` | Types, SQLite database, config, sync primitives (ULID, vector clocks) |
| `@adit/engine` | Git operations, temp-index snapshots, change detection, timeline management, environment capture |
| `@adit/hooks` | Hook handlers with platform adapter registry (Claude Code adapter implemented) |
| `@adit/cli` | Commander.js CLI with interactive TUI (React/Ink) |
| `@adit/plans` | SpecFlow-inspired plan artifact generator |

### Platform Adapters

ADIT uses a pluggable adapter pattern for AI platform integration. Each adapter maps platform-specific hook events to normalized ADIT handlers:

- **Claude Code** — Fully supported. Hooks: `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`
- **Cursor, GitHub Copilot** — Detected by the adapter registry; adapters can be contributed

Adapters are registered via `registerAdapter()` and auto-detected from environment variables.

### Skills & Agents

ADIT ships with **10 Claude Code skills** (in `skills/`) for natural-language interaction:

`timeline` · `checkpoint` · `revert` · `diff` · `search` · `label` · `env` · `status` · `doctor`

And a **timeline-analyst** agent (in `agents/`) for deep session analysis, pattern detection, and environment drift reporting.

## Quick Start

```bash
# Install
pnpm install && pnpm build

# Initialize ADIT in your project
npx adit init

# Check installation health
npx adit doctor

# View timeline
npx adit list

# Launch interactive TUI
npx adit tui
```

## CLI Commands

### Core

| Command | Description |
|---------|-------------|
| `adit init` | Initialize hooks + data directory |
| `adit status` | Show initialization state, hooks, active session, event/checkpoint counts, and git state (`--json`) |
| `adit config` | Show current configuration (`--json`) |
| `adit doctor` | Validate installation: SQLite integrity, hooks, stale sessions, disk usage (`--fix`, `--json`) |

### Timeline

| Command | Description |
|---------|-------------|
| `adit list` | Show timeline entries with `--limit`, `--actor`, `--type`, `--sort` (SEQ/ACTOR/TIME), `--json` |
| `adit show <id>` | Full event detail with prompt, CoT, and diff |
| `adit search <query>` | Full-text search with `--actor`, `--type`, `--from`/`--to`, `--branch`, `--has-checkpoint`, `--json` |
| `adit tui` | Interactive terminal UI with keyboard navigation |

### Checkpoints & Revert

| Command | Description |
|---------|-------------|
| `adit revert <id>` | Restore working tree to checkpoint (warns on dependency changes) |
| `adit undo` | Revert to parent of last checkpoint |
| `adit diff <id>` | Show diff with `--max-lines`, `--offset-lines`, `--file` |
| `adit prompt <id>` | Show prompt text with `--max-chars`, `--offset` |

### Labels

| Command | Description |
|---------|-------------|
| `adit label add <id> <label>` | Add a label to an event |
| `adit label remove <id> <label>` | Remove a label |
| `adit label list` | List all labels (`--label`, `--json`) |

### Environment Snapshots

| Command | Description |
|---------|-------------|
| `adit env show <id>` | Show environment snapshot for an event |
| `adit env latest` | Show most recent snapshot (`--json`) |
| `adit env diff <id1> <id2>` | Compare two snapshots with categorized changes and severity (`--json`) |
| `adit env history` | List snapshot history (`--limit`, `--json`) |

### Export

| Command | Description |
|---------|-------------|
| `adit export event <id>` | Export a single event (`--format json`, `--output`) |
| `adit export session [id]` | Export full session (`--format json\|jsonl\|markdown`, `--include-diffs`, `--include-env`, `--gzip`) |

### Plugins

| Command | Description |
|---------|-------------|
| `adit plugin install [platform]` | Install hooks for a platform |
| `adit plugin uninstall [platform]` | Remove hooks |
| `adit plugin list` | List available platform adapters |
| `adit plugin validate [platform]` | Validate hook installation |

### Planning

| Command | Description |
|---------|-------------|
| `adit plan init` | Start SpecFlow planning |
| `adit plan task <desc>` | Create a plan task |

## Interactive TUI

Launch with `adit tui` for a full-screen terminal interface:

- **Timeline screen** — Scrollable event list with detail panel
- **Diff viewer** — Syntax-highlighted diff output
- **Search screen** — Interactive text search
- **Environment screen** — Full snapshot details
- **Help overlay** — Keybinding reference

**Keyboard shortcuts:** `j`/`k` navigate, `d` diff, `e` environment, `/` search, `f` filter, `q` quit. Auto-refreshes every 2 seconds.

## Platform Support

Currently supports **Claude Code** via hooks (`UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`).

Architecture uses a platform adapter pattern — adding a new AI platform (Cursor, Copilot, etc.) requires implementing a `PlatformAdapter` interface, not a rewrite.

## Data Directory

ADIT stores its data in `.adit/` at the project root:
- `adit.sqlite` — SQLite database (events, sessions, checkpoints, environment snapshots)
- `plans/` — SpecFlow markdown artifacts

## Requirements

- Node.js >= 20.0.0
- pnpm >= 9.0.0

## License

MIT
