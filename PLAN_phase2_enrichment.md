# ADIT Core — Phase 2: Enrichment Plan

## Current State Assessment

### What exists today:
- **5 packages**: `@adit/core`, `@adit/engine`, `@adit/hooks`, `@adit/cli`, `@adit/plans`
- **CLI commands**: `init`, `list`, `show`, `revert`, `undo`, `label`, `search`, `diff`, `prompt`, `env`, `status`, `doctor`, `export` — all implemented with basic functionality
- **Hooks**: Claude Code hooks via `adit-hook` binary (`prompt-submit`, `tool-use`, `stop`)
- **Environment capture**: Basic implementation in `@adit/engine` (git state, lockfile hash, node/python versions, safe env vars, OS info)
- **Database**: SQLite with 5 tables (sessions, events, env_snapshots, plans, diffs), 5 migrations
- **No TUI**: CLI is purely Commander.js text output
- **Hooks hardcoded for Claude Code only**: no platform adapter abstraction

### Existing plugin structure (at repo root — needs migration to current spec):
- `.claude-plugin/plugin.json` — **Outdated format**: uses legacy `commands` key-value map, non-standard `supported_hooks`/`requires` fields not in current spec
- `hooks/hooks.json` — **Outdated format**: uses `hook_type` instead of `type`, flat `{command, timeout}` structure instead of nested `{hooks: [{type, command}]}` array
- `commands/*.md` — 7 command files (list, show, revert, undo, search, plan, doctor) — uses older `commands/` convention (still supported, but `skills/` is preferred for new work)
- `skills/adit/SKILL.md` — Single skill file with command reference table (should be split into individual skills)

**Key migration needed**: The existing plugin artifacts predate the current Claude Code plugin spec. Phase 2 migrates to the current spec: nested hooks array with `type` field, per-skill `SKILL.md` directories, metadata-only `plugin.json` manifest (component paths are auto-discovered from standard locations, not listed in manifest).

---

## Feature 1: Environment Snapshotting (Enhanced)

### Goal
Evolve the basic env capture into a full-fledged, diff-aware environment snapshotting system that captures environment *changes* over time and can detect environment drift.

### 1.1 — Richer environment data capture
**File**: `packages/engine/src/environment/capture.ts`

- Add Docker/container detection (`/.dockerenv`, cgroup checks)
- Add Rust toolchain version (`rustc --version`, `cargo --version`)
- Add Go version (`go version`)
- Add Java/JDK version (`java --version`)
- Add Ruby version (`ruby --version`)
- Add shell info (`$SHELL`, shell version)
- Add CPU architecture (`process.arch`, `os.cpus()[0].model`)
- Add available memory (`os.totalmem()`, `os.freemem()`)
- Add disk space for project partition (via `statvfs` / `df`)
- Add VS Code / editor extensions list (optional, from `~/.vscode/extensions/`)
- Add npm/pnpm/yarn global version
- Add package manager version (`pnpm --version`, etc.)

**New type** in `packages/core/src/types/environment.ts`:
```ts
export interface EnvSnapshot {
  // ... existing fields ...
  // New fields:
  containerInfo: string | null;     // JSON: {inDocker: bool, image?: string}
  runtimeVersionsJson: string | null; // JSON: {rust?, go?, java?, ruby?, ...}
  shellInfo: string | null;         // JSON: {shell, version}
  systemResourcesJson: string | null; // JSON: {arch, cpuModel, totalMem, freeMem, diskFree}
  packageManagerJson: string | null;  // JSON: {name, version, globalVersion}
}
```

