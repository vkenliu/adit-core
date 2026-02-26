# PLAN: Implementation Approach for Gaps #1, #2, #3, #4, #9

## Evaluation Methodology

For each gap, I analyzed:
- **Current ADIT architecture** — what exists, what's wired, what's dead code
- **Rewindo's approach** — what they do and why
- **Best fit for ADIT** — often different from Rewindo because our architecture differs fundamentally (SQLite vs JSONL, TypeScript vs Python, rich event model vs flat entries)

---

## Gap #1: Untracked File Diff Handling

### Problem

When the stop hook creates a checkpoint, diffs for untracked files are noisy. The flow is:

```
stop.ts → hasUncommittedChanges() → createCheckpoint()
  → createSnapshot() → getChangedFiles() [git status --porcelain]
  → stageChanges() [git add each file into temp index]
  → git write-tree → git commit-tree
  → getCheckpointDiff() [git diff parentSha sha]
```

The issue: `git diff parentSha sha` generates misleading output for untracked files. Since untracked files didn't exist in the parent commit, they show as full-file additions. If the same untracked file was captured in a *previous* checkpoint and then modified, the diff shows the entire old version as deleted and the entire new version as added — instead of showing just the changed lines.

### What Rewindo Does

Three-category detection in `log_stop.py`:
1. **Tracked modifications** — `git diff --stat` (normal git diff)
2. **Previously-captured untracked files** — compares current content against the prior checkpoint's version using Python's `difflib`
3. **Truly new files** — constructs a synthetic "new file" unified diff

Plus three diff post-processing functions:
- `filter_diff_output()` — strips false deletion noise
- `make_new_file_diff()` — builds clean "+++ new file" diff
- `make_modified_untracked_diff()` — uses difflib for incremental diffs

### Best Approach for ADIT

**Don't replicate Rewindo's difflib approach.** ADIT already has the right architecture — we just aren't using it correctly.

**Root cause:** `createSnapshot()` calls `getChangedFiles(cwd)` which uses `git status --porcelain` (always compares to HEAD). But checkpoints chain via parentSha which may be a *different* commit than HEAD. The diff is generated between `parentSha` and the new commit — but the *staging* was done relative to HEAD's tree (`git read-tree HEAD`).

**Fix:** The diff generation in `getCheckpointDiff()` already accepts `parentSha` and `filePath`. The real fix is in how we *generate* and *post-process* diffs:

#### Implementation Plan

**File: `packages/engine/src/snapshot/creator.ts`**

1. **Add `buildCleanDiff()` function** (~40 lines):
   - After creating the snapshot commit, generate diff with `git diff parentSha newSha`
   - For each file section in the diff, check if the file was untracked (`??` status from getChangedFiles)
   - For untracked files that existed in parentSha: the diff is already correct (git handles this)
   - For truly new untracked files: the diff should show as `new file mode 100644` — check if git already does this correctly when comparing two commits (it should, since the file doesn't exist in parentSha's tree)

2. **Add `filterDiffNoise()` function** (~20 lines):
   - Parse unified diff by `diff --git` headers
   - Remove sections where additions === deletions AND the content is identical (false churn from index changes)
   - This handles the edge case where an untracked file was staged into the temp index identically to the parent

3. **Wire parentSha properly** — Currently `createSnapshot()` receives parentSha from `timeline.createCheckpoint()` which queries `getLatestCheckpointEvent()`. This chain is actually **already correct**. The parentSha flows through:
   - `createCheckpoint()` line 146: `lastCheckpoint?.checkpointSha ?? await getHeadSha(cwd)`
   - Passed to `createSnapshot(cwd, parentSha, ...)` line 149
   - Used in `git commit-tree -p parentSha` line 62-63
   - Used in `getCheckpointDiff(cwd, sha, parentSha)` line 153

