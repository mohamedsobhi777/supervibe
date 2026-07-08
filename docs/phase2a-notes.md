# Phase 2a Notes — Data + Auth Foundation

**Parent design:** `docs/superpowers/specs/2026-07-07-vibesdk-anywhere-replatform-design.md`
**Scope brief:** `docs/superpowers/specs/2026-07-08-phase2a-scope-brief.md`
**Plan:** `docs/superpowers/plans/2026-07-08-phase2a-data-auth.md` (10 tasks, commits `8df2cd1..e4956f0`)
**Precedes:** 2b (Vercel/Hono API routes, agent bridge, secrets REST endpoints), 2c (frontend).

Phase 2a replaces the D1 + hand-rolled-auth data layer with Postgres (Supabase) +
Supabase Auth, while keeping the Phase-1 standalone agent runtime
(`agent-runtime/`, `supabase/migrations/20260707000001_agent_runtime.sql`)
untouched and coexisting. Greenfield/big-bang per the locked decisions in the
scope brief: no production data, no dual-run, no feature flags.

## What Phase 2a delivered

### Postgres connection + standalone no-op seam
- `worker/database/pgConnection.ts`: `getPostgresClient(env)` lazily
  constructs one cached `postgres-js` client per process (`prepare: false`
  for Supabase's transaction pooler, `ssl: 'require'`, `max: 5`).
  `buildDrizzle(env)` wires it into Drizzle, or — when
  `isStandaloneRuntime(env)` (`worker/utils/runtimeMode.ts`) is true — returns
  a no-op stub instead of ever opening a network connection.
- `worker/database/noopPg.ts`: `createNoopPostgres()` implements only the
  call surface `drizzle-orm/postgres-js` actually touches (`unsafe()`,
  `begin()`, `.options.{parsers,serializers}`, `end()`), reads resolve to
  `[]`, `begin()` runs its callback against the same no-op client. This is
  the direct successor to Phase 1's `noopD1.ts` (now deleted — see
  Retired/deleted below) for the same architectural reason: the standalone
  agent runtime must never touch a real database.
- D1's read-replica session API (`getReadDb('fast'|'fresh')`,
  `ENABLE_READ_REPLICAS`) has no Postgres equivalent and was removed at the
  call-site level; `DatabaseService.getReadDb()` is kept only as a
  source-compatibility shim — both strategies now resolve to the single
  pooled connection (`worker/database/database.ts`).

