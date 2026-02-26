# PLAN: Rewindo vs ADIT Core — Gap Analysis

## Summary

A feature-by-feature comparison of [Rewindo](https://github.com/utkarshranaa/rewindo) against ADIT Core, identifying areas where Rewindo's implementation is stronger or where ADIT is missing functionality entirely.

---

## Gap List (Prioritized by Impact)

### 1. Untracked File Diff Handling (CRITICAL)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | Three-category change detection: (1) tracked modifications via `git diff --stat`, (2) previously-captured untracked files detected by difflib comparison against prior checkpoint content, (3) truly new untracked files | Single-pass `git status --porcelain` — no distinction between categories |
| **Diff quality** | `filter_diff_output()` removes false deletion noise from diffs; `make_new_file_diff()` constructs proper unified diffs for new files; `make_modified_untracked_diff()` uses difflib for previously-untracked files | Raw `git diff parentSha sha` — untracked files produce misleading "whole-file deletion + whole-file addition" diffs |
| **Why it matters** | Clean diffs are essential for both human review and LLM context. Noisy diffs waste tokens and confuse AI agents trying to understand what changed |
| **Effort** | **M** — Requires adding diff post-processing and difflib-equivalent logic in snapshot/creator.ts and stop hook |

---

### 2. Revert Safety — Database/State Backup (CRITICAL)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | Backs up timeline file before `git reset --hard`, restores it after reset | No backup — `git reset --hard` could destroy `.adit/` if it were tracked, and the DB state becomes inconsistent with the working tree |
| **DB protection** | Timeline JSONL is backed up and restored atomically | SQLite DB is inside `.adit/` which is gitignored, so it survives reset — but no validation that the post-revert DB state is consistent |
| **Dependency warning** | Detects if `package.json` was modified between checkpoints and warns user to run `npm install` | No dependency change detection on revert |
| **Why it matters** | Users who revert across dependency changes will have a broken dev environment without knowing why |
| **Effort** | **S** — Add package.json diff check in revert command, add DB consistency check |

---

### 3. Revert Replay System (HIGH)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | `revert <id> --replay user` cherry-picks subsequent user edits after reverting; `--to END` allows partial revert (revert to id but keep changes up to END) | No replay capability — revert is all-or-nothing `git reset --hard` |
| **Conflict handling** | Handles merge conflicts during cherry-pick with instructional message directing user through `git cherry-pick --continue` or `--abort` | N/A |
| **Why it matters** | Users frequently want to undo AI changes while preserving their own manual edits. Without replay, reverting forces loss of user work |
| **Effort** | **L** — Requires cherry-pick workflow, conflict detection, and user guidance messaging |

---

### 4. Inter-Hook Communication via State File (HIGH)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | `log_prompt.py` writes prompt to `.claude/data/prompt_state.json`; `log_stop.py` reads it to associate the prompt with the checkpoint | ADIT records prompt in DB via prompt-submit hook, then stop hook records a separate assistant_response event — no direct prompt→checkpoint association in the same event |
| **Prompt capture** | Stop hook reads the prompt state file and includes the prompt text in the timeline entry alongside the diff | Stop hook has no access to the original prompt; it only records `stopReason` as responseText |
| **Why it matters** | Rewindo's timeline entries are self-contained (prompt + diff in one entry). ADIT requires joining prompt_submit and assistant_response events to reconstruct the full picture |
| **Effort** | **S** — Write prompt state to a temp file in prompt-submit hook; read it in stop hook to include in the assistant_response event |

---

### 5. File Locking for Concurrent Access (HIGH)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | Platform-specific file locking (fcntl on Unix, msvcrt on Windows) with timeout; atomic writes via temp file + rename | Relies on SQLite's built-in locking (WAL mode) |
| **Coverage** | Protects both timeline JSONL and state files | SQLite handles DB locking, but no protection for file-based operations (hook I/O, state files) |
| **Why it matters** | ADIT's SQLite WAL mode actually handles concurrent DB writes well — this is arguably *better* than Rewindo's JSONL approach. However, if ADIT ever adds file-based state (like prompt state files), it would need locking |
| **Effort** | **S** — Only needed if file-based state is added; SQLite's locking is sufficient for current design |

---

### 6. CLI Output Token Efficiency (MEDIUM)

| | Rewindo | ADIT |
|---|---------|------|
| **get-prompt** | `--max-chars N --offset N` for paginated prompt retrieval | `adit prompt <id>` dumps full prompt text, no pagination |
| **get-diff** | `--max-lines N --offset-lines N --file PATH` for bounded diff retrieval | `adit diff <id> --max-lines N` — has max-lines but `--offset-lines` exists in DB layer (`getDiffText`) but is NOT exposed in CLI; `--file` option defined but not passed through to the query |
| **list** | `--expand-chars N` to control summary width | `--expand` toggles between 60 and 200 chars — no fine-grained control |
| **Why it matters** | When an LLM agent reads timeline output, every unnecessary token costs money and context window space. Pagination prevents dumping 10K-line diffs into the context |
| **Effort** | **S** — Wire existing DB pagination params to CLI flags; add `--offset` to prompt command |

---

### 7. Init Command Robustness (MEDIUM)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | `--global` (user-level) vs `--local` (project-level) storage; `--interactive` guided setup; `--dry-run` preview mode; automatically modifies Claude Code's `settings.json` to install hooks | Single mode only — creates `.adit/` and `hooks/hooks.json` in project root |
| **Hook installation** | Directly modifies Claude Code's settings to register hooks | Creates a standalone `hooks.json` but doesn't integrate with Claude Code's settings.json |
| **Why it matters** | Users must manually configure Claude Code to use ADIT's hooks. Rewindo's init handles this automatically. The `--dry-run` option prevents surprises |
| **Effort** | **M** — Add settings.json detection and modification; add --global/--dry-run flags |

---

### 8. Status Command (MEDIUM)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | `rewindo status` shows current hook configuration state | No status command |
| **Why it matters** | Quick way for users to verify ADIT is active and correctly configured without running full `doctor` |
| **Effort** | **S** — Simple command that reads config and hook state |

---

### 9. Doctor — Timeline Integrity Validation (MEDIUM)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | Validates JSONL format line-by-line; detects orphaned refs; checks hook configuration in Claude Code settings | Checks git repo, data dir, DB accessibility, hooks.json existence, orphaned refs |
| **Line-level validation** | Parses each JSONL line and reports corruption | No equivalent (SQLite handles data integrity via schema constraints) |
| **Hook config check** | Validates hooks are registered in Claude Code settings.json | Only checks if hooks.json file exists, not if Claude Code is configured to use it |
| **Why it matters** | ADIT's SQLite approach is actually more robust than JSONL for data integrity. But the doctor should verify Claude Code settings.json integration |
| **Effort** | **S** — Add Claude Code settings.json validation to doctor |

---

### 10. Capture-Prompt CLI Command (LOW)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | `rewindo capture-prompt --session ID --prompt TEXT --prompt-file PATH` — manual prompt capture for non-hook scenarios | No manual capture command — prompts only recorded via hooks |
| **Why it matters** | Enables integration testing and manual timeline construction without running through Claude Code |
| **Effort** | **S** — Simple wrapper around existing recordEvent |

---

### 11. Export Format (LOW)

| | Rewindo | ADIT |
|---|---------|------|
| **What** | Exports as directory bundle: `prompt.txt`, `diff.patch`, `meta.json` — files usable directly with `git apply` | Exports as single JSON blob containing all data |
| **Why it matters** | Rewindo's format is more practical for sharing patches. ADIT's JSON format is better for programmatic consumption. Different trade-offs |
| **Effort** | **S** — Add `--format patch` option to export command |

---

## Areas Where ADIT is STRONGER Than Rewindo

| Feature | ADIT | Rewindo |
|---------|------|---------|
| **Data storage** | SQLite with WAL mode, proper schema, migrations, indexes, FK constraints | Flat JSONL files — no schema validation, manual parsing, corruption risk |
| **Sync infrastructure** | ULID IDs + vector clocks designed for multi-client cloud sync | Sequential integer IDs — no sync capability |
| **Event granularity** | Tracks 11 event types: prompt_submit, assistant_response, user_edit, tool_call, subagent_call, skill_call, mcp_call, checkpoint, revert, env_snapshot, plan_update | Only 2 actor types (A/U) with single entry type |
| **Tool call tracking** | PostToolUse hook captures every tool call with input/output and redaction | No tool call tracking — only prompt and stop events |
| **Environment snapshots** | Full env capture: node/python versions, OS, dependency hashes, safe env vars | No environment capture |
| **Plan artifacts** | SpecFlow-inspired plan system (Intent → Roadmap → Tasks) | No plan tracking |
| **Session management** | Full session lifecycle with start/end, status, metadata | Session ID passed through but no session management |
| **Multi-actor model** | 4 actors: Assistant, User, Tool, System | 2 actors: Assistant, User |
| **Chain of thought** | Stores `cotText` for reasoning capture | No CoT storage |
| **Soft deletes** | All records support `deleted_at` for recoverable deletion | No soft delete |
| **Query capabilities** | Full-text search on prompt/cot/response/toolName with SQL indexes | Basic text search on JSONL |
| **Type safety** | Full TypeScript with exported types | Python with basic type hints |

---

## Prioritized Implementation Roadmap

### Phase 1 — Quick Wins (S effort)
1. Wire `--offset-lines` and `--file` through to `adit diff` CLI (already in DB layer)
2. Add `--max-chars` and `--offset` to `adit prompt` CLI
3. Add dependency change warning to revert command
4. Add Claude Code settings.json check to doctor
5. Add `status` command

### Phase 2 — Core Quality (M effort)
6. Implement 3-category change detection in stop hook
7. Add diff post-processing (filter noise, construct proper untracked file diffs)
8. Add prompt state file for inter-hook communication
9. Improve init to auto-register hooks in Claude Code settings.json

### Phase 3 — Advanced Features (L effort)
10. Implement `--replay user` and `--to END` options for revert command
11. Add cherry-pick conflict handling with user guidance
12. Add `--format patch` to export command
