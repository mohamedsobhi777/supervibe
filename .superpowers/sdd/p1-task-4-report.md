# Phase-1 Task 4: Injectable git filesystem — Report

## Status: Complete

## Step 1: Real wiring found

```
worker/agents/git/git.ts:34   export class GitVersionControl {
worker/agents/git/git.ts:43   constructor(sql: SqlExecutor, author?: { name: string; email: string }) {
worker/agents/git/git.ts:44       this.fs = new SqliteFS(sql);
worker/agents/git/git.ts:48       this.fs.init();
worker/agents/git/fs-adapter.ts:48  constructor(sql: SqlExecutor) {
```

Real constructor signature (before): `constructor(sql: SqlExecutor, author?: { name: string; email: string })`.
The second parameter was `author`, not an fs option — the brief's sketched signature
`constructor(sql, options?: { fs? })` doesn't exist yet in the real code, so I reshaped
the second parameter into an options bag (`{ author?, fs? }`) rather than dropping `author`.

Key findings that shaped the implementation:
- `this.fs.init()` runs unconditionally in the constructor and executes real SQL
  (`PRAGMA table_info(git_objects)`) — so `sql: null` only proves the invariant if the
  default `SqliteFS` construction path is skipped entirely, not just deferred.
- `SqliteFS` self-wraps: `public promises!: this;` + `Object.defineProperty(this, 'promises', { value: this, ... })`
  inside `init()`. isomorphic-git's `fs` config just receives `this.fs` directly (not
  wrapped in an external `{ promises: ... }` object) — the class satisfies that contract
  by being its own `.promises`. Preserved this exact pattern: the injected `fs` is passed
  to `gitConfig` the same un-wrapped way (callers of the override supply an object that already
  exposes the needed methods directly, matching how `SqliteFS` exposes them on itself).
- `GitVersionControl.fs` (public field, typed `SqliteFS`) is read externally exactly once:
  `worker/agents/core/codingAgent.ts:726` — `this.git.fs.exportGitObjects()`, a SqliteFS-only
  method with no equivalent in the generic fs-promises surface. This is Cloudflare/D1-specific
  git-protocol export, unrelated to isomorphic-git. It only matters on the default (no-override)
  path, so `fs` stays `SqliteFS`-typed and is simply left unconstructed when an override is used.
  `codingAgent.ts` required zero changes (confirmed via `git diff` — empty).
- Only one real production call site constructs `GitVersionControl`:
  `worker/agents/core/codingAgent.ts:111` — `new GitVersionControl(this.sql.bind(this))`,
  passing no second argument. This made the options-bag reshape safe: nothing relies on
  positional `author`.

## Final `GitFsPromises` definition

In `worker/agents/git/fs-adapter.ts`, derived via `Pick` from `SqliteFS` (no divergent
hand copy):

```ts
export type GitFsPromises = Pick<
    SqliteFS,
    | 'readFile'
    | 'writeFile'
    | 'unlink'
    | 'mkdir'
    | 'readdir'
    | 'stat'
    | 'lstat'
    | 'rmdir'
    | 'symlink'
    | 'readlink'
    | 'chmod'
    | 'rename'
>;
```

Member list = exactly the isomorphic-git fs-promises surface `SqliteFS` implements
(`readFile`/`writeFile`/`unlink`/`mkdir`/`readdir`/`stat`/`rmdir` per the brief, plus
`lstat`, `symlink`, `readlink`, `chmod`, `rename` — all present on `SqliteFS` and used by
isomorphic-git for refs/checkout/rename per its own inline comments). Deliberately excludes
SqliteFS-only members not part of the generic fs contract: `init`, `exists`, `write`,
`exportGitObjects`, `getStorageStats`, `promises`.

## `GitVersionControl` changes (`worker/agents/git/git.ts`)

```ts
export interface GitVersionControlOptions {
    author?: { name: string; email: string };
    fs?: GitFsPromises;
}

export class GitVersionControl {
    public fs!: SqliteFS;                    // only constructed on default path
    private readonly gitFs: GitFsPromises;    // default SqliteFS OR injected override
    private author: { name: string; email: string };

    private get gitConfig() {
        return { fs: this.gitFs, dir: '/' } as const;   // was: { fs: this.fs, ... }
    }

    constructor(sql: SqlExecutor, options?: GitVersionControlOptions) {
        this.author = options?.author || { name: 'Vibesdk', email: 'vibesdk-bot@cloudflare.com' };

        if (options?.fs) {
            this.gitFs = options.fs;          // override wins, SqliteFS never touched
        } else {
            this.fs = new SqliteFS(sql);      // default, unchanged
            this.fs.init();
            this.gitFs = this.fs;
        }
    }
    // ...
}
```