### Lean 7-table Postgres schema
`worker/database/schema.ts` (drizzle-orm/pg-core): `users`, `apps`,
`userModelConfigs`, `userModelProviders`, `userSecrets`, `rateLimitBuckets`,
`systemSettings`. Column-for-column ported from the D1 schema with the
SQLite→Postgres transforms the scope brief specified: integer-ms timestamps
→ `timestamptz`, int-boolean → `boolean`, text-mode-json → `jsonb`,
`bytea` for secret ciphertext/nonces. `users.email` carries `.unique()`
(added back — see Retired/deleted). `userModelProviders.secretId` renamed to
`apiKeyEncrypted` (intentional, matches the column's actual purpose).

### Core migration + RLS, coexisting with Phase 1
`supabase/migrations/20260708000001_core.sql`: creates the 7 tables above,
enables RLS on all of them, adds `auth.uid()`-scoped policies on the five
user-owned tables (`users`, `apps`, `userModelConfigs`, `userModelProviders`,
`userSecrets` — `apps` additionally gets a permissive `visibility = 'public'`
read policy), leaves `rateLimitBuckets`/`systemSettings` with zero policies
(RLS-enabled lockout for `anon`/`authenticated`, `service_role` bypasses
RLS), and adds a `security definer` `handle_new_user()` trigger that
auto-provisions a `public.users` row on every `auth.users` insert. This
migration is purely additive — it does not `ALTER` or `DROP` anything the
Phase-1 migration created. See **Coexistence with Phase 1** below for the
live verification performed as part of this task.

### Supabase Auth adapter
`worker/services/auth/supabaseAuth.ts`: `getUserFromToken()` /
`requireUser()` / `AuthUser`, with an injectable Supabase client factory for
testing. Bypass-proof against `error`-and-`user`-both-present responses
(short-circuit on `error`) and against `getUser()` rejecting outright (wrapped
in try/catch). `worker/middleware/auth/auth.ts`'s one entry point
(`authMiddleware` → `enforceAuthRequirement`) now calls
`supabaseAuth.requireUser()` instead of the deleted session-cookie stack;
`routeAuth.ts`/`ticketAuth.ts` are untouched.

### Ported services (Postgres)
- `worker/database/services/BaseService.ts` / `AppService.ts` — 0 D1-isms
  remain. Social/analytics methods (favorites, stars) that depend on
  dropped tables throw `DeferredInPhase2aError` (see Carry-forwards); other
  portable social-stat reads safe-default to `0`/`false`; `recordAppView` is
  a no-op (still called unconditionally by callers, harmlessly).
- `worker/database/services/ModelConfigService.ts` /
  `ModelProvidersService.ts` — ported; `modelConfigDefaults.ts` holds the
  standalone-runtime defaults branch used by `base.ts:566-577` (unchanged,
  regression-pinned — this is *not* inside the service itself).
- `worker/database/services/UserService.ts` — non-session methods ported
  (`createUser`, `findUser`, `updateUserActivity`, `isUsernameAvailable`,
  `updateUserProfileWithValidation` with `bio`/`theme` deferred,
  `getUserStatisticsBasic`); session-coupled methods deleted along with the
  session table.

### Postgres secrets store
`worker/services/secrets/secretsStore.ts` — the app-layer XChaCha20-Poly1305
crypto (client-derived keys, server never sees plaintext) is completely
unchanged; only the storage backend moved from a Durable Object to
`user_secrets` Postgres rows (`bytea` columns). User-scoping is
`and(eq(id), eq(userId))`, verified by a mutation test (stripping the
`userId` predicate makes the cross-user isolation test fail). The old
`UserSecretsStore` Durable Object (`worker/services/secrets/UserSecretsStore.ts`)
is left in place until 2b's REST layer replaces its callers.

### Postgres rate-limit store
`worker/services/rate-limit/pgRateLimitStore.ts` reproduces the
`DORateLimitStore` sliding-window algorithm over `rate_limit_buckets`
(atomic `INSERT ... ON CONFLICT DO UPDATE` increment, windowed sum for
main/burst/daily counts). One correct, documented deviation: the DO's
`bucketStart > windowStart` undercounts at window edges, so the Postgres
version uses floor-aligned `>=` instead (mutation-tested). Not yet wired
into `RateLimitService`/config or any REST endpoint — that is 2b's job.

### Retired hand-rolled auth stack, green typecheck
`SessionService`, `AuthService`, `ApiKeyService`, `AnalyticsService`,
`CloudflareAccountService` and their controllers/routes/schemas were
deleted wholesale (see **Retired/deleted** below) once Supabase Auth
subsumed their responsibilities. Root typecheck went from 251 errors to 0
in this one commit (`e4956f0`), committed clean through the pre-commit
hook (no `--no-verify`).

## Retired / deleted

### Files deleted (commit `e4956f0`, 17 files)
```
tsconfig.tsbuildinfo                                    (stray build artifact)
worker/api/controllers/auth/authSchemas.ts
worker/api/controllers/auth/controller.ts
worker/api/controllers/cloudflareAccount/controller.ts
worker/api/controllers/cloudflareConnect/controller.ts
worker/api/controllers/stats/controller.ts
worker/api/controllers/stats/types.ts
worker/api/routes/authRoutes.ts
worker/api/routes/cloudflareAccountRoutes.ts
worker/api/routes/cloudflareConnectRoutes.ts
worker/api/routes/statsRoutes.ts
worker/database/noopD1.ts                               (superseded by noopPg.ts)
worker/database/services/AnalyticsService.ts
worker/database/services/ApiKeyService.ts
worker/database/services/AuthService.ts
worker/database/services/SessionService.ts
worker/services/cloudflare/CloudflareAccountService.ts
```
Route registrations for `auth`, `cloudflareConnect`, `cloudflareAccount`, and
`stats` were removed from `worker/api/routes/index.ts`. The
`aigateway-proxy` controller was kept (still live-wired into
`worker/index.ts`) and had its D1-vs-Postgres query mismatch fixed in the
same commit, not deleted.

### Tables dropped
Subsumed natively by Supabase Auth (no longer exist anywhere): `sessions`,
`oauthStates`, `authAttempts`, `passwordResetTokens`,
`emailVerificationTokens`, `verificationOtps`.

Deferred — out of scope for 2a, not ported, no schema/service exists for
them post-2a (see scope brief for re-evaluation criteria): `apiKeys`,
`favorites`, `stars`, `appLikes`, `commentLikes`, `appComments`, `appViews`,
`auditLogs`, `cloudflareAccounts`, `aiGateways`. `cloudflareAccounts`/
`aiGateways` (Cloudflare AI Gateway BYOK) are explicitly flagged for
re-evaluation under the direct-SDK model rather than straightforward
porting.

`user_secrets` was already dropped pre-2a (D1 migration 0003) and is
recreated fresh in Postgres by this phase. `rate_limit_buckets` is new — it
replaces a Durable Object (`DORateLimitStore`), not a former D1 table.

## Coexistence with Phase 1

Verified three ways as part of this task:

1. **Static.** `supabase/migrations/20260708000001_core.sql` was read in
   full: zero `ALTER`/`DROP` statements touch `agent_sessions`,
   `agent_state`, `agent_messages`, `agent_conversations`, or their RLS
   policies. The only occurrences of the string `agent_` in the file are the
   header comment and the unrelated `agent_action_name` column on
   `user_model_configs`.
2. **Live apply.** Both migration files were applied in sequence
   (`20260707000001_agent_runtime.sql` then `20260708000001_core.sql`)
   against a scratch database on a local Postgres 16 instance (Homebrew,
   no Docker — same non-Docker approach Task 3 used), behind a minimal
   throwaway stand-in for the slice of Supabase's platform `auth`/`realtime`
   schemas the migrations reference (`auth.users`, `auth.uid()`/`auth.jwt()`
   using the real GUC-reading implementations, `realtime.messages`/
   `realtime.topic()`). Both files applied with zero errors
   (`psql -v ON_ERROR_STOP=1`); the resulting database has all 11 tables (4
   `agent_*` + 7 core) and exactly the 12 policies both files declare, with
   the `agent_*` tables' column counts unchanged (8/3/5/4, matching the
   Phase-1 migration exactly — no leakage from the core migration). The
   scratch database, the throwaway `authenticated` role, and the stub SQL
   were dropped/deleted immediately after.
