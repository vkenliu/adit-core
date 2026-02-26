# ADIT Core — Architecture Plan

> **AI Development Intent Tracker** — The Transparent Time Machine

## 1. Design Philosophy

ADIT Core is a **local-first flight recorder** for AI-assisted development that combines:
- **Rewindo's** git-native checkpoint system (shadow refs, non-polluting)
- **Agent Recorder's** observable execution model (tool calls, hierarchies)
- **SpecFlow's** structured planning methodology (intent → roadmap → tasks)

Three pillars:
1. **Atomic Traceability** — every code change links to the prompt + CoT that produced it
2. **Git-Native, Non-Polluting** — checkpoints stored as `refs/adit/checkpoints/<id>`, never on branch history
3. **Observable Execution** — tool calls, subagent calls, skill invocations all recorded

## 2. Cloud-Ready Data Model

All local data is designed for future cloud sync with conflict resolution:
- Every record carries a **ULID** (time-sortable, globally unique)
- Every mutation carries a **vector clock** (`{clientId: sequence}`) for CRDT-style merge
- Records are **append-only with soft deletes** — no destructive updates
- Sessions carry a **projectId** (hash of git remote + repo path) for multi-client coordination

## 3. Monorepo Structure

```
adit-core/
├── packages/
│   ├── core/           # Types, DB schema, config, sync primitives
│   │   └── src/
│   │       ├── types/          # Event, Session, Checkpoint, Plan types
│   │       ├── db/             # SQLite schema, migrations, CRUD
│   │       ├── config/         # Config loading, defaults, env vars
│   │       ├── sync/           # Vector clocks, ULID, conflict markers
│   │       └── index.ts
│   │
│   ├── engine/         # Git operations, snapshot, detection, timeline
│   │   └── src/
│   │       ├── git/            # Porcelain wrappers, ref management
│   │       ├── snapshot/       # Temp-index checkpoint creation
│   │       ├── detector/       # Working tree change detection
│   │       ├── timeline/       # Timeline append, query, revert
│   │       ├── environment/    # Env snapshot (branch, deps, vars)
│   │       └── index.ts
│   │
│   ├── hooks/          # Hook handlers for AI platforms
│   │   └── src/
│   │       ├── claude/         # Claude Code hook handlers
│   │       ├── common/         # Shared hook logic
│   │       └── index.ts
│   │
│   ├── cli/            # CLI commands + TUI
│   │   └── src/
│   │       ├── commands/       # list, show, revert, label, search, etc.
│   │       ├── tui/            # Ink-based terminal UI
│   │       └── index.ts
│   │
│   └── plans/          # SpecFlow artifact generator
│       └── src/
│           ├── templates/      # Intent, Roadmap, Tasks templates
│           ├── generator/      # CLI wizard for plan creation
│           └── index.ts
│
├── hooks/              # Claude Code hook config (hooks.json)
├── commands/           # Slash command docs for plugin
├── skills/             # Skill definitions for Claude Code
├── .claude-plugin/     # Plugin manifest
├── tests/              # Integration tests
├── package.json        # Root workspace config
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.config.ts
```

## 4. Data Model (SQLite — cloud-sync ready)

### 4.1 Sessions Table
```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,        -- ULID
  project_id    TEXT NOT NULL,           -- hash(remote_url + repo_root)
  client_id     TEXT NOT NULL,           -- unique per machine install
  session_type  TEXT NOT NULL,           -- 'interactive' | 'headless'
  platform      TEXT NOT NULL,           -- 'claude-code' | 'cursor' | 'copilot'
  started_at    TEXT NOT NULL,           -- ISO 8601
  ended_at      TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT,                    -- branch, env snapshot
  vclock_json   TEXT NOT NULL,           -- vector clock
  deleted_at    TEXT                     -- soft delete
);
```

