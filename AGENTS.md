# AGENTS.md — ADIT Core Developer Guide

## Project Overview

ADIT Core is a TypeScript **pnpm monorepo** (six packages) that acts as a flight recorder
for AI-assisted development. See `CLAUDE.md` for architecture details.

Packages: `@adit/core`, `@adit/engine`, `@adit/hooks`, `@adit/cli`, `@adit/cloud`, `@adit/plans`

---

## Build / Lint / Test Commands

```bash
# Install dependencies
pnpm install

# Build all packages (runs tsc in each)
pnpm build

# Build a single package
pnpm --filter @adit/core build

# Type-check without emitting
pnpm typecheck
pnpm --filter @adit/engine typecheck

# Run all tests (Vitest, single-pass)
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run a single test file
pnpm test -- packages/core/src/db/events.test.ts

# Run tests matching a name pattern
pnpm test -- --reporter=verbose -t "inserts and retrieves"

# Run tests for one package only
pnpm --filter @adit/core test

# Lint (ESLint)
pnpm lint

# Format (Prettier)
pnpm format
```

> **Note:** No ESLint or Prettier config files are committed. The `lint` and `format`
> scripts exist in `package.json` but rely on tool defaults until configs are added.

---

## TypeScript Configuration

All packages share `tsconfig.base.json`. Key flags to respect:

| Flag | Value | Implication |
|---|---|---|
| `strict` | `true` | Full strict mode — no implicit any, strict null checks |
| `noUnusedLocals` | `true` | Every declared local must be used |
| `noUnusedParameters` | `true` | Every function parameter must be used |
| `noFallthroughCasesInSwitch` | `true` | All switch cases need explicit break/return |
| `module` / `moduleResolution` | `Node16` | Requires `.js` extensions on all relative imports |
| `isolatedModules` | `true` | No const enums; type imports must use `import type` |
| `target` | `ES2022` | Modern JS — optional chaining, nullish coalescing, top-level await |

---

## Code Style Guidelines

### Imports

- Use **`.js` extensions** on all relative imports — required by `Node16` module resolution:
  ```ts
  import { openDatabase } from "../db/connection.js";
  ```
- Use `import type` for type-only imports:
  ```ts
  import type { AditEvent } from "@adit/core";
  ```
- Group imports: external packages first, then internal `@adit/*`, then relative paths.
- No barrel re-export chains that hide which package a symbol comes from.

### Exports

- **Named exports only** — no default exports anywhere in the codebase.
- Each package exposes its public API through `src/index.ts`.

### Types

- Use `type` for unions and aliases:
  ```ts
  export type Actor = "A" | "U" | "T" | "S";
  ```
- Use `interface` for object shapes:
  ```ts
  export interface AditEvent { id: string; ... }
  ```
- Prefer `null` over `undefined` for optional data fields in database records.
- Use `??` (nullish coalescing) rather than `||` to guard against falsy-but-valid values.
- Avoid `!` non-null assertions except immediately after an explicit null check.
- Avoid `any` — use `unknown` and narrow with guards instead.
- `readonly` on class properties that should not be mutated after construction.

### Naming Conventions

| Construct | Convention | Example |
|---|---|---|
| Files | `kebab-case` | `working-tree.ts`, `auto-sync.test.ts` |
| Types / Interfaces | `PascalCase` | `AditEvent`, `CloudConfig` |
| Functions / variables | `camelCase` | `createSnapshot`, `headSha` |
| Constants | `camelCase` | `defaultBatchSize` (not SCREAMING_SNAKE) |
| Factory functions | `createX(...)` | `createTimelineManager(db, config)` |
| Boolean flags | `isX` / `hasX` | `isExpired`, `hasCheckpoint` |

### Module / File Structure

- One logical concern per file.
- Start every file with a JSDoc block comment explaining the module's purpose.
- Type definitions and interfaces go at the top of the file; helpers at the bottom.
- Factory function pattern for stateful objects (return a typed interface, not a class):
  ```ts
  export function createTimelineManager(db: Database, config: AditConfig): TimelineManager { ... }
  ```

### Error Handling

- Library code (non-CLI) never uses `console.error`. Use `process.stderr.write(...)`.
- **Fail-open** in hooks/recording: catch all errors and continue — never block the AI agent.
- Use typed error classes for the cloud package:
  ```ts
  export class CloudAuthError extends Error {
    readonly name = "CloudAuthError";
    constructor(message: string, readonly cause?: unknown) { super(message); }
  }
  ```
- Best-effort cleanup blocks use an empty `catch {}` (no unused `error` binding):
  ```ts
  try { unlinkSync(path); } catch { /* best-effort */ }
  ```
- Wrap all SQLite / file I/O that can fail in try/catch; return a sensible default or `null`.

### Async / Control Flow

- All public service methods are `async` and return `Promise<T>`.
- Use `await` rather than `.then()` chains.
- Performance-sensitive paths use `withPerf(dataDir, category, operation, fn)` from `@adit/core/perf`.

### Formatting Conventions (inferred from codebase)

- 2-space indentation.
- Double quotes for strings.
- Trailing commas in multi-line arrays/objects.
- Opening brace on the same line (`K&R` style).
- Maximum ~100 characters per line.

---

## Testing Conventions

**Framework:** [Vitest](https://vitest.dev/) with `globals: true` (no explicit imports for `describe`/`it`/`expect` needed, but they are explicitly imported in this codebase).

### Rules

- Always use `it()` inside `describe()` — never top-level `test()`.
- Name tests as `"verb + expected behavior"`:
  - `"inserts and retrieves an event"`
  - `"returns empty array for null input"`
- Test files are co-located with source: `foo.ts` + `foo.test.ts` in the same directory.

### Database Tests

Each DB test gets its own **fresh temp SQLite file**:
```ts
function tempDbPath(): string {
  return join(tmpdir(), `adit-test-${randomBytes(8).toString("hex")}.sqlite`);
}
beforeEach(() => { db = openDatabase(tempDbPath()); });
afterEach(() => { closeDatabase(db); try { unlinkSync(dbPath); } catch { } });
```

### Mocked Module Tests

Use `vi.mock()` before imports (Vitest hoists it automatically):
```ts
vi.mock("../config.js", () => ({ loadConfig: vi.fn() }));
import { myFunction } from "./my-module.js";
const mockLoadConfig = vi.mocked(loadConfig);
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });
```

### Factory Helpers

Build test fixtures with a `makeX(overrides)` helper to avoid repetition:
```ts
function makeEvent(overrides: Partial<AditEvent> = {}): AditEvent {
  return { id: "01J...", type: "checkpoint", ...overrides };
}
```

---

## Key Architecture Constraints

1. **Git-native, non-polluting**: Checkpoint refs go to `refs/adit/checkpoints/<id>`, never on branch history.
2. **Temporary index**: Snapshots use a temp `GIT_INDEX_FILE` — never touch the user's staging area.
3. **ULID primary keys**: All records use `generateId()` from `@adit/core/sync/ulid` (monotonic ULIDs).
4. **Fail-open hooks**: Hook recording errors must be swallowed and must never surface to the AI agent.
5. **Multi-package boundaries**: Keep `@adit/engine` free of CLI concerns; keep `@adit/cli` free of direct SQLite calls (use `@adit/core/db`).