3. **Live RLS cross-scope check.** On that same scratch database: a
   session-scoped JWT (`request.jwt.claims = '{"session_id":"sess-abc"}'`,
   no `sub`) reads its own `agent_sessions` row (1 row) and sees zero rows
   of `public.users` (RLS `id = auth.uid()` evaluates `auth.uid()` to `NULL`
   for a claim set with no `sub`). A user-scoped JWT
   (`{"sub":"<uuid>"}`, no `session_id`) reads its own `public.apps` row (1
   row) and sees zero rows of `agent_sessions` (RLS `session_id =
   auth.jwt()->>'session_id'` evaluates to `NULL` for a claim set with no
   `session_id`). Both RLS models are independently correct and
   non-leaking when both migrations are live in the same database. The
   `handle_new_user()` trigger was also exercised live in this run (an
   `auth.users` insert auto-provisioned the matching `public.users` row).

This exceeds parse-review but does **not** replace the Docker-gated
`bunx supabase db reset` verification — see Outstanding below for what
specifically remains unverified (the real Supabase platform's `auth`/
`realtime` implementations behind GoTrue/PostgREST/Realtime, as opposed to
this task's and Task 3's hand-rolled stand-ins for them).

## Standalone-runtime coexistence guarantee held

The Phase-1 whole-branch-review fix (C1/C2: `BaseService`/`DatabaseService`
constructors must never touch a real DB binding on the standalone runtime,
or the agent wedges/`get_model_configs` never resolves) was re-verified
after the entire D1→Postgres swap. `agent-runtime/test/standaloneRuntimeD1Seam.test.ts`
(part of the `bun test agent-runtime` gate, still 69 pass / 3 skip) asserts,
against the *current* Postgres-backed `AppService`/`ModelConfigService`
stack:
- `new AppService(env)` does not throw under `isStandaloneRuntime(env)`,
  and `updateApp()` resolves `true` against the no-op Postgres stub instead
  of throwing.