**Key insight:** After testing, if `git diff parentSha newSha` already produces clean diffs for untracked files (because both commits are proper git commits with trees), the main fix may just be ensuring parentSha is always non-null and accurate. The diff noise issue may primarily exist when parentSha is null (first checkpoint) or when comparing against HEAD instead of the actual parent checkpoint.

**Effort: S-M** (need to test first — the fix may be smaller than expected)

**Files touched:**
- `packages/engine/src/snapshot/creator.ts` — add diff post-processing
- `packages/engine/src/detector/working-tree.ts` — no changes needed

---

## Gap #2: Revert Safety

### Problem

`revertTo()` in `manager.ts` line 186-189 runs `git reset --hard <sha>` with no safety net:

```typescript
async revertTo(eventId: string): Promise<void> {
  const event = getEventById(db, eventId);
  if (!event) throw new Error(`Event not found: ${eventId}`);
  if (!event.checkpointSha) throw new Error(`Event ${eventId} has no checkpoint`);
  await runGitOrThrow(["reset", "--hard", event.checkpointSha], { cwd });
}
```

Issues:
1. No dependency change detection — reverting across a `package.json` change leaves broken `node_modules`
2. No pre-revert safety checkpoint — current unsaved work is lost permanently
3. The CLI `revertCommand()` warns about dirty tree but doesn't actually block or create a backup

### What Rewindo Does

- Backs up timeline JSONL before reset, restores after
- Warns about dependency changes (checks if `package.json` was modified)

### Best Approach for ADIT

**ADIT doesn't need the JSONL backup** — `.adit/` is gitignored and SQLite survives `git reset --hard`. This is a genuine architectural advantage.

What ADIT *does* need:

#### Implementation Plan

**File: `packages/engine/src/timeline/manager.ts` — `revertTo()` method**

1. **Auto-create safety checkpoint before revert** (~15 lines):
   ```
   Before git reset --hard:
   1. Check hasUncommittedChanges(cwd)
   2. If dirty, create a pre-revert checkpoint with label "pre-revert-safety"
   3. Then proceed with git reset --hard
   ```
   This gives users a way back if the revert was a mistake.

2. **Detect dependency file changes** (~20 lines):
   ```
   After revert succeeds:
   1. Get the diff between current HEAD and the reverted-to checkpoint
   2. Check if any of these files changed: package.json, package-lock.json,
      yarn.lock, pnpm-lock.yaml, Pipfile.lock, poetry.lock, go.sum, Cargo.lock
   3. Return a list of changed dependency files
   ```

**File: `packages/cli/src/commands/revert.ts` — `revertCommand()`**

3. **Show dependency warning** (~10 lines):
   ```
   After revert completes:
   If dependency files changed, print:
     "Warning: {files} changed. You may need to run 'npm install' (or equivalent)."
   ```

4. **Show safety checkpoint info** (~5 lines):
   ```
   If a safety checkpoint was created:
     "Created safety checkpoint {sha}. Use 'adit revert {id}' to undo this revert."
   ```

**Effort: S** — straightforward additions to existing methods

**Files touched:**
- `packages/engine/src/timeline/manager.ts` — modify `revertTo()` return type to include warnings
- `packages/cli/src/commands/revert.ts` — display warnings
- `packages/engine/src/detector/working-tree.ts` — no changes (can reuse existing `getChangedFiles`)

---

## Gap #3: Revert Replay System

### Problem

Revert is all-or-nothing. If user wants to undo AI changes from step 5 but keep their manual edits from step 7, they must manually re-apply their work after reverting.

### What Rewindo Does

- `revert <id> --replay user` — reverts to checkpoint, then cherry-picks subsequent `user_edit` commits
- `revert <id> --to END` — partial revert (revert to id, keep changes up to END)
- Handles merge conflicts with instructional messages

### Best Approach for ADIT

**ADIT has a significant advantage here** — our rich event model already distinguishes `user_edit` events from `assistant_response` events, each with their own checkpoint SHA. Rewindo has to parse actor types from flat JSONL; we can query directly.