**DB migration** (migration #6): `ALTER TABLE env_snapshots ADD COLUMN ...` for each new field.

### 1.2 — Environment diff detection
**New file**: `packages/engine/src/environment/differ.ts`

- `diffEnvironments(prev: EnvSnapshot, current: EnvSnapshot): EnvDiff` — compares two snapshots
- Detect: branch changed, HEAD changed, lockfile hash changed, dependency drift, runtime version change, new/removed modified files
- Output a structured `EnvDiff` object with categorized changes

**New type** in `packages/core/src/types/environment.ts`:
```ts
export interface EnvDiff {
  changes: EnvChange[];
  severity: 'none' | 'info' | 'warning' | 'breaking';
}
export interface EnvChange {
  field: string;
  category: 'git' | 'dependency' | 'runtime' | 'system';
  oldValue: string | null;
  newValue: string | null;
  severity: 'info' | 'warning' | 'breaking';
}
```

### 1.3 — Automatic periodic snapshots
**File**: `packages/hooks/src/claude/stop.ts` + `packages/hooks/src/claude/prompt-submit.ts`

- Capture env snapshot at session start (prompt-submit, if first event)
- Capture env snapshot at session end (stop hook)
- Compare current snapshot to previous; store diff if changes detected
- New event type: `"env_drift"` when environment changes between snapshots

### 1.4 — CLI `env` command enhancements
**File**: `packages/cli/src/commands/diff.ts` (envCommand)

- `adit env latest` — show the most recent env snapshot for the active session
- `adit env diff <id1> <id2>` — show diff between two env snapshots
- `adit env history [--limit N]` — list all env snapshots for the session
- Colorized output for drift warnings

### 1.5 — Tests
- Unit tests for `diffEnvironments()`
- Unit tests for new capture fields (mock `execFile`)
- Integration test for env snapshot lifecycle

---

## Feature 2: TUI (Terminal User Interface)

### Goal
Build an interactive terminal UI using **Ink** (React for CLI) that provides a rich, navigable view of the ADIT timeline.

### 2.1 — Package setup
**New dependency** in `packages/cli/package.json`:
```json
"ink": "^5.2.0",
"ink-select-input": "^6.0.0",
"ink-text-input": "^6.0.0",
"ink-spinner": "^5.0.0",
"react": "^18.3.0",
"@types/react": "^18.3.0"
```

**New directory**: `packages/cli/src/tui/`

**CLI entry**: `adit tui` or simply `adit` with no subcommand opens the TUI.

### 2.2 — TUI layout & screens

```
┌─────────────────────────────────────────────────────────────┐
│  ADIT — AI Development Intent Tracker         [branch:main] │
│  Session: 01HX... (claude-code)  Events: 42  Checkpoints: 8│
├──────────────────────────┬──────────────────────────────────┤
│  Timeline                │  Detail Panel                    │
│                          │                                  │
│  > 10:42 [A] response    │  Event: 01HXYZ...               │
│    10:41 [T] Write file  │  Type: assistant_response        │
│    10:40 [T] Read file   │  Actor: assistant                │
│    10:39 [U] prompt      │  Branch: main @ abc1234          │
│    10:38 [A] response    │  Checkpoint: def5678             │
│    10:37 [T] Bash cmd    │                                  │
│    ...                   │  [d]iff [p]rompt [e]nv [r]evert │
│                          │                                  │
├──────────────────────────┴──────────────────────────────────┤
│  [q]uit  [/]search  [f]ilter  [l]abel  [?]help             │
└─────────────────────────────────────────────────────────────┘
```

**Screens**:
1. **Timeline view** (default) — scrollable event list + detail panel
2. **Diff viewer** — syntax-highlighted diff for checkpoint events
3. **Search view** — text search with highlighted results
4. **Environment view** — env snapshot details + drift indicators
5. **Status bar** — session info, branch, checkpoint count
6. **Help overlay** — keybinding reference

### 2.3 — TUI components
**Directory**: `packages/cli/src/tui/`

```
tui/
├── App.tsx              — Root component, screen router
├── hooks/
│   └── useTimeline.ts   — Data fetching hook (DB queries)
│   └── useKeyboard.ts   — Keyboard shortcut handler
├── screens/
│   ├── TimelineScreen.tsx  — Main timeline + detail panel
│   ├── DiffScreen.tsx      — Diff viewer
│   ├── SearchScreen.tsx    — Search interface
│   └── EnvScreen.tsx       — Environment snapshot
├── components/
│   ├── EventList.tsx       — Scrollable event list
│   ├── EventDetail.tsx     — Event detail panel
│   ├── StatusBar.tsx       — Bottom status bar
│   ├── FilterBar.tsx       — Actor/type filter chips
│   └── DiffView.tsx        — Colored diff output
└── index.tsx            — TUI entry point (render <App/>)
```

### 2.4 — TUI keybindings
| Key | Action |
|-----|--------|
| `j`/`k` or `↑`/`↓` | Navigate events |
| `Enter` | Expand event detail |
| `d` | Show diff for checkpoint |
| `p` | Show prompt text |
| `e` | Show environment snapshot |
| `r` | Revert to checkpoint (with confirmation) |
| `l` | Add label |
| `/` | Open search |
| `f` | Toggle filter panel |
| `q` / `Ctrl+C` | Quit |
| `?` | Help overlay |

### 2.5 — Auto-refresh
- Watch the SQLite database for new events using polling (every 2s)
- New events appear at the top of the timeline automatically
- Visual indicator when new events arrive

### 2.6 — CLI integration
**File**: `packages/cli/src/index.ts`

- `adit tui` command launches the TUI
- `adit` with no subcommand shows help (current behavior), but can add `adit` → TUI as a future default

### 2.7 — Tests
- Component snapshot tests using ink-testing-library
- Integration tests for data hooks

---

## Feature 3: Full CLI Polish (label, search, export, doctor)

### Goal
Enhance the existing CLI commands to production quality with better output formatting, more options, and proper error handling.

### 3.1 — `adit label` enhancements
**File**: `packages/cli/src/commands/label.ts`

- `adit label <id> <label>` — (existing) add label
- `adit label remove <id> <label>` — remove a label from an event
- `adit label list [--label <name>]` — list all labels, or all events with a specific label
- Labels support: validate label format (alphanumeric + hyphens, max 50 chars)
- Colorized label output

### 3.2 — `adit search` enhancements
**File**: `packages/cli/src/commands/label.ts`

- Full-text search across: prompt text, response text, tool names, tool I/O, labels
- `adit search <query>` — (existing) basic text search
- `adit search --actor <actor>` — filter by actor
- `adit search --type <type>` — filter by event type
- `adit search --from <date> --to <date>` — date range filter
- `adit search --branch <branch>` — filter by git branch
- `adit search --has-checkpoint` — only events with checkpoints
- `adit search --format json` — JSON output for scripting
- Highlight matched text in output

### 3.3 — `adit export` enhancements
**File**: `packages/cli/src/commands/export.ts`

- `adit export <id>` — (existing) export single event bundle
- `adit export session [session-id]` — export entire session as JSONL
- `adit export --from <date> --to <date>` — export by date range
- `adit export --format jsonl` — streaming JSONL format
- `adit export --format markdown` — human-readable markdown report
- `adit export --include-diffs` — include full diffs in export
- `adit export --include-env` — include environment snapshots
- Gzip compression option: `--gzip`
- Export manifests with metadata (export version, ADIT version, project info)

### 3.4 — `adit doctor` enhancements
**File**: `packages/cli/src/commands/doctor.ts`

- (Existing checks): git repo, data dir, database, hooks config, checkpoint refs, Claude settings
- **New checks**:
  - Verify `adit-hook` binary is on PATH and executable
  - Check ADIT version compatibility (schema version vs code version)
  - Check disk space in `.adit/` directory
  - Check SQLite integrity (`PRAGMA integrity_check`)
  - Check for stale sessions (active sessions older than 24h)
  - Detect orphaned diffs (diffs without corresponding events)
  - Verify plugin installation (Phase 2 plugin framework)
  - Check for platform-specific hook configuration (not just Claude)
- `adit doctor --fix` — attempt automatic fixes:
  - Clean up orphaned refs
  - Close stale sessions
  - Remove orphaned diffs
  - Reinstall hooks if missing
- `adit doctor --json` — JSON output for scripting

### 3.5 — Shared CLI improvements
- Add `chalk` or `picocolors` for colored output across all commands
- Add `--json` output option to all commands (for scripting/piping)
- Add `--verbose` / `--quiet` flags
- Consistent error formatting with suggestions
- Add `adit config` command to view/set config values

### 3.6 — Tests
- Unit tests for each enhanced command
- Integration tests with a real SQLite DB (using tmp dirs)
- Snapshot tests for CLI output formatting

---

## Feature 4: Plugin Framework & Claude Code Plugin

### Goal
Build a **platform-agnostic plugin framework** that makes ADIT distributable as a Claude Code Plugin (with manifest + slash commands), while being easily adaptable to other CLI tools (Cursor, Copilot CLI, Aider, etc.).

### 4.1 — Platform Adapter Architecture

**New package**: `@adit/plugin` (or extend `@adit/hooks` into `@adit/adapters`)

The key insight: ADIT already has a **Platform** type (`claude-code | cursor | copilot | other`). We need to formalize this into a proper adapter pattern.

#### 4.1.1 — Platform Adapter Interface
**New file**: `packages/hooks/src/adapters/types.ts`

```ts
/**
 * Platform adapter interface.
 * Each AI CLI tool gets an adapter that translates between
 * the platform's hook/event system and ADIT's internal model.
 */
export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: Platform;

  /** Human-readable platform name */
  readonly displayName: string;

  /** Hook event mappings: platform event name → ADIT handler */
  readonly hookMappings: HookMapping[];

  /** Parse platform-specific stdin input into ADIT's normalized format */
  parseInput(raw: Record<string, unknown>, hookType: string): NormalizedHookInput;

  /** Generate platform-specific hook configuration */
  generateHookConfig(aditBinaryPath: string): PlatformHookConfig;

  /** Validate that the platform is properly configured */
  validateInstallation(projectRoot: string): Promise<ValidationResult>;

  /** Install/register hooks for this platform */
  installHooks(projectRoot: string, aditBinaryPath: string): Promise<void>;

  /** Uninstall/deregister hooks */
  uninstallHooks(projectRoot: string): Promise<void>;
}

export interface HookMapping {
  /** Platform's event name (e.g., "UserPromptSubmit" for Claude) */
  platformEvent: string;
  /** ADIT's internal handler name */
  aditHandler: 'prompt-submit' | 'tool-use' | 'stop' | 'session-start' | 'session-end';
  /** Optional matcher (e.g., "Write|Edit" for PostToolUse) */
  matcher?: string;
}

export interface NormalizedHookInput {
  cwd: string;
  hookType: 'prompt-submit' | 'tool-use' | 'stop' | 'session-start' | 'session-end';
  prompt?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  stopReason?: string;
  rawPlatformData?: Record<string, unknown>;
}

export interface PlatformHookConfig {
  /** Platform-specific config file path */
  configPath: string;
  /** Configuration content to write */
  content: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}
```

#### 4.1.2 — Claude Code Adapter
**New file**: `packages/hooks/src/adapters/claude-code.ts`

Refactor existing `claude/*.ts` handlers into this adapter:
- Maps Claude's `UserPromptSubmit` → `prompt-submit`
- Maps Claude's `PostToolUse` → `tool-use`
- Maps Claude's `Stop` → `stop`
- Maps Claude's `SessionStart` → `session-start`
- Maps Claude's `SessionEnd` → `session-end`
- Generates `.claude/settings.local.json` hook config
- Validates Claude Code installation

#### 4.1.3 — Adapter Registry
**New file**: `packages/hooks/src/adapters/registry.ts`

```ts
export function getAdapter(platform: Platform): PlatformAdapter;
export function listAdapters(): PlatformAdapter[];
export function registerAdapter(adapter: PlatformAdapter): void;
```

Built-in adapters: `claude-code`. Stub adapters for `cursor`, `copilot` (future).

#### 4.1.4 — Unified Hook Dispatcher
**Refactor**: `packages/hooks/src/index.ts`

Instead of hardcoded `switch(command)`, use the adapter:

```ts
const platform = detectPlatform();       // from env vars or CLI arg
const adapter = getAdapter(platform);
const input = adapter.parseInput(stdin, command);
await dispatchHook(input);               // single unified handler
```

### 4.2 — Claude Code Plugin Structure

**Migrate existing repo-root plugin** (`.claude-plugin/`, `hooks/`, `commands/`, `skills/`) to current spec.

The existing structure at the repo root IS the plugin (this repo serves as both the source code AND the Claude Code plugin when loaded via `--plugin-dir`). We keep this structure but migrate it to the current spec. Additionally, a `pnpm build:plugin` script will produce a standalone distributable `dist/plugin/` directory.

**Repo-root plugin layout** (migrated to current spec):
```
(repo root)/
├── .claude-plugin/
│   └── plugin.json              — Metadata-only manifest (current spec)
├── skills/                      — Replaces monolithic skills/adit/SKILL.md
│   ├── timeline/
│   │   └── SKILL.md             — /adit:timeline — Show recent timeline
│   ├── checkpoint/
│   │   └── SKILL.md             — /adit:checkpoint — Create manual checkpoint
│   ├── revert/
│   │   └── SKILL.md             — /adit:revert — Revert to a checkpoint
│   ├── status/
│   │   └── SKILL.md             — /adit:status — Show ADIT status
│   ├── diff/
│   │   └── SKILL.md             — /adit:diff — Show checkpoint diff
│   ├── env/
│   │   └── SKILL.md             — /adit:env — Show environment snapshot
│   ├── search/
│   │   └── SKILL.md             — /adit:search — Search timeline events
│   ├── label/
│   │   └── SKILL.md             — /adit:label — Add/remove labels
│   └── doctor/
│       └── SKILL.md             — /adit:doctor — Run health checks
├── commands/
│   └── setup.md                 — /adit:setup — One-time ADIT initialization
├── agents/
│   └── timeline-analyst.md      — Subagent for deep timeline analysis
├── hooks/
│   └── hooks.json               — Auto-record hooks (migrated to current spec format)
├── scripts/
│   ├── adit-hook.sh             — Shell wrapper for adit-hook binary
│   ├── install.sh               — Installation helper
│   └── validate.sh              — Validation helper
└── settings.json                — Default plugin settings
```

**Distributable plugin** (built via `pnpm build:plugin` → `dist/plugin/`):
Same structure as above, minus source packages. Includes pre-built `adit-hook` binary in `scripts/`.
```

### 4.3 — Plugin Manifest (Migration)
**File**: `.claude-plugin/plugin.json` (repo root — replaces existing outdated manifest)

Current (outdated):
```json
{
  "name": "adit",
  "version": "0.1.0",
  "description": "...",
  "commands": {"list": "./commands/list.md", ...},  // ← non-standard
  "supported_hooks": ["UserPromptSubmit", ...],      // ← non-standard
  "requires": {"node": ">=20.0.0"}                   // ← non-standard
}
```

Migrated (current spec — metadata only, components auto-discovered):
```json
{
  "name": "adit",
  "version": "0.2.0",
  "description": "AI Development Intent Tracker — Transparent Time Machine for AI-assisted coding",
  "author": {
    "name": "ADIT Contributors",
    "url": "https://github.com/vkenliu/adit-core"
  },
  "homepage": "https://github.com/vkenliu/adit-core",
  "repository": "https://github.com/vkenliu/adit-core",
  "license": "MIT",
  "keywords": ["flight-recorder", "timeline", "git", "checkpoint", "ai-development"]
}
```

Per the current spec, `commands/`, `skills/`, `agents/`, and `hooks/hooks.json` at the plugin root are auto-discovered. No need to list them in the manifest.

### 4.4 — Skill Definitions (Slash Commands)

Each skill wraps the corresponding `adit` CLI command, making ADIT functionality available as `/adit:*` slash commands inside Claude Code.

#### Example: `/adit:timeline`
**File**: `plugin/skills/timeline/SKILL.md`

```markdown
---
name: timeline
description: Show the ADIT timeline of recent events including prompts, tool calls, and checkpoints. Use when the user wants to see what happened during the session or review recent AI actions.
---

# ADIT Timeline

Show the recent ADIT timeline. Run the adit CLI to list events:

!`adit list --limit 20 --expand`

Present the timeline in a readable format, highlighting:
- Checkpoint events (these have revertible snapshots)
- The sequence of prompt → tool calls → response
- Any environment drift warnings

If the user asks about a specific event, use `adit show <id>` for details.
```

#### Example: `/adit:revert`
**File**: `plugin/skills/revert/SKILL.md`

```markdown
---
name: revert
description: Revert the working tree to a previous ADIT checkpoint. Use when the user wants to undo AI changes or go back to an earlier state.
disable-model-invocation: true
---

# ADIT Revert

Revert to a specific checkpoint: `adit revert $ARGUMENTS --yes`

If no checkpoint ID is provided, show recent checkpoints first:
!`adit list --checkpoints --limit 10`

IMPORTANT: Always confirm with the user before reverting. Show them what will change.
```

### 4.5 — Plugin Hooks Configuration (Migration)
**File**: `hooks/hooks.json` (repo root — replaces existing outdated format)

Current (outdated — flat structure with `hook_type`):
```json
{"hooks": {"UserPromptSubmit": [{"matcher": "", "hook_type": "command", "command": "npx adit-hook prompt-submit", "timeout": 5000}]}}
```

Migrated (current spec — nested `hooks` array with `type` field, uses `${CLAUDE_PLUGIN_ROOT}`):


```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/adit-hook.sh prompt-submit"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/adit-hook.sh tool-use"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/adit-hook.sh stop"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/adit-hook.sh session-start"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/adit-hook.sh session-end"
          }
        ]
      }
    ]
  }
}
```

### 4.6 — Plugin Installation & Init Flow

**CLI command**: `adit plugin install <platform>`

1. Detect platform (or take as argument)
2. Get the adapter for the platform
3. Run `adapter.installHooks(projectRoot, aditBinaryPath)`
4. For Claude Code: also sets up `adit init` if needed
5. Validate with `adapter.validateInstallation()`

**New CLI commands**:
- `adit plugin install [platform]` — install ADIT for a platform
- `adit plugin uninstall [platform]` — remove ADIT hooks
- `adit plugin list` — show installed platform integrations
- `adit plugin validate [platform]` — validate installation

### 4.7 — Build & Distribution

- `pnpm build:plugin` script to assemble the `plugin/` directory from source
- Copy compiled `adit-hook` binary into `plugin/scripts/`
- Generate `plugin.json` with current version
- Create distributable tarball
- Support Claude Code marketplace structure (future)

### 4.8 — Tests
- Unit tests for PlatformAdapter interface compliance
- Unit tests for Claude Code adapter
- Integration test: install plugin → trigger hooks → verify events recorded
- Validation test: `adit doctor` detects plugin issues

---

## Implementation Order

### Sprint 1: Foundation (Platform Adapter + Plugin Framework)
| # | Task | Package | Estimated Effort |
|---|------|---------|-----------------|
| 1 | Define `PlatformAdapter` interface and types | `@adit/hooks` | S |
| 2 | Implement Claude Code adapter (refactor existing handlers) | `@adit/hooks` | M |
| 3 | Create adapter registry + unified dispatcher | `@adit/hooks` | S |
| 4 | Add `session-start` and `session-end` hook handlers | `@adit/hooks` | S |
| 5 | Migrate plugin manifest + hooks.json to current Claude Code spec | repo root | S |
| 6 | Split monolithic `skills/adit/SKILL.md` into per-command skill directories | repo root | M |
| 7 | Add shell wrapper scripts + agents + settings.json | repo root | S |
| 8 | Add `adit plugin install/uninstall/list/validate` commands | `@adit/cli` | M |
| 9 | Build script to assemble plugin distribution | root | S |
| 10 | Tests for adapter pattern + plugin installation | all | M |

### Sprint 2: Environment Snapshotting
| # | Task | Package | Estimated Effort |
|---|------|---------|-----------------|
| 11 | DB migration #6 for new env snapshot fields | `@adit/core` | S |
| 12 | Expand capture to include richer data | `@adit/engine` | M |
| 13 | Implement `diffEnvironments()` | `@adit/engine` | M |
| 14 | Add env drift detection to hook handlers | `@adit/hooks` | S |
| 15 | Enhance `adit env` command (latest, diff, history) | `@adit/cli` | M |
| 16 | Tests for env capture + diff | `@adit/engine` | M |

### Sprint 3: CLI Polish
| # | Task | Package | Estimated Effort |
|---|------|---------|-----------------|
| 17 | Add color output library (picocolors) | `@adit/cli` | S |
| 18 | Enhance `adit label` (remove, list) | `@adit/cli` | S |
| 19 | Enhance `adit search` (filters, date range, JSON output) | `@adit/cli` | M |
| 20 | Enhance `adit export` (session, date range, markdown, gzip) | `@adit/cli` | M |
| 21 | Enhance `adit doctor` (new checks, --fix, --json) | `@adit/cli` | M |
| 22 | Add `--json` and `--verbose` flags across all commands | `@adit/cli` | S |
| 23 | Add `adit config` command | `@adit/cli` | S |
| 24 | CLI tests | `@adit/cli` | M |

### Sprint 4: TUI
| # | Task | Package | Estimated Effort |
|---|------|---------|-----------------|
| 25 | Add Ink + React dependencies | `@adit/cli` | S |
| 26 | Build TUI app shell (App.tsx, router, status bar) | `@adit/cli` | M |
| 27 | Build Timeline screen + EventList + EventDetail | `@adit/cli` | L |
| 28 | Build Diff viewer screen | `@adit/cli` | M |
| 29 | Build Search screen | `@adit/cli` | M |
| 30 | Build Environment screen | `@adit/cli` | S |
| 31 | Implement keybindings + auto-refresh | `@adit/cli` | M |
| 32 | Add `adit tui` command entry point | `@adit/cli` | S |
| 33 | TUI tests with ink-testing-library | `@adit/cli` | M |

**Size key**: S = Small (< 2 hours), M = Medium (2-4 hours), L = Large (4-8 hours)

---

## Architecture Decisions

### AD-1: Ink for TUI over blessed/ncurses
**Decision**: Use Ink (React for CLI) instead of blessed or raw ncurses.
**Rationale**: Ink uses React's component model (familiar), has TypeScript support, supports testing with ink-testing-library, and composes naturally. The team already uses a modern TS/ESM stack.

### AD-2: Platform Adapter Pattern over Plugin-per-platform packages
**Decision**: Single `@adit/hooks` package with an adapter pattern, not separate `@adit/hooks-claude`, `@adit/hooks-cursor` packages.
**Rationale**: The core hook logic (record event, create checkpoint, capture env) is identical across platforms. Only the input parsing and config generation differ. Adapters keep this DRY.

### AD-3: Claude Plugin uses shell wrappers, not direct Node.js
**Decision**: Plugin hooks call `adit-hook.sh` shell scripts that invoke the `adit-hook` Node.js binary.
**Rationale**: Claude Code plugins expect shell commands. The shell wrapper handles PATH resolution, error swallowing (fail-open), and can pass `${CLAUDE_PLUGIN_ROOT}` for path resolution. This is more robust than assuming `npx` or global installs.

### AD-4: Skills map 1:1 to CLI commands
**Decision**: Each plugin skill wraps one `adit` CLI command.
**Rationale**: Keeps the skill definitions thin (they're prompts, not code), makes the CLI the single source of truth for functionality, and means skills work without the plugin (just run the CLI directly).

### AD-5: `env_drift` as a first-class event type
**Decision**: Add `"env_drift"` to the EventType union.
**Rationale**: Environment changes between snapshots are semantically important events. They explain why a build broke or tests started failing. Making them first-class events means they show up in the timeline alongside code changes.

---

## Files Changed Summary

### New files:
- `packages/hooks/src/adapters/types.ts` — Platform adapter interface
- `packages/hooks/src/adapters/claude-code.ts` — Claude Code adapter
- `packages/hooks/src/adapters/registry.ts` — Adapter registry
- `packages/hooks/src/handlers/unified.ts` — Unified hook dispatcher (platform-agnostic)
- `packages/hooks/src/handlers/session.ts` — Session start/end handlers
- `packages/engine/src/environment/differ.ts` — Environment differ
- `packages/cli/src/tui/*.tsx` — All TUI components (~12 files)
- `packages/cli/src/commands/config.ts` — Config command
- `packages/cli/src/commands/plugin.ts` — Plugin management commands
- `skills/timeline/SKILL.md` — Individual skill (replaces monolithic skills/adit/SKILL.md)
- `skills/checkpoint/SKILL.md`, `skills/revert/SKILL.md`, etc. — 9 new skill directories
- `agents/timeline-analyst.md` — Timeline analysis subagent
- `scripts/adit-hook.sh` — Plugin shell wrapper
- `settings.json` — Plugin default settings

### Modified files:
- `.claude-plugin/plugin.json` — **Migrated** to current spec (metadata-only)
- `hooks/hooks.json` — **Migrated** to current spec (nested hooks array with `type`)
- `commands/*.md` — Kept for backward compat, skills/ preferred for new skills
- `packages/core/src/types/environment.ts` — New env fields + EnvDiff types
- `packages/core/src/types/events.ts` — Add `env_drift` event type
- `packages/core/src/db/migrations.ts` — Migration #6
- `packages/core/src/db/env-snapshots.ts` — New field handling
- `packages/engine/src/environment/capture.ts` — Richer data
- `packages/hooks/src/index.ts` — Unified dispatcher using adapter pattern
- `packages/hooks/src/claude/*.ts` — Refactor to use adapter
- `packages/cli/src/index.ts` — New commands (tui, config, plugin)
- `packages/cli/src/commands/label.ts` — Enhanced label/search
- `packages/cli/src/commands/export.ts` — Enhanced export
- `packages/cli/src/commands/doctor.ts` — Enhanced doctor
- `packages/cli/src/commands/diff.ts` — Enhanced env command
- `packages/cli/package.json` — New dependencies (ink, react, picocolors)
- `package.json` — New build:plugin script

### Removed files:
- `skills/adit/SKILL.md` — Replaced by individual skill directories

### New dependencies:
- `ink@^5.2.0` — React for CLI (TUI)
- `react@^18.3.0` — Required by Ink
- `picocolors@^1.1.0` — Lightweight color output
- `ink-select-input`, `ink-text-input`, `ink-spinner` — Ink components
- `ink-testing-library` — TUI testing (devDep)

---

## Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Ink adds significant bundle size | Medium | Ink is only loaded for `adit tui`, tree-shaking keeps CLI lean |
| Plugin shell wrappers may have PATH issues | High | Include fallback resolution in scripts, `adit doctor` validates |
| SQLite migrations may break existing data | High | Migration system is idempotent, `ALTER TABLE ADD COLUMN` is safe |
| Environment capture may be slow | Medium | All version checks are parallel with 5s timeout each |
| Adapter pattern may be over-engineered for 1 platform | Low | Interface is small (5 methods), and Cursor/Copilot are real targets |