- `get_model_configs` still yields a `model_configs_info` broadcast (never
  an `error`) with populated `defaultConfigs`, with no D1/Postgres binding
  and no `userId`.

This is the Phase-1 coexistence guarantee restated and proven against the
Phase-2a code, not just the Phase-1 code: the no-op seam moved from
`noopD1.ts` to `noopPg.ts` and the guarantee held throughout.

## Gate results (this task)

| Gate | Result |
|---|---|
| `bun run typecheck` (`tsc -b`, cold cache) | 0 errors |
| `bun run typecheck:agent-runtime` | 0 agent-runtime-owned errors |
| `bun test agent-runtime` | 69 pass / 3 skip / 0 fail |
| `bun run test` (root vitest) | 391 pass / 3 skip (30 files pass, 1 file skipped) |
| `bun run lint` | 0 errors / 0 warnings |
| `git status` | only the 4 pre-existing dirty sandbox files (`worker/services/sandbox/sandboxSdkClient.ts`, `types.ts`, `bulkFileScript.ts`, its test) — untouched by Phase 2a |

The 3 agent-runtime skips are the two Docker-gated `describe.skip` blocks:
`agent-runtime/test/schema.integration.test.ts` (2 tests) and
`agent-runtime/test/e2e.integration.test.ts` (1 test), both gated on
`process.env.SUPABASE_LOCAL === '1'`. The 3 root-vitest skips are
`test/worker/database/coreMigration.test.ts` (2 tests, same
`SUPABASE_LOCAL` gate) plus one pre-existing, unrelated skip
(`worker/agents/output-formats/diff-formats/udiff.test.ts:114`, predates
Phase 2a).

## Outstanding live verifications (deferred — need Docker/Supabase-capable env)

1. **Full Supabase-stack migration apply + RLS**, against the real
   `auth`/`realtime` platform implementations (GoTrue, PostgREST,
   Realtime server) rather than this task's/Task 3's hand-rolled SQL
   stand-ins for them:
   ```bash
   bunx supabase start && bunx supabase db reset && SUPABASE_LOCAL=1 bun run test
   ```
   This also runs the gated `test/worker/database/coreMigration.test.ts`
   integration test.
2. **Secrets `bytea` wire round-trip.** Task 7 validated ciphertext
   round-tripping at the JS/Drizzle level only; the real Postgres wire
   protocol's `bytea` encode/decode through `postgres-js` against a live
   server has not been exercised.
   ```bash
   SUPABASE_LOCAL=1 bun run test
   ```
3. **Phase-1 Realtime/e2e** (carried over from Phase 1, restated in
   `docs/agent-runtime.md`): `agent-runtime/test/schema.integration.test.ts`,
   `agent-runtime/test/e2e.integration.test.ts`, and
   `scripts/agent-runtime/dev-session.ts`.
   ```bash
   bunx supabase start && bunx supabase db reset && SUPABASE_LOCAL=1 bun test agent-runtime
   bun scripts/agent-runtime/dev-session.ts --query "build a todo app"
   ```

## 2b carry-forwards