Two internal call sites that read `this.fs.X` directly (not via `gitConfig`) were switched
to `this.gitFs.X` so staging/diffing work correctly under an injected fs too:
- `stage()`: `this.fs.writeFile(...)` → `this.gitFs.writeFile(...)`
- `hasChanges()`: `this.fs.readdir('/')` → `this.gitFs.readdir('/')`

`getStorageStats()` intentionally stays bound to `this.fs` (SqliteFS-only, default-path API).

`worker/agents/git/index.ts` now also exports `GitVersionControlOptions` and `GitFsPromises`
for Task 10's `StandaloneAgent` consumer.

## RED evidence

Test run before implementation (constructor still ignored the second-arg shape, still
unconditionally built `new SqliteFS(sql).init()`):

```
 ❯ test/worker/agents/git/injectableFs.test.ts (3 tests | 2 failed) 24ms
   × GitVersionControl fs injection > accepts an injected fs and never constructs SqliteFS (sql stays untouched) 6ms
     → this.sql is not a function
   × GitVersionControl fs injection > uses the injected fs for git operations instead of the default SqliteFS-backed fs 2ms
     → this.sql is not a function
   ✓ GitVersionControl fs injection > falls back to the default SqliteFS-backed fs when no override is provided 4ms

TypeError: this.sql is not a function
 ❯ SqliteFS.init worker/agents/git/fs-adapter.ts:57:42
 ❯ new GitVersionControl worker/agents/git/git.ts:48:17
 ❯ test/worker/agents/git/injectableFs.test.ts:86:21

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

Test design note: instead of asserting construction succeeds with a bare `expect(git).toBeDefined()`
(brief's sketch), the test suite proves the invariant three ways: (1) `new GitVersionControl(null as never, { fs })`
must not throw — proving `SqliteFS`/`sql` is never touched when overridden; (2) `git.init()` against
the injected fake fs must actually drive calls through it, proving the override is wired into git
operations, not just stored inertly; (3) the default (no-override) path still builds a real `SqliteFS`
and exposes its SqliteFS-only members (`exportGitObjects`, `getStorageStats`), proving the default
path is unchanged. No adjustment to the "sql: null" approach was needed — it worked as prescribed
once construction correctly short-circuited before touching `sql`.

## GREEN evidence

```
$ bun run test -- test/worker/agents/git/injectableFs.test.ts
 ✓ test/worker/agents/git/injectableFs.test.ts (3 tests) 21ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Full suite:

```
$ bun run typecheck
$ tsc -b --incremental --noEmit
(no output — clean)

$ bun run test
 Test Files  22 passed (22)
      Tests  294 passed | 1 skipped (295)
   Duration  9.81s
```

(The 1 skipped test is pre-existing and unrelated to this change.)

## Commit

```
c57ed18 refactor: make GitVersionControl filesystem injectable
 4 files changed, 167 insertions(+), 14 deletions(-)
 create mode 100644 test/worker/agents/git/injectableFs.test.ts
```

Files: `worker/agents/git/fs-adapter.ts`, `worker/agents/git/git.ts`, `worker/agents/git/index.ts`,
`test/worker/agents/git/injectableFs.test.ts`. Pre-commit hook re-ran typecheck + the new test
file automatically and passed. Unrelated pre-existing sandbox changes in the working tree
(`worker/services/sandbox/*`, `test/worker/services/sandbox/*`) were left unstaged.

## Phase-1 Task 4 Review Finding Fix

**Finding:** `GitVersionControl.fs` declared as `public fs!: SqliteFS;` (definite-assignment assertion)
but constructor left `fs` unassigned when `options.fs` override was injected. Type lie: consumers
(`getStorageStats()` at git.ts ~369, `exportGitObjects()` at codingAgent.ts ~726) would crash
with raw `undefined` property access on injected-fs instances.

**Fix (type-honest):**

1. Changed `worker/agents/git/git.ts`: `public fs!: SqliteFS;` → `public fs: SqliteFS | undefined;`
   - Updated doc comment: added "SqliteFS-only features (storage stats, git-object export) are unavailable when an fs override is injected."

2. Added guard in `getStorageStats()`:
   ```ts
   if (!this.fs) {
       throw new Error('getStorageStats requires the SqliteFS backend (not available with an injected filesystem)');
   }
   ```

3. Fixed `worker/agents/core/codingAgent.ts` `exportGitObjects()` (line ~726):
   ```ts
   const sqliteFs = this.git.fs;
   if (!sqliteFs) {
       throw new Error('exportGitObjects requires the SqliteFS backend (not available with an injected filesystem)');
   }
   const gitObjects = sqliteFs.exportGitObjects();
   ```

**Verification:**
```
$ bun run typecheck
$ tsc -b --incremental --noEmit
(clean)

$ bun run test -- test/worker/agents/git/injectableFs.test.ts
 ✓ test/worker/agents/git/injectableFs.test.ts (3 tests) 27ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

**Commit:** `6271b46 fix: type GitVersionControl.fs honestly and guard SqliteFS-only paths`
