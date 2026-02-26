# ADIT Core — AI Development Intent Tracker

## Project Overview

ADIT Core is the client-side component of the AI Development Intent Tracker — a "Transparent Time Machine" for AI-assisted development. It serves as a flight recorder that captures the complete context of every interaction, reasoning step, and code modification.

## Architecture

This is a TypeScript **pnpm monorepo** with five packages:

- **`@adit/core`** — Types, SQLite database, config, ULID/vector-clock sync primitives
- **`@adit/engine`** — Git operations, snapshot creation (temp-index), change detection, timeline management, environment capture
- **`@adit/hooks`** — Hook handlers for AI platforms (currently Claude Code)
- **`@adit/cli`** — Commander.js CLI with commands: init, list, show, revert, undo, label, search, diff, prompt, env, doctor, export
- **`@adit/plans`** — SpecFlow-inspired plan artifact generator (Intent → Roadmap → Tasks)

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