### 4.2 Events Table (unified timeline)
```sql
CREATE TABLE events (
  id              TEXT PRIMARY KEY,      -- ULID
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  parent_event_id TEXT REFERENCES events(id),
  sequence        INTEGER NOT NULL,      -- monotonic within session
  event_type      TEXT NOT NULL,         -- see EventType enum
  actor           TEXT NOT NULL,         -- 'assistant' | 'user' | 'tool' | 'system'

  -- Prompt/CoT capture
  prompt_text     TEXT,                  -- user prompt (when actor='user')
  cot_text        TEXT,                  -- chain of thought (when actor='assistant')
  response_text   TEXT,                  -- assistant response summary

  -- Tool execution
  tool_name       TEXT,
  tool_input_json TEXT,
  tool_output_json TEXT,

  -- Git checkpoint
  checkpoint_sha  TEXT,                  -- git commit SHA for this event
  checkpoint_ref  TEXT,                  -- refs/adit/checkpoints/<id>
  diff_stat_json  TEXT,                  -- {files: [{path, additions, deletions}]}

  -- Environment context
  git_branch      TEXT,
  git_head_sha    TEXT,
  env_snapshot_id TEXT,                  -- FK to env_snapshots if captured

  -- Metadata
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  error_json      TEXT,
  labels_json     TEXT,                  -- ["working-auth", "pre-refactor"]
  plan_task_id    TEXT,                  -- FK to plan_tasks for SpecFlow linking

  -- Sync
  vclock_json     TEXT NOT NULL,
  deleted_at      TEXT
);
```

### 4.3 Environment Snapshots
```sql
CREATE TABLE env_snapshots (
  id              TEXT PRIMARY KEY,      -- ULID
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  git_branch      TEXT NOT NULL,
  git_head_sha    TEXT NOT NULL,
  modified_files  TEXT,                  -- JSON array of paths
  dep_lock_hash   TEXT,                  -- hash of package-lock.json etc.
  dep_lock_path   TEXT,                  -- which lockfile
  env_vars_json   TEXT,                  -- selected safe env vars
  node_version    TEXT,
  python_version  TEXT,
  os_info         TEXT,
  captured_at     TEXT NOT NULL,
  vclock_json     TEXT NOT NULL,
  deleted_at      TEXT
);
```

### 4.4 Plans (SpecFlow)
```sql
CREATE TABLE plans (
  id            TEXT PRIMARY KEY,        -- ULID
  project_id    TEXT NOT NULL,
  plan_type     TEXT NOT NULL,           -- 'intent' | 'roadmap' | 'task'
  parent_plan_id TEXT,                   -- roadmap → intent, task → roadmap
  title         TEXT NOT NULL,
  content_md    TEXT NOT NULL,           -- Markdown content
  status        TEXT NOT NULL DEFAULT 'draft',
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  vclock_json   TEXT NOT NULL,
  deleted_at    TEXT
);
```

### 4.5 Diffs (stored as blobs for large diffs)
```sql
CREATE TABLE diffs (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id),
  diff_text     TEXT NOT NULL,           -- unified diff
  file_filter   TEXT,                    -- specific file if filtered
  created_at    TEXT NOT NULL
);
```

## 5. Event Type Hierarchy

```
EventType =
  | 'prompt_submit'      -- User submits a prompt (actor=user)
  | 'assistant_response'  -- AI responds with code/text (actor=assistant)
  | 'user_edit'           -- Manual edit between prompts (actor=user)
  | 'tool_call'           -- Built-in tool execution (actor=tool)
  | 'subagent_call'       -- Subagent spawned (actor=assistant)
  | 'skill_call'          -- Skill invoked (actor=assistant)
  | 'mcp_call'            -- MCP server tool call (actor=tool)
  | 'checkpoint'          -- Git checkpoint created (actor=system)
  | 'revert'              -- User reverted to checkpoint (actor=user)
  | 'env_snapshot'        -- Environment captured (actor=system)
  | 'plan_update'         -- SpecFlow plan modified (actor=user)
```

