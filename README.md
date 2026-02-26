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
- **Environment Snapshotting** — Captures git state, dependency versions, and runtime context
- **SpecFlow Planning** — Structured Intent → Roadmap → Tasks workflow
- **Cloud-Ready Data Model** — ULIDs + Vector Clocks for future multi-client sync

## Architecture

TypeScript pnpm monorepo with five packages:

| Package | Description |
|---------|-------------|
| `@adit/core` | Types, SQLite database, config, sync primitives (ULID, vector clocks) |
| `@adit/engine` | Git operations, temp-index snapshots, change detection, timeline management |
| `@adit/hooks` | Hook handlers for AI platforms (Claude Code) |
| `@adit/cli` | Commander.js CLI with TUI |
| `@adit/plans` | SpecFlow-inspired plan artifact generator |

## Quick Start

```bash
# Initialize ADIT in your project
npx adit init

# View timeline
npx adit list

# Show event details
npx adit show <id>

# Revert to a checkpoint
npx adit revert <id>

# Undo last change
npx adit undo

# Search history
npx adit search "authentication"

# Label a checkpoint
npx adit label <id> "working-auth"

# Check health
npx adit doctor
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `adit init` | Initialize hooks + data directory |
| `adit list` | Show timeline entries |
| `adit show <id>` | Full event detail with prompt, CoT, diff |
| `adit revert <id>` | Restore working tree to checkpoint |
| `adit undo` | Revert to parent of last checkpoint |
| `adit label <id> <text>` | Tag an event |
| `adit search <query>` | Full-text search |
| `adit diff <id>` | Show diff for checkpoint |
| `adit prompt <id>` | Show prompt text |
| `adit env <id>` | Show environment snapshot |
| `adit doctor` | Validate installation |
| `adit export <id>` | Export event bundle |
| `adit plan init` | Start SpecFlow planning |
| `adit plan task <desc>` | Create a plan task |

## Platform Support

Currently supports **Claude Code** via hooks (UserPromptSubmit, PostToolUse, Stop).

Architecture uses a platform adapter pattern for future support of Cursor, Copilot, and other AI coding tools.

## License

MIT
