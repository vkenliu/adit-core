# ADIT Core — Comprehensive Code Review

**Date:** 2026-02-27
**Scope:** Full project review — code quality, schema synchronization, CLI accuracy, architecture extensibility

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Issues](#2-critical-issues)
3. [Hook Event Data Schema Synchronization](#3-hook-event-data-schema-synchronization)
4. [Local DB Schema vs Cloud Sync Schema Mismatches](#4-local-db-schema-vs-cloud-sync-schema-mismatches)
5. [CLI Help Text vs Actual Functionality](#5-cli-help-text-vs-actual-functionality)
6. [Code & Logic Quality Issues](#6-code--logic-quality-issues)
7. [Architecture & Multi-Tool Compatibility](#7-architecture--multi-tool-compatibility)
8. [Suggested Optimizations](#8-suggested-optimizations)
9. [Implementation Priority Plan](#9-implementation-priority-plan)

---

## 1. Executive Summary

ADIT Core is a well-architected monorepo with clean separation of concerns, proper dependency layering, and a thoughtful platform adapter pattern. The overall design is solid — git-native checkpoints, fail-open hooks, ULID-based IDs, and vector clocks for future sync. However, the codebase has accumulated several inconsistencies between what Claude Code actually sends in hook events, what ADIT captures, what the local DB stores, and what gets synced to the cloud. There are also significant gaps in multi-platform support and some CLI/init inconsistencies that would trip up new users.

**Overall assessment:** Good foundation, needs consistency hardening across data flow boundaries.

---

## 2. Critical Issues

### 2.1 `adit init` installs stale hooks — PostToolUse with dead handler

**File:** `packages/cli/src/commands/init.ts:95-106`

The `init` command hardcodes 3 hooks: `UserPromptSubmit`, `PostToolUse`, and `Stop`. However:
- The unified dispatcher (`packages/hooks/src/handlers/unified.ts`) has **no handler for PostToolUse / tool-use**
- The Claude Code adapter's `HOOK_MAPPINGS` does **not** include `PostToolUse`
- The legacy `tool-use.ts` handler exists but is **never called** by the unified dispatcher
- The adapter's `generateHookConfig()` installs 8 hooks (prompt-submit, stop, session-start, session-end, task-completed, notification, subagent-start, subagent-stop) — **none of which is PostToolUse**

**Impact:** Users who run `adit init` get PostToolUse registered in `.claude/settings.local.json` pointing to `adit-hook tool-use`. When Claude Code fires this hook, the dispatcher receives command `"tool-use"` → `adapter.parseInput(raw, "tool-use")` maps it to `hookType = "tool-use"` (not in PLATFORM_TO_ADIT) → the switch in `dispatchHook` has no matching case → **the event is silently dropped**.

Meanwhile, `adit init` does NOT install the 5 new hooks (SessionStart, SessionEnd, TaskCompleted, Notification, SubagentStart, SubagentStop) that the adapter supports.

**Fix:** Either:
- (a) Add PostToolUse/tool-use support to the unified dispatcher (re-integrate the legacy tool-use handler), OR
- (b) Remove PostToolUse from `init.ts` if it's intentionally dropped
- AND: Update `init.ts` to install all 8 hooks that the adapter's `generateHookConfig()` produces, or better, call `adapter.installHooks()` directly instead of hardcoding

### 2.2 `adit status` and `adit doctor` check for PostToolUse as "required"

**File:** `packages/cli/src/commands/status.ts:49`
**File:** `packages/cli/src/commands/doctor.ts:164`

Both commands define `requiredHooks = ["UserPromptSubmit", "PostToolUse", "Stop"]` and mark the system unhealthy if PostToolUse is missing. But the adapter only requires UserPromptSubmit + Stop for validation (`packages/hooks/src/adapters/claude-code.ts:121`).

This creates a confusing state: `adit plugin install` installs 8 hooks, `adit doctor` checks for 3 different hooks, and `adit init` installs yet another 3.

**Fix:** Unify required-hook lists. All three locations (init, status, doctor) should derive from the adapter's hook mappings rather than hardcoding.

### 2.3 Stop hook does NOT capture `last_assistant_message`

**File:** `packages/hooks/src/adapters/claude-code.ts:62`

The Claude Code Stop event sends `last_assistant_message` (Claude's final response text), but the adapter parses it into `lastAssistantMessage` which is only used by SubagentStop. The `handleStopUnified()` handler **ignores** it entirely — it stores `stopReason` (which Claude Code calls `stop_reason`, not present in Stop events) as `responseText`.

Per the Claude Code docs, Stop events have:
- `stop_hook_active` (boolean) — **not captured**
- `last_assistant_message` (string) — **parsed but not stored**

Meanwhile, `stop_reason` is NOT a field in Claude Code's Stop event (it exists for the Stop hook's output, not input). The adapter maps `raw.stop_reason` which will always be undefined.

**Fix:** In `handleStopUnified()`, use `input.lastAssistantMessage` as the `responseText` instead of `input.stopReason`. Also capture `stop_hook_active` in the normalized input.

### 2.4 Missing `PreToolUse` hook support

Claude Code has both `PreToolUse` and `PostToolUse` hooks. ADIT doesn't handle either in the unified dispatcher. PreToolUse is particularly valuable for recording tool intent before execution, while PostToolUse captures the result.

**Fix:** Consider adding PreToolUse/PostToolUse as optional hook types. At minimum, PostToolUse should be re-integrated since the legacy `tool-use.ts` handler is well-implemented.

---

## 3. Hook Event Data Schema Synchronization

### 3.1 Fields Claude Code sends but ADIT doesn't capture

| Claude Code Field | Hook Event(s) | ADIT Status |
|---|---|---|
| `permission_mode` | All events | **Not captured** — useful for understanding AI agent operating mode |
| `hook_event_name` | All events | **Not captured** — could validate hook type |
| `model` | SessionStart | **Not captured** — which Claude model was used |
| `source` | SessionStart | **Not captured** — startup/resume/clear/compact |
| `stop_hook_active` | Stop, SubagentStop | **Not captured** — loop prevention signal |
| `last_assistant_message` | Stop | Parsed but **not stored** in Stop handler |
| `reason` | SessionEnd | **Not captured** — why session ended (clear/logout/exit/etc.) |
| `tool_use_id` | PreToolUse, PostToolUse | **Not captured** — unique tool invocation ID |
| `tool_response` | PostToolUse | **Partially** — legacy handler captures `tool_output` but it's the `tool_response` field |
| `agent_transcript_path` | SubagentStop | Captured in `toolInputJson` but not stored as a proper field |

### 3.2 Field name mismatches between Claude Code and adapter

| Claude Code sends | Adapter reads as | Notes |
|---|---|---|
| `tool_response` | `tool_output` | PostToolUse sends `tool_response`, adapter reads `raw.tool_output` |
| `stop_reason` | `stopReason` | Stop event does NOT send `stop_reason`; it sends `last_assistant_message` |
| `message` | `notificationMessage` | Correct mapping |

### 3.3 NormalizedHookInput missing fields for full Claude Code support

The `NormalizedHookInput` type (in `packages/hooks/src/adapters/types.ts`) should add:

```typescript
// Missing fields:
permissionMode?: string;        // All events
hookEventName?: string;         // All events
model?: string;                 // SessionStart
sessionSource?: string;         // SessionStart: startup/resume/clear/compact
sessionEndReason?: string;      // SessionEnd: clear/logout/exit/etc.
stopHookActive?: boolean;       // Stop, SubagentStop
toolUseId?: string;             // PreToolUse, PostToolUse
toolResponse?: Record<string, unknown>; // PostToolUse (distinct from toolOutput)
```

---

## 4. Local DB Schema vs Cloud Sync Schema Mismatches

### 4.1 EnvSnapshot field name divergence

The serializer (`packages/cloud/src/sync/serializer.ts:389-410`) renames several fields when syncing to cloud:

| Local DB Column | Cloud Sync Field | Issue |
|---|---|---|
| `modified_files` | `dependency_files` | **Semantic mismatch** — `modified_files` is "files changed in working tree", `dependency_files` implies "dependency file list". These are different concepts. |
| `dep_lock_hash` | `lockfile_hash` | Rename only — acceptable |
| `dep_lock_path` | `lockfile_path` | Rename only — acceptable |
| `env_vars_json` | `env_vars` | Suffix dropped — acceptable |
| `runtime_versions_json` | `runtime_versions` | Suffix dropped — acceptable |
| `system_resources_json` | `system_resources` | Suffix dropped — acceptable |
| `package_manager_json` | `package_manager` | Suffix dropped — acceptable |

**Critical issue:** The `modified_files` → `dependency_files` rename is a **semantic error**. `modified_files` stores the list of all files changed in the working tree (from `git status`). Renaming it to `dependency_files` on the server will confuse anyone reading cloud data into thinking it's a list of dependency files.

### 4.2 Diffs table field name divergence

| Local DB Column | Cloud Sync Field | Issue |
|---|---|---|
| `file_filter` | `file_path` | **Semantic difference** — `file_filter` is a filter pattern, `file_path` implies a specific file. The local DB stores this as an optional filter string used when generating diffs, not a file path. |

### 4.3 Missing `client_id` in local tables

The cloud sync schema adds `client_id` to every record type (SyncSession, SyncEvent, etc.), but the local DB tables do NOT have a `client_id` column. The serializer fills it from `cloudClientId` parameter.

**Concern:** The local `sessions` table has `client_id` (from config), but the local `events` table does NOT have `client_id` — it's added only during serialization. If a user changes their client ID (e.g., reinstalls), historical events would be synced with the new client ID, losing provenance.

**Fix:** Consider adding `client_id` to the local events table, or documenting that `client_id` is always derived from the session's client_id.

### 4.4 `vclock_json` is NOT NULL in local schema but nullable in sync schema

Local DB: `vclock_json TEXT NOT NULL` (events table, sessions table)
Sync schema: `vclock_json: string | null` (SyncEvent, SyncSession)

This mismatch means the cloud schema is more permissive. If the server sends back records with null vclock_json, local insert would fail.

### 4.5 EnvSnapshot sync doesn't filter by project

In `queryEnvSnapshots()` (`packages/cloud/src/sync/serializer.ts:370-411`), env snapshots are queried by `id > cursor` without filtering by `projectId`. This means env snapshots from ALL projects on this client get synced to whichever cloud project is being synced.

**Fix:** Join on sessions table to filter by project_id, similar to how events are queried.

---

## 5. CLI Help Text vs Actual Functionality

### 5.1 Commands listed in CLAUDE.md but missing from CLI

CLAUDE.md lists these commands: `init, list, show, revert, undo, label, search, diff, prompt, env, doctor, export`

The CLI actually implements: `init, list, show, revert, undo, label, search, diff, prompt, env, status, doctor, config, export, plugin, cloud, transcript, db, tui`

- `status`, `config`, `plugin`, `cloud`, `transcript`, `db`, `tui` are **not documented** in CLAUDE.md
- CLAUDE.md is stale

### 5.2 Missing `search` as standalone — it's defined inside `label.ts`

**File:** `packages/cli/src/commands/label.ts`

The `search` command implementation lives inside `label.ts`, which is confusing for maintainability. It should be in its own file.

### 5.3 Event count accuracy in `adit status`

**File:** `packages/cli/src/commands/status.ts:101`

```typescript
const recentEvents = queryEvents(db, { limit: 1000 });
```

This only counts up to 1000 events. For projects with >1000 events, `status.events.total` will report 1000, which is misleading. The `countEvents()` function exists but isn't used here.

### 5.4 `adit list` default limit inconsistency

CLAUDE.md docs suggest `adit list` shows timeline entries. The default limit is 20 but there's no indication in the output when results are truncated. Users may not realize they need `--limit` for older events.

### 5.5 `adit doctor` hooks config check is too lenient

**File:** `packages/cli/src/commands/doctor.ts:112-131`

Check #6 ("Hooks config") passes as long as ANY hooks object exists in settings.json. It doesn't verify specific hooks are present. Check #8 ("Claude Code settings") does verify specific hooks but checks for the wrong set (PostToolUse instead of SessionStart/SessionEnd/etc.).

---

## 6. Code & Logic Quality Issues

### 6.1 Double DB open in `triggerTranscriptUploadIfEnabled()`

**File:** `packages/hooks/src/handlers/unified.ts:317-346`

The `triggerTranscriptUploadIfEnabled()` function calls `initHookContext(input.cwd)` which opens a NEW database connection. But this is called from `dispatchHook()` AFTER the main handler has already opened (and potentially closed) its own connection. Each hook event now opens the DB twice — once for the main handler and once for transcript upload.

**Fix:** Pass the existing `db` and `session` to the transcript trigger instead of re-initializing the context.

### 6.2 Race condition: DB closed before auto-sync completes

**File:** `packages/hooks/src/handlers/unified.ts:156-166`

In `handleStopUnified()`, cloud auto-sync is triggered with `triggerAutoSync(ctx.db, ...)` but the `finally` block closes `ctx.db` immediately. The auto-sync is fire-and-forget (`.catch(() => {})`) but uses the same db handle. If the sync query runs after `db.close()`, it will throw (silently caught, but data won't sync).

**Fix:** Either await the auto-sync before closing, or pass the db path and let auto-sync open its own connection.

### 6.3 `handlePromptSubmitUnified()` silently drops events when no prompt

**File:** `packages/hooks/src/handlers/unified.ts:62`

```typescript
if (!input.prompt) return;
```

If Claude Code sends a UserPromptSubmit with an empty prompt (which is valid — user might submit a blank prompt), ADIT silently drops the hook including the user_edit detection. User edits before an empty prompt submission won't be recorded.

### 6.4 Sync cursor uses ULID comparison across table types

**File:** `packages/cloud/src/sync/serializer.ts:127-201`

The `afterEventId` cursor is a ULID from the events table, but it's also used to filter sessions (`WHERE id > ?`), env_snapshots (`WHERE id > ?`), and plans (`WHERE id > ?`). Since ULIDs are time-sorted, this works by accident — but if a session is created BEFORE the last synced event, it would be skipped.

**More specifically:** if a session is created at T1, and many events are created until T2, and the sync cursor is set to the last event at T2, then on next sync the session at T1 will be skipped (its ULID < cursor). This is mitigated for sessions by the `OR ended_at > lastSyncedAt` clause, but env_snapshots have NO such fallback.

### 6.5 `readStdin()` 3-second timeout is brittle

**File:** `packages/hooks/src/common/context.ts`

Claude Code pipes JSON to stdin. A 3-second timeout may be too short on heavily loaded machines or when stdin is buffered. Consider increasing to 10 seconds or making it configurable.

### 6.6 Redundant `fs` imports in `init.ts`

**File:** `packages/cli/src/commands/init.ts:37-39, 54-56, 72-74`

The file imports `readFileSync` at the top but also uses dynamic `import("node:fs")` inside the function body three times. These should use the static import.

### 6.7 `listCheckpointRefs` returns `stepId` — naming inconsistency

**File:** `packages/engine/src/git/refs.ts`

The return type uses `stepId` as the property name for the ref identifier, but the rest of the codebase calls these "event IDs" or "checkpoint IDs". This naming inconsistency can confuse developers.

### 6.8 No validation on EventType values from external input

When events are recorded via `timeline.recordEvent()`, the `eventType` is passed as a string. There's no runtime validation that it matches a valid `EventType` value. If a hook passes an invalid type, it gets silently stored in the DB.

### 6.9 `endSession` import inconsistency in unified handler

**File:** `packages/hooks/src/handlers/unified.ts:203`

```typescript
const { endSession } = await import("@adit/core");
```

This uses a dynamic import inside `handleSessionEnd()`, but `@adit/core` is already a static dependency (used in static imports at line 8). The dynamic import is unnecessary overhead.

### 6.10 Config loading doesn't use `settings.json`

**File:** `packages/core/src/config/index.ts`

The project has a `settings.json` file at root with settings like `captureEnv`, `captureToolIO`, `maxDiffLines`, `checkpointOnStop`, `autoLabel`, `redactKeys`. But `loadConfig()` only reads environment variables — it **never reads** `settings.json`. This means the settings file is a dead configuration that does nothing.

### 6.11 `captureToolIO` setting exists but is never checked

**File:** `settings.json:3`

The setting `"captureToolIO": true` exists but no code checks this flag. Tool I/O is always captured when the tool-use handler runs. If a user sets this to `false`, nothing changes.

---

## 7. Architecture & Multi-Tool Compatibility

### 7.1 Platform detection relies on environment variables

**File:** `packages/hooks/src/adapters/registry.ts`

```typescript
detectPlatform():
  CLAUDE_CODE / CLAUDE_PLUGIN_ROOT → "claude-code"
  CURSOR_SESSION_ID / CURSOR → "cursor"
  GITHUB_COPILOT / COPILOT_SESSION → "copilot"
```

**Issues:**
- Cursor, Copilot, and OpenCode env vars are **guessed** — not verified against actual tool behavior
- No adapter implementations exist for cursor/copilot/opencode — detection will fail at `getAdapter()` since only `claude-code` is registered
- OpenCode (Go-based CLI) and Codex (OpenAI's agent) are not even detected

**Fix:**
1. Document which env vars each tool actually sets
2. Add placeholder adapters that throw "not yet supported" with clear instructions
3. Add OpenCode and Codex to the detection matrix

### 7.2 Hook installation is Claude Code-specific in CLI

The `adit init` command hardcodes Claude Code's `.claude/settings.local.json` format. For Cursor, the hook configuration would go in a different location (likely VS Code `settings.json` or Cursor-specific config). For OpenCode, it would be a Go-based config file.

**Fix:** `adit init` should detect the platform and delegate to `adapter.installHooks()`. The init command should be platform-agnostic.

### 7.3 Session type lacks "headless" platform variants

The `Platform` type is `"claude-code" | "cursor" | "copilot" | "other"`. Missing:
- `"opencode"` — Go-based CLI tool
- `"codex"` — OpenAI's Codex CLI
- `"aider"` — Popular Python-based coding assistant
- `"continue"` — VS Code extension

**Fix:** Either use an open string type (`string` with documented constants) or add these platforms.

### 7.4 Hook command format assumes Node.js (`npx adit-hook`)

The shell script `scripts/adit-hook.sh` and generated configs use `npx adit-hook`. This works for Node.js tools (Claude Code) but:
- OpenCode is Go-based — users may not have Node.js/npm installed
- The binary should support being compiled/distributed as a standalone executable

**Fix:** Consider supporting a standalone binary distribution via `pkg` or `esbuild --bundle` for environments without npm.

### 7.5 `rawPlatformData` stored nowhere

The adapter's `parseInput()` preserves the complete original input as `rawPlatformData`, but the unified handler never stores it. This data could be invaluable for debugging and for future analysis of platform-specific fields.

**Fix:** Store `rawPlatformData` in a new column or in an existing JSON column (like `toolInputJson` for non-tool events).

### ~~7.6 No `PreToolUse` hook — missing permission decision recording~~ [DEPRECATED]

~~Claude Code's `PreToolUse` hook allows recording tool permission decisions (allow/deny/ask). ADIT doesn't capture this, losing valuable context about what the AI was permitted to do.~~

**Status:** Deprecated — Tool-use hooks (PreToolUse/PostToolUse) have been removed from ADIT scope.

### 7.7 Adapter interface lacks `getSessionId()` method

Each platform identifies sessions differently. Claude Code uses `session_id`, Cursor might use workspace ID, etc. The adapter should have a method to extract the platform session ID from the raw input and potentially link it to ADIT's internal session.

---

## 8. Suggested Optimizations

### 8.1 Performance

1. **Connection pooling for hooks** — Each hook invocation opens a new SQLite connection. For rapid-fire events (multiple tool calls in sequence), a connection pool or keep-alive mechanism would reduce overhead.

2. **Batch event recording** — The transcript upload trigger opens a second DB connection per hook event. Consolidate to single connection per hook invocation.

3. **Lazy environment capture** — Environment capture runs shell commands (node --version, python --version, etc.) on every Stop event. Cache results with a TTL (e.g., 5 minutes) since system versions rarely change within a session.

4. **Index on events(started_at)** — The `search` command filters by date range but there's no index on `started_at`. Add one for large databases.

### 8.2 Reliability

5. **Atomic init** — `adit init` performs multiple write operations (create dir, init DB, write gitignore, write hooks). If it fails partway, the state is inconsistent. Wrap in a transaction or add rollback.

6. **Lock file for concurrent hooks** — Multiple hooks can fire simultaneously (e.g., prompt-submit followed quickly by tool-use). SQLite WAL mode handles concurrent reads but concurrent writes can still conflict. Consider advisory locking.

7. **Graceful degradation for git operations** — If `git` is not in PATH or the repo is corrupt, many operations will fail. Add early detection in `adit init` and `adit doctor`.

### 8.3 Data Quality

8. **Store platform session ID** — The normalized input captures `platformSessionId` but it's never stored. This would allow correlating ADIT sessions with Claude Code sessions (useful for transcript cross-referencing).

9. **Validate JSON before storage** — Tool input/output JSON is stored as-is. Add validation to ensure it's valid JSON before INSERT to prevent corrupt data.

10. **Capture `model` from SessionStart** — Which AI model was used is critical metadata for understanding code quality and capability differences.

### 8.4 Developer Experience

11. **Derive hook requirements from adapter** — Instead of hardcoding required hooks in init/status/doctor, derive them from the adapter's `hookMappings`.

12. **Add `adit upgrade` command** — When hook mappings change between versions, users need a way to update their hook configuration. Currently they'd need to manually edit `.claude/settings.local.json` or re-run init (which skips if hooks already exist).

13. **Add `--verbose` flag to hooks** — For debugging, hooks should have a verbose mode that logs what they capture (controlled by `ADIT_DEBUG` env var, which exists but is underused).

---

## 9. Implementation Priority Plan

### Phase 1: Critical Fixes (Immediate)

| # | Issue | File(s) | Effort |
|---|---|---|---|
| 1 | Fix `adit init` to install all 8 hooks via adapter (not hardcoded 3) | `packages/cli/src/commands/init.ts` | S |
| 2 | Fix `adit status` and `adit doctor` required hooks list | `packages/cli/src/commands/status.ts`, `doctor.ts` | S |
| 3 | Capture `last_assistant_message` in Stop handler (not `stop_reason`) | `packages/hooks/src/handlers/unified.ts` | S |
| 4 | Re-integrate PostToolUse handler into unified dispatcher | `packages/hooks/src/handlers/unified.ts`, `adapters/claude-code.ts` | M |
| 5 | Fix `modified_files` → `dependency_files` semantic error in sync | `packages/cloud/src/sync/serializer.ts` | S |
| 6 | Fix env_snapshot sync to filter by project_id | `packages/cloud/src/sync/serializer.ts` | S |
| 7 | Fix DB close race condition with auto-sync | `packages/hooks/src/handlers/unified.ts` | M |
| 8 | Fix double DB open in transcript upload trigger | `packages/hooks/src/handlers/unified.ts` | M |

### Phase 2: Data Completeness (Short-term)

| # | Issue | File(s) | Effort |
|---|---|---|---|
| 9 | Add missing Claude Code fields to NormalizedHookInput | `packages/hooks/src/adapters/types.ts` | S |
| 10 | Capture `permission_mode`, `model`, `source`, `stop_hook_active`, `session_end_reason` | `packages/hooks/src/adapters/claude-code.ts`, `unified.ts` | M |
| 11 | Store `rawPlatformData` in events table | `packages/core/src/db/migrations.ts`, `events.ts` | M |
| 12 | Store `platformSessionId` in sessions table | `packages/core/src/db/migrations.ts`, `sessions.ts` | S |
| 13 | Make `loadConfig()` read `settings.json` | `packages/core/src/config/index.ts` | M |
| 14 | Fix dynamic `import("node:fs")` in init.ts | `packages/cli/src/commands/init.ts` | S |
| 15 | Fix event count accuracy in `adit status` | `packages/cli/src/commands/status.ts` | S |
| 16 | Fix `endSession` unnecessary dynamic import | `packages/hooks/src/handlers/unified.ts` | S |

### Phase 3: Architecture Improvements (Medium-term)

| # | Issue | File(s) | Effort |
|---|---|---|---|
| 17 | Add platform stubs for Cursor, Copilot, OpenCode, Codex | `packages/hooks/src/adapters/` | M |
| 18 | Make `adit init` platform-agnostic (delegate to adapter) | `packages/cli/src/commands/init.ts` | M |
| ~~19~~ | ~~Add `adit upgrade` command for hook migration~~ | ~~`packages/cli/src/commands/`~~ | ~~M~~ | **DELETED — Deprecated: `adit init` re-run + `adit plugin install` covers hook migration** |
| ~~20~~ | ~~Add PreToolUse hook support~~ | ~~`packages/hooks/`~~ | ~~L~~ | **DELETED — Deprecated: Tool-use hooks removed from ADIT scope** |
| 21 | Add `client_id` column to local events table | `packages/core/src/db/migrations.ts` | M |
| 22 | Cache environment capture results within session | `packages/engine/src/environment/capture.ts` | M |
| 23 | Add `started_at` index on events table | `packages/core/src/db/migrations.ts` | S |
| 24 | Move search command out of label.ts | `packages/cli/src/commands/` | S |
| 25 | Update CLAUDE.md to list all current commands | `CLAUDE.md` | S |

### Phase 4: Robustness (Long-term)

| # | Issue | File(s) | Effort |
|---|---|---|---|
| 26 | Add connection pooling for hook handlers | `packages/hooks/src/common/context.ts` | L |
| 27 | Add runtime validation for EventType values | `packages/core/src/types/events.ts` | M |
| 28 | Support standalone binary distribution (no npm) | Build config | L |
| 29 | Add advisory locking for concurrent hook writes | `packages/hooks/` | L |
| ~~30~~ | ~~Implement `captureToolIO` setting~~ | ~~`packages/hooks/src/handlers/unified.ts`~~ | ~~S~~ | **DELETED — Deprecated: `captureToolIO` removed along with tool-use hooks** |
| ~~31~~ | ~~Increase stdin timeout (3s → 10s) or make configurable~~ | ~~`packages/hooks/src/common/context.ts`~~ | ~~S~~ | **DELETED — Deprecated: 3s timeout is adequate; Claude Code pipes stdin synchronously** |
| ~~32~~ | ~~Add vclock NOT NULL consistency between local and cloud schemas~~ | ~~`packages/cloud/src/sync/serializer.ts`~~ | ~~S~~ | **DELETED — Deprecated: Cloud schema intentionally more permissive for forward compatibility** |

**Effort Key:** S = Small (< 1 hour), M = Medium (1-4 hours), L = Large (> 4 hours)

---

## Appendix A: Hook Event Coverage Matrix

Shows which Claude Code hook events are handled and what data is captured:

| Hook Event | Adapter Mapped | Unified Handler | Data Captured | Missing Fields |
|---|---|---|---|---|
| UserPromptSubmit | Yes | Yes | prompt | permission_mode |
| PostToolUse | **No** | **No** (legacy only) | - | tool_name, tool_input, tool_response, tool_use_id |
| PreToolUse | **No** | **No** | - | All fields |
| Stop | Yes | Yes | stopReason (wrong field) | last_assistant_message, stop_hook_active |
| SessionStart | Yes | Yes | env snapshot | model, source, agent_type |
| SessionEnd | Yes | Yes | env snapshot | reason |
| TaskCompleted | Yes | Yes | task metadata | - |
| Notification | Yes | Yes | message, title, type | - |
| SubagentStart | Yes | Yes | agent ID/type | - |
| SubagentStop | Yes | Yes | agent metadata | stop_hook_active |

## Appendix B: DB Schema to Cloud Schema Field Mapping

| Table | Local Column | Cloud Field | Match? |
|---|---|---|---|
| sessions | id | id | Exact |
| sessions | project_id | project_id | Exact |
| sessions | client_id | client_id | Exact |
| sessions | session_type | session_type | Exact |
| sessions | platform | platform | Exact |
| sessions | started_at | started_at | Exact |
| sessions | ended_at | ended_at | Exact |
| sessions | status | status | Exact |
| sessions | metadata_json | metadata_json | Exact |
| sessions | vclock_json | vclock_json | **Nullability mismatch** (NOT NULL local, nullable cloud) |
| sessions | deleted_at | deleted_at | Exact |
| events | (all 24 cols) | (all 24 + client_id) | **client_id added in cloud only** |
| events | vclock_json | vclock_json | **Nullability mismatch** |
| env_snapshots | modified_files | dependency_files | **Semantic mismatch** |
| env_snapshots | dep_lock_hash | lockfile_hash | Renamed |
| env_snapshots | dep_lock_path | lockfile_path | Renamed |
| env_snapshots | env_vars_json | env_vars | Suffix dropped |
| env_snapshots | runtime_versions_json | runtime_versions | Suffix dropped |
| env_snapshots | system_resources_json | system_resources | Suffix dropped |
| env_snapshots | package_manager_json | package_manager | Suffix dropped |
| diffs | file_filter | file_path | **Semantic mismatch** |
| plans | (all cols) | (all + client_id) | **client_id added in cloud only** |