1. **`GET /providers` leaks ciphertext.** The endpoint (once 2b rebuilds the
   `modelProviders` controller) returns the raw `ModelProvider` entity,
   including `apiKeyEncrypted` ciphertext, in JSON. Redact it from read
   responses.
2. **Rate-limit read-then-write concurrency overshoot.** The write itself
   is an atomic `UPSERT`, but two concurrent requests against the same key
   can both read the pre-increment count before either writes, slightly
   overshooting the configured limit (`DORateLimitStore` was single-threaded
   per Durable Object, so this class of race did not previously exist).
   Wrap in a transaction or a single atomic decide-and-increment statement.
3. **Wire the new stores into their call sites.** `pgRateLimitStore`/
   `secretsStore` exist and are unit-tested but are not yet wired into
   `RateLimitService`/rate-limit `config.ts` or into any REST endpoint —
   that wiring is 2b's job.
4. **`UserService.findUser` is dead code.** Verified zero remaining call
   sites anywhere in `worker/` or `src/` (its only caller was the deleted
   auth controller). Kept per Task 9's review precedent; remove or find a
   new caller in 2b.
5. **Frontend hits real 404s** against the retired `auth`/`cloudflareAccount`/
   `cloudflareConnect`/`stats` endpoints until 2c rebuilds the frontend
   against the new Supabase-Auth-based API. Accepted big-bang tradeoff per
   the scope brief (no dual-run, no feature flags).
6. **Secrets REST layer decoding.** Base64↔`ArrayBuffer` decoding and
   `userId` extraction for the eventual secrets REST endpoints are not yet
   implemented — `secretsStore.ts` provides the storage primitive only.
7. **`bio`/`theme` user-profile fields not persisted.** Deferred columns;
   `updateUserProfileWithValidation` accepts but does not write them.
8. **BYOK re-evaluation.** `apiKeys`/`cloudflareAccounts`/`aiGateways` were
   deferred rather than ported; re-evaluate whether/how to model
   Cloudflare-AI-Gateway-style BYOK under the direct-SDK model 2b is
   moving toward.

## Minor nits (non-blocking)

- **`||` vs `??` default drift.** The original `DORateLimitStore` used
  `config.bucketSize || 10` / `config.burstWindow || 60` (falsy-coalescing);
  `pgRateLimitStore.ts` uses `config.bucketSize ?? DEFAULT_BUCKET_SIZE_SECONDS`
  / `?? DEFAULT_BURST_WINDOW_SECONDS` (nullish-coalescing). Behaviorally
  different only if a caller ever explicitly passes `0` (which would be a
  degenerate bucket size either way) — no current config does. Worth a
  comment or a follow-up ticket, not a fix.
- **`toMetadata` unchecked cast** (`worker/services/secrets/secretsStore.ts`)
  casts `row.metadata` (`unknown`, from `jsonb`) to `SecretMetadata`
  without runtime validation. Plaintext, non-security field; matches the
  old Durable Object's behavior.
- **`period`/`TimePeriod` is vestigial.** `worker/database/types.ts`'s
  `TimePeriod` and the `period` query param
  (`worker/api/controllers/apps/controller.ts:123`,
  `worker/api/controllers/user/controller.ts:35`) are still parsed from the
  querystring but no longer filter anything in the ported `AppService`
  methods.
- **`sort=starred` returns a generic 500.** `AppService.getUserAppsWithAnalytics`/
  `getUserAppsCount` throw `DeferredInPhase2aError` for `sort === 'starred'`
  (depends on the dropped `favorites` table); callers catch and 500 rather
  than returning a typed "not supported" response. Disclosed judgment call
  from Task 5, not fixed here.

## Verifying this phase end to end (once Docker is available)

```bash
bunx supabase start
bunx supabase db reset               # applies both migrations via the real platform
SUPABASE_LOCAL=1 bun run test        # unlocks coreMigration.test.ts
SUPABASE_LOCAL=1 bun test agent-runtime  # unlocks schema/e2e integration tests
bun scripts/agent-runtime/dev-session.ts --query "build a todo app"
```
