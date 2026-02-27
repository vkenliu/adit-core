# ADIT Core — AI Development Intent Tracker

## Project Overview

ADIT Core is the client-side component of the AI Development Intent Tracker — a "Transparent Time Machine" for AI-assisted development. It serves as a flight recorder that captures the complete context of every interaction, reasoning step, and code modification.

## Architecture

This is a TypeScript **pnpm monorepo** with six packages:

- **`@adit/core`** — Types, SQLite database, config, ULID/vector-clock sync primitives
- **`@adit/engine`** — Git operations, snapshot creation (temp-index), change detection, timeline management, environment capture
- **`@adit/hooks`** — Hook handlers for AI platforms (Claude Code, with stubs for Cursor, Copilot, OpenCode, Codex)
- **`@adit/cli`** — Commander.js CLI (see commands below)
- **`@adit/cloud`** — Cloud sync client (device-code auth, cursor-based push, transcript upload)
- **`@adit/plans`** — SpecFlow-inspired plan artifact generator (Intent → Roadmap → Tasks)

### CLI Commands

| Command | Description |
|---|---|
| `init` | Initialize ADIT in the current project |
| `list` (alias `ls`) | Show timeline entries |
| `show <id>` | Show full event details |
| `revert <id>` | Revert working tree to a checkpoint |
| `undo` | Revert to parent of last checkpoint |
| `label add/remove/list` | Manage labels on events |
| `search <query>` | Search events by text with filters |
| `diff <id>` | Show diff for a checkpoint event |
| `prompt <id>` | Show prompt text for an event |
| `env show/latest/diff/history` | Environment snapshot commands |
| `status` | Show ADIT status for the current project |
| `doctor` | Validate ADIT installation health |
| `config` | Show ADIT configuration |
| `export event/session` | Export event data |
| `plugin install/uninstall/list/validate` | Manage platform plugin integrations |
| `cloud login/logout/sync/status` | Cloud sync commands |
| `cloud transcript enable/disable/status/upload/reset` | Transcript upload management |
| `db clear-events` | Database management |
| `tui` | Launch the interactive terminal UI |

## Key Design Decisions

1. **Git-Native, Non-Polluting**: Checkpoints stored as `refs/adit/checkpoints/<id>`, never on branch history
2. **Temporary GIT_INDEX_FILE**: Snapshots never touch the user's staging area
3. **SQLite + ULID + Vector Clocks**: Designed for future cloud sync with conflict resolution
4. **Fail-Open Hooks**: Recording errors never block the AI agent
5. **Multi-Actor Timeline**: Distinguished actors — Assistant (A), User (U), Tool (T), System (S)
6. **Platform Adapter Pattern**: Adding new AI platforms is a new adapter, not a rewrite

## Building

```bash
pnpm install
pnpm build
```

## Testing

```bash
pnpm test
```

## Data Directory

ADIT stores its data in `.adit/` at the project root:
- `adit.sqlite` — SQLite database
- `plans/` — SpecFlow markdown artifacts

## Cloud Sync (Future)

All records use ULIDs (time-sortable, globally unique) and vector clocks for conflict-free merge:
- Append-only events never conflict
- Mutable records use LWW with vector clock comparison
- Checkpoints are immutable (SHA-addressed)