## 6. Hook Integration (Claude Code)

### hooks.json
```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "",
      "hook_type": "command",
      "command": "npx adit-hook prompt-submit",
      "timeout": 5000
    }],
    "PostToolUse": [{
      "matcher": "",
      "hook_type": "command",
      "command": "npx adit-hook tool-use",
      "timeout": 5000
    }],
    "Stop": [{
      "matcher": "",
      "hook_type": "command",
      "command": "npx adit-hook stop",
      "timeout": 30000
    }]
  }
}
```

### Hook Flow
1. **UserPromptSubmit** → capture prompt text, detect user edits since last checkpoint, create user_edit event if dirty
2. **PostToolUse** → record tool_call event (name, input, output, duration)
3. **Stop** → create assistant_response event, snapshot working tree, create checkpoint ref, store diff

## 7. CLI Commands

| Command | Description |
|---------|-------------|
| `adit init` | Initialize hooks + .adit/ data directory |
| `adit list [--limit N] [--actor A\|U\|T] [--query TEXT]` | Timeline entries |
| `adit show <id>` | Full event detail with prompt, CoT, diff |
| `adit revert <id>` | Restore working tree to checkpoint |
| `adit undo` | Revert to parent of last checkpoint |
| `adit label <id> <label>` | Tag an event |
| `adit search <query>` | Full-text search across prompts/CoT |
| `adit diff <id> [--file PATH]` | Show diff for checkpoint |
| `adit prompt <id>` | Show prompt text |
| `adit env <id>` | Show environment snapshot |
| `adit doctor` | Validate installation health |
| `adit export <id> [--format json\|jsonl]` | Export event bundle |
| `adit plan init` | Generate SpecFlow Intent + Roadmap |
| `adit plan task <description>` | Create a task linked to roadmap |
| `adit plan status` | Show plan progress |
| `adit tui` | Launch interactive terminal UI |

## 8. Key Architecture Decisions

1. **TypeScript monorepo (pnpm)** — matches Agent Recorder's proven approach, strong typing for data model
2. **SQLite via better-sqlite3** — sync-friendly (can export/import tables), single-file, no server needed
3. **ULID primary keys** — time-sortable + globally unique = natural merge ordering for cloud sync
4. **Vector clocks on every record** — enables conflict detection without central authority
5. **Append-only with soft deletes** — no data loss, full audit trail, clean sync semantics
6. **Temporary GIT_INDEX_FILE** — from Rewindo, never touch user's staging area
7. **Fail-open hook design** — from Agent Recorder, recording errors never block the AI agent
8. **Platform adapter pattern** — hooks package uses adapters so adding Cursor/Copilot later is a new adapter, not a rewrite

## 9. Conflict Resolution Strategy (for future cloud sync)

- **Last-Writer-Wins (LWW)** for simple fields (labels, status)
- **Set Union** for array fields (labels_json — merge both sets)
- **Vector Clock comparison** to detect true conflicts vs. causal ordering
- **Append-only events are conflict-free** — two clients creating events never conflict, they just interleave by ULID order
- **Checkpoints are immutable** — SHA-addressed, no conflicts possible
- **Plans use operational transform** — Markdown content merges via diff3

## 10. Implementation Order

Phase 1 (Current): Foundation
1. Project scaffolding (monorepo, configs)
2. Core package (types, DB, config, ULID/vclock)
3. Engine package (git ops, snapshot, detector, timeline)
4. Hooks package (Claude Code handlers)
5. CLI package (essential commands: init, list, show, revert, undo)

Phase 2: Enrichment
6. Plans package (SpecFlow generator)
7. Environment snapshotting
8. TUI
9. Full CLI (label, search, export, doctor)
10. Plugin manifest + slash commands

Phase 3: Polish
11. Integration tests
12. Docker support
13. Cloud sync preparation (export/import, conflict resolution)
