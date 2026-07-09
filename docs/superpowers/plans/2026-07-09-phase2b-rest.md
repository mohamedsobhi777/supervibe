# Phase 2b-rest — Remaining API Breadth on Vercel

> Subagent-driven (fresh implementer + reviewer per task, ledger `.superpowers/sdd/progress.md`).
> Follows the thin vertical (`2026-07-09-thin-vertical.md`, done + pushed). Scope set by the
> 3-researcher endpoint categorization (43 endpoints: 18 WORKS, 22 PORT, 3 RETIRE).

**Goal:** Make the **now-portable** slice of the remaining API work correctly on the
Vercel/Hono + Supabase stack — the endpoints whose only blocker is deferred-2a Postgres work,
KV/config wiring, or a Vercel env quirk. Endpoints coupled to the **DO-based codegen pipeline**
(live agent summary/preview, GitHub export from DO git fs, screenshot R2 write, the vault
WS/session, AI-gateway inference) are explicitly **deferred to Phase 3** (they need the agent's
git/screenshots/state living in Superserve first). The 503 provider stubs + `'agent'` ws-ticket
are **Phase 4 retire**.

## Global constraints
- Reuse the 2a-ported services (`AppService`, `ModelProvidersService`, `secretsStore`,
  `pgRateLimitStore`, `systemSettings` table) — several exist but aren't wired in. No `any`, no
  emojis, no TODO. bun. Keep root typecheck + `bun test agent-runtime` (69) green at every gate.
- Keep the Cloudflare Workers path typechecking (Phase 4 deletes it). The seam pattern:
  `isStandaloneRuntime(env)` / plain-object `env` on Vercel vs Workers bindings.
- Commit per task (conventional commits); whole-phase verify + push to `personal main` at the end.
- Pre-existing dirty sandbox files stay untouched.

## Deferred (NOT this phase) — recorded so nothing is silently dropped
- **Phase 3 (agent-pipeline-coupled):** `GET /api/apps/:id` live `agentSummary`/`previewUrl`
  (DO `getSummary`/`getPreviewUrlCache` → Superserve HTTP or persist to Postgres); GitHub
  Exporter ×3 (DO SQLite git fs → Superserve git-extract primitive); screenshot serve
  (`TEMPLATES_BUCKET` R2 → Supabase Storage) + the DO-scoped write path; `POST
  /api/model-configs/test` AI-gateway routing (`env.AI`); the **vault** (5 endpoints + WS +
  `codingAgent` `SecretsClient` DO caller) + BYOK provider-status (meaningless until the vault
  is populated).
- **Phase 4 (retire/cleanup):** provider CRUD 503 stubs, `'agent'` ws-ticket branch, unrouted
  dead `handleWebSocketConnection`/`deployPreview`.

---

### Task 1: Platform/user config — KV → Postgres `system_settings`
**Problem:** `worker/config/index.ts` `getGlobalConfigurableSettings`/`getUserConfigurableSettings`
read `env.VibecoderStore` (Cloudflare KV). On Vercel it's absent → try/catch fails open →
`GET /api/status` banner is a permanent no-op AND per-user `security.rateLimit` overrides are
dead for **every** authed route (read in `routeAuth.ts:207`). The 2a `systemSettings` Postgres
table exists but is not wired here.
**Files:** `worker/config/index.ts`; a small `SystemSettingsService` (or extend an existing 2a
service) reading/writing `schema.systemSettings`; tests.
**Interfaces:** `getGlobalConfigurableSettings(env)` / `getUserConfigurableSettings(env, userId)`
resolve from `system_settings` (global key + `user_config:{id}` key) via Drizzle, with the same
`defaultConfig` fallback when a row is absent. Keep the return SHAPE identical (config consumers
unchanged). On the standalone agent runtime keep the no-op/default path (no real DB).
- [ ] Read from `system_settings` (key/value jsonb). Preserve fail-safe defaults; do not throw.
- [ ] Unit-test: seeded row → merged config; missing row → defaults; the shape matches consumers.
- [ ] Verify typecheck + agent-runtime green. Commit `feat: platform/user config from postgres system_settings`.