#### Implementation Plan

**File: `packages/engine/src/timeline/manager.ts` — new `revertWithReplay()` method**

1. **Query user edit checkpoints after target** (~10 lines):
   ```typescript
   async revertWithReplay(
     eventId: string,
     opts: { replay?: "user" | "none"; toEventId?: string }
   ): Promise<RevertResult>
   ```
   - Query events where `eventType = 'user_edit'` AND `sequence > target.sequence`
   - If `toEventId` specified, filter `sequence <= toEvent.sequence`
   - Collect their `checkpointSha` values

2. **Execute revert + cherry-pick sequence** (~30 lines):
   ```
   1. git reset --hard <targetCheckpointSha>
   2. For each user_edit checkpoint SHA (in sequence order):
      a. git cherry-pick <sha> --no-commit
      b. If conflict: record conflict state, return with conflict info
      c. If success: git reset HEAD (unstage to keep as working tree changes)
   3. Return result with list of replayed edits
   ```

3. **Conflict handling** (~15 lines):
   - If cherry-pick fails, detect conflict files via `git diff --name-only --diff-filter=U`
   - Return structured result with conflict file list and instructions
   - Don't auto-resolve — let user handle via `git cherry-pick --continue` or `--abort`

**File: `packages/cli/src/commands/revert.ts`**

4. **Add `--replay` and `--to` CLI options** (~20 lines):
   - `--replay user` → calls `revertWithReplay()` instead of `revertTo()`
   - `--to <eventId>` → limits replay range
   - Display conflict instructions if needed

**File: `packages/engine/src/timeline/manager.ts` — new `RevertResult` type**

5. **Return type** (~10 lines):
   ```typescript
   interface RevertResult {
     revertedTo: string;           // checkpoint SHA
     safetyCheckpoint?: string;    // pre-revert backup SHA
     replayedEdits: string[];      // list of replayed event IDs
     conflicts?: {
       files: string[];
       instructions: string;
     };
     dependencyWarnings?: string[];
   }
   ```

**Key design decision:** Cherry-pick operates on checkpoint commits (which are real git commits stored as refs). This works because ADIT's `createSnapshot()` creates proper git commits with parent chains. The checkpoint commits ARE cherry-pickable.

**Effort: L** — requires careful git plumbing and conflict handling

**Files touched:**
- `packages/engine/src/timeline/manager.ts` — new method + return type
- `packages/cli/src/commands/revert.ts` — new CLI options + output
- No new files needed

---

## Gap #4: Inter-Hook Communication

### Problem

The prompt-submit hook records a `prompt_submit` event with the prompt text. The stop hook records an `assistant_response` event with just the stop reason. To see "what prompt led to what code change," you must join two separate events by session+sequence.

### What Rewindo Does

Writes prompt to `.claude/data/prompt_state.json` in the prompt hook; reads it in the stop hook to include prompt text in the same timeline entry as the diff.

### Best Approach for ADIT

**Two viable approaches — and the better one is NOT what Rewindo does.**

#### Option A: State file (Rewindo's approach)
- prompt-submit writes `.adit/prompt_state.json`
- stop hook reads it and includes `promptText` in the `assistant_response` event
- Pros: self-contained entries
- Cons: file I/O in hooks (latency), needs locking, another moving part

#### Option B: DB query (leverage ADIT's architecture) **RECOMMENDED**
- Stop hook queries the DB for the most recent `prompt_submit` event in the current session
- Copies the `promptText` into the `assistant_response` event
- Pros: no file I/O, no locking, uses existing infrastructure, atomic via SQLite
- Cons: relies on events being in the same session (which they always are)

#### Implementation Plan (Option B)

**File: `packages/hooks/src/claude/stop.ts`**

