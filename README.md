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
- **Shadow Git Checkpoints** — Instant revert to any working state via `adit snapshot revert <id>`
- **Interactive Revert Picker** — `adit snapshot revert` (no ID) shows a numbered list of checkpoints with SHA, timestamp, file count, and summary
- **Session Resume** — `adit snapshot resume [branch]` restores working tree from the latest checkpoint on a branch, prints session context, and outputs platform-specific continue commands
- **Squash-Merge Support** — Resume and revert work after squash merges; automatically finds checkpoints from deleted branches with SHA reachability validation and graceful fallbacks
- **Content-Aware Secret Redaction** — Shannon entropy scoring with 35+ regex patterns (AWS, GitHub, Stripe, etc.), configurable thresholds and skip rules, custom pattern support
- **Hook Chaining** — Installs alongside other tools' hooks (Entire CLI, linters, formatters) without overwriting; reinstalls cleanly replace only ADIT entries
- **Multi-Actor Timeline** — Distinguishes assistant, user, tool, and system actions
- **Environment Snapshotting** — Captures git state, dependency versions, runtime context, Docker detection, shell info, CPU/memory, and package managers
- **Environment Drift Detection** — Automatically detects and records environment changes between sessions
- **Cloud Sync** — Device-code authentication, cursor-based incremental push, auto-sync after hook events, transcript upload, and rolling-window circuit breaker
- **Auto-Sync** — Fire-and-forget cloud sync triggered by record count threshold or time elapsed, with fail-open error handling
- **Platform Session Tracking** — Correlates events to platform-native session IDs for accurate multi-session handling
- **SpecFlow Planning** — Structured Intent → Roadmap → Tasks workflow
- **Interactive TUI** — Full terminal UI built with React/Ink with live detail updates, search, diffs, and environment snapshots
- **Platform Adapter System** — Pluggable architecture for AI platform integration (Claude Code and OpenCode fully supported, extensible to Cursor, Copilot, Codex, and others)
- **Plugin Management** — Install, validate, and manage platform hooks via `adit plugin` with `--all` auto-detect and `--clean` data removal
- **Advanced Search** — Full-text search with actor, type, date range, branch, and checkpoint filters
- **Flexible Export** — Export events and sessions as JSON, JSONL, or Markdown reports with optional gzip compression
- **Fail-Open Hooks** — Recording errors never block the AI agent

## Architecture

TypeScript pnpm monorepo with six packages:

| Package | Description |
|---------|-------------|
| `@adit/core` | Types, SQLite database, config, sync primitives (ULID, vector clocks), content-aware secret redaction |
| `@adit/engine` | Git operations, temp-index snapshots, change detection, timeline management, environment capture |
| `@adit/hooks` | Hook handlers with platform adapter registry (Claude Code adapter implemented) |
| `@adit/cli` | Commander.js CLI with interactive TUI (React/Ink) |
| `@adit/cloud` | Cloud sync client — device-code auth, HTTP client with token refresh, incremental sync engine, transcript upload |
| `@adit/plans` | SpecFlow-inspired plan artifact generator |

### Platform Adapters

ADIT uses a pluggable adapter pattern for AI platform integration. Each adapter maps platform-specific hook events to normalized ADIT handlers:

- **Claude Code** — Fully supported with hook chaining (installs alongside other tools' hooks). Hooks: `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `TaskCompleted`, `Notification`, `SubagentStart`, `SubagentStop`
- **OpenCode** — Fully supported via generated plugin. Events: `chat.message`, `session.idle`, `session.created`, `session.deleted`, `session.error`, `command.executed`, `todo.updated`, `message.part.updated`. Includes process exit/signal safety net for session-end.
- **Cursor, GitHub Copilot, Codex** — Detected by the adapter registry; adapters can be contributed

Adapters are registered via `registerAdapter()` and auto-detected from environment variables.

### Cloud Sync

Cloud sync uses a cursor-based incremental push model:

- **Auto-sync** triggers after every hook event when credentials exist (opt-in via `adit cloud login`)
- **Count-based trigger** — syncs when unsynced records reach the threshold (default: 20, configurable via `ADIT_CLOUD_SYNC_THRESHOLD`)
- **Time-based trigger** — syncs when time since last sync exceeds timeout (default: 2 hours, configurable via `ADIT_CLOUD_SYNC_TIMEOUT_HOURS`)
- **Transcript upload** — incremental upload of AI conversation transcripts
- **Circuit breaker** — Auto-sync disables after repeated failures within a 1-hour rolling window and auto-recovers when the window expires
- All sync errors are fail-open — network or auth failures are silently retried on the next trigger
- Disable auto-sync with `ADIT_CLOUD_AUTO_SYNC=false` or `ADIT_CLOUD_ENABLED=false`

### Skills & Agents

ADIT ships with **10 Claude Code skills** (in `skills/`) for natural-language interaction:

`timeline` · `checkpoint` · `revert` · `diff` · `search` · `env` · `status` · `doctor`

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

# Authenticate with cloud (optional)
npx adit cloud login --server <url>
```

## CLI Commands

### Core

| Command | Description |
|---------|-------------|
| `adit init` | Initialize hooks + data directory (`--platform`, `--force` to reinstall) |
| `adit status` | Styled status with session card, git state, sync info, and hook configuration (`--json`) |
| `adit config` | Show current configuration (`--json`) |
| `adit doctor` | Validate installation: SQLite integrity, hooks, stale sessions, disk usage (`--fix`, `--json`) |

### Timeline

| Command | Description |
|---------|-------------|
| `adit list` | Show timeline entries with `--limit`, `--actor`, `--type`, `--sort` (ACTOR/TIME), `--json` |
| `adit show <id>` | Full event detail with prompt, CoT, and diff |
| `adit search <query>` | Full-text search with `--actor`, `--type`, `--from`/`--to`, `--branch`, `--has-checkpoint`, `--json` |
| `adit tui` | Interactive terminal UI with keyboard navigation |

### Prompt

| Command | Description |
|---------|-------------|
| `adit prompt <id>` | Show prompt text with `--max-chars`, `--offset` |

### Snapshot (Git Checkpoints)

All git checkpoint operations are grouped under `adit snapshot` to clearly separate them from read-only timeline commands:

| Command | Description |
|---------|-------------|
| `adit snapshot revert [id]` | Restore working tree to checkpoint; interactive picker if no ID given (`--yes`, `--limit`) |
| `adit snapshot undo` | Revert to parent of last checkpoint |
| `adit snapshot resume [branch]` | Resume session from latest checkpoint on a branch; supports squash-merged branches; prints continue commands (`--yes`) |
| `adit snapshot diff <id>` | Show diff with `--max-lines`, `--offset-lines`, `--file` |
| `adit snapshot env show <id>` | Show environment snapshot for an event |
| `adit snapshot env latest` | Show most recent snapshot (`--json`) |
| `adit snapshot env diff <id1> <id2>` | Compare two snapshots with categorized changes and severity (`--json`) |
| `adit snapshot env history` | List snapshot history (`--limit`, `--json`) |

### Export

| Command | Description |
|---------|-------------|
| `adit export event <id>` | Export a single event (`--format json`, `--output`) |
| `adit export session [id]` | Export full session (`--format json\|jsonl\|markdown`, `--include-diffs`, `--include-env`, `--gzip`) |

### Cloud Sync

| Command | Description |
|---------|-------------|
| `adit cloud login` | Authenticate via device code flow (`--server <url>`) |
| `adit cloud logout` | Clear stored cloud credentials |
| `adit cloud sync` | Push unsynced records to cloud (`--json`) |
| `adit cloud status` | Show cloud sync status with server reachability (`--json`) |
| `adit cloud reset-credentials` | Force-clear all credentials and sync state (`--yes`) |
| `adit cloud transcript enable` | Enable automatic transcript upload |
| `adit cloud transcript disable` | Disable automatic transcript upload |
| `adit cloud transcript status` | Show transcript upload status (`--json`) |
| `adit cloud transcript upload` | Manually trigger transcript uploads (`--json`) |
| `adit cloud transcript reset <id>` | Reset a failed transcript for re-upload (`--json`) |

### Plugins

| Command | Description |
|---------|-------------|
| `adit plugin install [platform]` | Install hooks for a platform |
| `adit plugin uninstall [platform]` | Remove hooks (`--all` for all platforms, `--clean` to remove data dir) |
| `adit plugin list` | List available platform adapters |
| `adit plugin validate [platform]` | Validate hook installation |

### Database Management

| Command | Description |
|---------|-------------|
| `adit db clear-events` | Delete all local events, sessions, diffs, and env snapshots (`--yes`, `--json`) |

### Performance

| Command | Description |
|---------|-------------|
| `adit perf stats` | Show performance stats report (`--from`, `--to`, `--category`, `--json`) |
| `adit perf clear` | Clear all performance logs (`--json`) |

## Interactive TUI

Launch with `adit tui` for a full-screen terminal interface:

- **Timeline screen** — Scrollable event list with live detail panel (updates as you navigate)
- **Diff viewer** — Syntax-highlighted diff output
- **Search screen** — Interactive text search
- **Environment screen** — Full snapshot details
- **Help overlay** — Keybinding reference

**Keyboard shortcuts:** `j`/`k` navigate (detail updates live), `d` diff, `p` prompt, `e` environment, `/` search, `f` filter, `s` cycle sort (TIME/ACTOR), `Esc`/`b` back, `q` quit. Auto-refreshes every 2 seconds.

## Platform Support

Currently supports **Claude Code** via hooks and **OpenCode** via generated plugin.

Architecture uses a platform adapter pattern — adding a new AI platform (Cursor, Copilot, etc.) requires implementing a `PlatformAdapter` interface, not a rewrite.

## Data Directory

ADIT stores its data in `.adit/` at the project root:
- `adit.sqlite` — SQLite database (events, sessions, checkpoints, environment snapshots, sync state)
- `plans/` — SpecFlow markdown artifacts

Cloud credentials are stored in `~/.adit/cloud-credentials.json` (file permissions 0600).

## Configuration

| Environment Variable | Description | Default |
|----------------------|-------------|---------|
| `ADIT_CLOUD_URL` | Cloud server URL | *(from credentials)* |
| `ADIT_CLOUD_AUTO_SYNC` | Set to `false` to disable auto-sync | enabled |
| `ADIT_CLOUD_ENABLED` | Set to `false` to disable all cloud features | enabled |
| `ADIT_CLOUD_SYNC_THRESHOLD` | Unsynced record count before auto-sync triggers | `20` |
| `ADIT_CLOUD_SYNC_TIMEOUT_HOURS` | Hours since last sync before auto-sync triggers | `2` |
| `ADIT_CLOUD_BATCH_SIZE` | Max records per sync batch | `500` |
| `ADIT_CAPTURE_ENV` | Set to `false` to disable environment snapshots | `true` |
| `ADIT_DEBUG` | Enable debug output for cloud sync errors | *(off)* |

## Requirements

- Node.js >= 20.0.0
- pnpm >= 9.0.0

## License

MIT