### Task 2: Vercel env JSON hardening (`capabilities` live 500)
**Problem:** `env.PLATFORM_CAPABILITIES` is a Cloudflare `vars` **object** binding; on Vercel
`process.env` gives a **string**, so `CapabilitiesController` does `config.features.app.enabled`
→ `TypeError` 500 on every `GET /api/capabilities`.
**Files:** `api/[[...route]].ts` (parse before building `env`), or a defensive parse in the
capabilities controller/config; test `test/worker/api/…`.
**Interfaces:** `GET /api/capabilities` returns 200 with the parsed capabilities under a plain
`process.env`. Parse any other object-typed `vars` the same way (audit `worker-configuration.d.ts`
`vars` that a controller dereferences as an object — e.g. `PLATFORM_CAPABILITIES`).
- [ ] In `api/[[...route]].ts`, JSON.parse the stringified object vars into the `env` object
  (guarded: only parse when it's a string; leave real objects as-is so Workers is unchanged).
- [ ] Test: capabilities endpoint 200 under a string-valued `PLATFORM_CAPABILITIES`. RED→GREEN.
- [ ] Verify + commit `fix: parse object-typed env vars on the vercel node path`.

### Task 3: Rate limiting — wire `pgRateLimitStore` into `RateLimitService`
**Problem:** `RateLimitService` (app-creation, LLM-calls, `GET /api/limits/usage`) calls
`env.DORateLimitStore` (Durable Object) / `env.AUTH_RATE_LIMITER`. On Vercel both are absent →
fail open (limiting silently disabled). The 2a `pgRateLimitStore` (bit-for-bit DO-equivalent
window algorithm, unit-tested) is not wired.
**Files:** `worker/services/rate-limit/rateLimits.ts` (RateLimitService), the rate-limit config
(`RateLimitStore` selection), `worker/services/rate-limit/usageChecker.ts` where relevant; tests.
**Interfaces:** Under Vercel/standalone (no `DORateLimitStore` binding), `RateLimitService` uses
`pgRateLimitStore` (`increment`/`getRemainingLimit`) against Postgres; on Workers it keeps the DO
store. `getRemainingCredits`/`enforce*` behavior identical.
- [ ] Add a Postgres store branch to the store selection (mirror the `isStandaloneRuntime`/binding
  seam). Route `getRemainingCredits`/`enforce` through it when the DO binding is absent.
- [ ] Test: with a fake pg store, enforce/getRemaining produce the window-correct results; the
  app-creation + limits/usage paths use it. RED→GREEN.
- [ ] Verify + commit `feat: postgres-backed rate limiting on the vercel path`.

### Task 4: Favorites + stars — Postgres tables + `AppService` methods
**Problem:** `getFavoriteAppsOnly`/`toggleAppFavorite`/`toggleAppStar` throw
`DeferredInPhase2aError` (tables dropped in the lean 7-table schema) → `GET /api/apps/favorites`,
`POST /api/apps/:id/favorite`, `POST /api/apps/:id/star` 500 today; `isFavorite` always false;
`sort=trending/popular/starred` degrade to recency.
**Files:** `worker/database/schema.ts` (+ `favorites`, `stars` pg tables + type exports); a new
Supabase migration (`supabase/migrations/…_favorites_stars.sql` with `auth.uid()` RLS matching the
2a user-owned pattern); `worker/database/services/AppService.ts` (implement the three methods +
re-enable `isFavorite`/star-count in the ranked queries); tests.
**Interfaces:** `favorites(user_id, app_id, created_at)` UNIQUE(user_id, app_id);
`stars(user_id, app_id, created_at)` UNIQUE(user_id, app_id). Methods return the same shapes the
controllers already expect. RLS: `user_id = auth.uid()` (but the API writes via the service-role
connection, consistent with 2a).
- [ ] Add tables + migration + RLS; implement the AppService methods (fake-drizzle recorder tests
  per the 2a pattern); re-enable favorite/star flags in `getPublicApps`/`getUserApps` ranking.
- [ ] Verify typecheck + the new tests + `schema.test.ts` (add column-name guards like the
  `agentSessions` follow-up). Commit `feat: favorites + stars postgres tables and app service`.

### Task 5: Provider secret redaction + secrets/templates re-enable + WORKS verify-sweep
**Problem (3 small, related):** (a) `GET /api/user/providers[/:id]` returns the full row incl.
`apiKeyEncrypted` ciphertext (data-exposure carry-forward #1). (b) `setupSecretsRoutes` (the pure
static `GET /api/secrets/templates`) is needlessly commented out in `routes/index.ts`. (c) the 18
WORKS endpoints have never been exercised on the Node path.
**Files:** `worker/api/controllers/modelProviders/controller.ts` (redact); `worker/api/routes/index.ts`
(uncomment `setupSecretsRoutes` + import); a controller/unit test for redaction; a lightweight
route-level smoke test hitting a representative WORKS set via `app.request(...)` under a fake env.
**Interfaces:** provider responses omit `apiKeyEncrypted` (and any nonce/ciphertext); `GET
/api/secrets/templates` returns the static template list; the WORKS endpoints resolve (200 or a
correct auth/validation status) under `createApp(fakeEnv)`.
- [ ] Redact ciphertext fields from provider GETs (map to a safe DTO). Re-enable secrets/templates.
- [ ] Add a redaction unit test + a small `app.request` smoke test over the WORKS endpoints
  (assert no `apiKeyEncrypted` leaks; assert 200/expected status). RED→GREEN.
- [ ] Verify + commit `fix: redact provider ciphertext, re-enable secret templates, verify works-set`.

### Task 6: Whole-phase verify + push
- [ ] Gates: `bun run typecheck` 0, `bun run typecheck:agent-runtime` 0, `bun run test:agent-runtime`
  69, `bun run test` green, `bun run lint` (report pre-existing), `bun run build` OK.
- [ ] Append a `docs/phase2b-rest-notes.md` (what shipped, the WORKS verify results, and the
  explicit Phase-3/Phase-4 deferred list above).
- [ ] Commit `chore: phase 2b-rest verification sweep + notes`; push `git push personal HEAD:main`.

## Execution
Subagent-driven, task-by-task, review each. Order: T2 (trivial, unblocks a live 500) can go early;
T1/T3 are cross-cutting (do before the verify-sweep); T4 is self-contained data-layer; T5 folds
the small security/enablement items + the verify-sweep. Keep typecheck + agent-runtime green at
every gate. Push only after T1–T5 are reviewed SHIP and T6's sweep is green.