1. **Query latest prompt before recording response** (~8 lines):
   ```typescript
   // After initHookContext, before recordEvent:
   const recentEvents = await timeline.list({
     sessionId: ctx.session.id,
     eventType: "prompt_submit",
     limit: 1,
   });
   const lastPrompt = recentEvents[0]?.promptText ?? null;
   ```

2. **Include prompt in assistant_response event** (~2 lines):
   ```typescript
   const event = await timeline.recordEvent({
     sessionId: ctx.session.id,
     eventType: "assistant_response",
     actor: "assistant",
     promptText: lastPrompt,  // <-- ADD THIS
     responseText: stopReason ?? "completed",
   });
   ```

That's it. No new files, no state management, no locking. The `assistant_response` event now carries the prompt that triggered it.

**Why this is better than Rewindo's approach:**
- Zero additional I/O — the DB is already open
- Atomic — SQLite transaction guarantees consistency
- No file locking needed
- No cleanup of stale state files
- Works even if prompt-submit hook fails (graceful degradation — promptText is just null)

**Effort: S** — ~10 lines changed in one file

**Files touched:**
- `packages/hooks/src/claude/stop.ts` — add prompt query + pass to recordEvent

---

## Gap #9: Doctor Validates Claude Code Settings

### Problem

`doctorCommand()` checks if `hooks/hooks.json` exists but doesn't verify that Claude Code is actually configured to use ADIT's hooks. A user could have hooks.json in place but Claude Code configured to use a completely different hooks file.

### What Rewindo Does

Validates hooks are registered in Claude Code's `settings.json` (typically at `~/.claude/settings.json` or `.claude/settings.json` in the project).

### Best Approach for ADIT

#### Implementation Plan

**File: `packages/cli/src/commands/doctor.ts`**

1. **Add Claude Code settings check** (~25 lines):
   ```
   Check locations (in order):
   1. {projectRoot}/.claude/settings.json (project-level)
   2. ~/.claude/settings.json (user-level)

   For each found settings file:
   - Parse JSON
   - Look for hooks configuration referencing "adit-hook"
   - Verify all 3 hooks are registered: UserPromptSubmit, PostToolUse, Stop
   - Report which hooks are missing
   ```

2. **Check hook commands are executable** (~10 lines):
   ```
   Verify that `npx adit-hook` resolves:
   - Check if @adit/hooks package is installed (node_modules/@adit/hooks exists)
   - Or check if adit-hook is in PATH
   ```

3. **Report actionable fix** (~5 lines):
   ```
   If hooks not registered in settings.json:
     "Hooks not registered in Claude Code settings. Run 'adit init' to configure."
   If hooks.json exists but settings.json doesn't reference it:
     "hooks.json found but not referenced in Claude Code settings."
   ```

**Effort: S** — straightforward file reads and JSON parsing

**Files touched:**
- `packages/cli/src/commands/doctor.ts` — add new check (check #6)
- No new files needed

---

## Summary: Recommended Implementation Order

| Order | Gap | Effort | Impact | Rationale |
|-------|-----|--------|--------|-----------|
| 1 | **#4 Inter-hook communication** | S (~10 lines) | HIGH | Biggest UX improvement for least code. Makes timeline entries self-contained. |
| 2 | **#2 Revert safety** | S (~50 lines) | CRITICAL | Safety net for destructive operation. Auto-checkpoint + dependency warnings. |
| 3 | **#9 Doctor settings check** | S (~40 lines) | MEDIUM | Prevents "why isn't ADIT recording?" debugging. |
| 4 | **#1 Diff quality** | S-M (~60 lines) | CRITICAL | Needs testing first to determine actual scope. May already be partially handled by git. |
| 5 | **#3 Revert replay** | L (~85 lines) | HIGH | Most complex. Depends on #2 being done first (safety checkpoint). |

**Total estimated new code: ~245 lines across 4 files.**
**No new files needed. No schema changes. No new dependencies.**
