# Phase 2b-rest — Notes

Remaining now-portable API breadth ported onto the Vercel/Hono + Supabase stack, per
`docs/superpowers/plans/2026-07-09-phase2b-rest.md`. Scope was set by a 3-researcher endpoint
categorization (43 endpoints: 18 WORKS, 22 PORT, 3 RETIRE). This phase ships the PORT items that
had no dependency on the DO-based codegen pipeline; the pipeline-coupled + vault items are
deferred to Phase 3, the dead stubs to Phase 4.

## Shipped (each impl + reviewed SHIP via the subagent loop)

| Task | Change | Commit |
|---|---|---|
| 2 | `resolvePlatformCapabilities` — parse object-typed env vars on the Node path (fixed a live 500 on `GET /api/capabilities`; `PLATFORM_CAPABILITIES` is a string under `process.env`) | `128919f` (+ `4258eb3` unblocker) |
| 1 | Platform/user config KV → Postgres `system_settings` (`SystemSettingsService`); fixes the admin banner + per-user rate-limit overrides that were silently dead on Vercel | `8a470a1` |
| 3 | `RateLimitService` → `pgRateLimitStore` when the DO binding is absent (fixes `GET /api/limits/usage` + app-creation/LLM limits) | `7303706` |
| 4 | `favorites` + `stars` Postgres tables + migration + `AppService` methods; re-enabled `isFavorite`/`starCount`/`sort=starred` (were `DeferredInPhase2aError` 500s) | `843ca7b` |
| 5 | Redact `apiKeyEncrypted` from provider GETs (`SafeModelProvider`); re-enable the static `GET /api/secrets/templates` route | `19f92f7` |

Also fixed a latent `TS6133` (unused `request` in `connectToAgent`) surfaced under `tsconfig.app/node.json`'s
`noUnusedParameters` — the incremental `tsc` cache had masked it (`4258eb3`).

## Verification (all green)

- `bun run typecheck` 0; **`bunx tsc -b --force --noEmit` 0** (the incremental cache can mask unused-param/local
  errors under `tsconfig.app/node.json`, so the force build is the real type gate — use it in future sweeps).
- `bun run typecheck:agent-runtime` 0; `bun test agent-runtime` 72 tests / 3 skip / 0 fail.
- `bun run lint` (eslint .) 0 findings. `bun run build` OK (static SPA → `dist/`).
- Worker vitest, run in directory-scoped batches (see infra note): `test/worker/{database,config,api}` 113 pass /
  2 skip; `test/worker/{services,agents,utils}` 73 pass; `bun test` capabilities+vercelHandler 5 pass; colocated
  `worker/agents/inferutils` 7, `worker/utils` 11 — **0 failures across the board.**

### Infra note (environment-specific, not a code issue)
The full single-process `vitest run` cannot complete in this sandbox: `@cloudflare/vitest-pool-workers` spawns a
`workerd` isolate per test file and hits an `EADDRNOTAVAIL` / "Can't assign requested address" loopback
port-exhaustion ceiling around ~30 files per process. Every file passes when run in smaller batches or
individually — the failure is socket exhaustion, not test content. Two test files (`capabilities.test.ts`,
`vercelHandler.test.ts`) are excluded from the vitest pool and run under `bun test` because importing `createApp`
/ the `routes/index.ts` barrel triggers pre-existing SSR-bundling failures in the workers pool (`@sentry/cloudflare`
and `@octokit/rest`/`githubExporterRoutes.ts` pull a `content-type` import workerd can't resolve). These are
harness-only; the product code runs fine under Bun/Node.

## Deferred to Phase 3 (DO-codegen-pipeline-coupled — need agent git/screenshots/state in Superserve first)

- `GET /api/apps/:id` live `agentSummary`/`previewUrl` (DO `getSummary`/`getPreviewUrlCache` → Superserve HTTP or
  persist to Postgres); `getSingleAppWithFavoriteStatus`/`getAppDetails` also still stub `isFavorite`/`starCount`
  (non-throwing).
- GitHub Exporter ×3 (`callback`, `export`, `check-remote`) — read the DO's SQLite git filesystem
  (`exportGitObjects`); need a "get git history out of a Superserve sandbox" primitive.
- Screenshot serving (`TEMPLATES_BUCKET` R2 → Supabase Storage) + the DO-scoped capture/upload path.
- `POST /api/model-configs/test` AI-gateway routing (`env.AI`) — part of the broader inference/model-routing port.
- The **vault** (`/api/vault/*` ×5 + WS) — needs a new `vault_config` Postgres table, a session/WS transport
  (Realtime) with TTL ephemeral-key storage (no DO actor memory on serverless), and reconciling
  `codingAgent.ts`'s `SecretsClient` DO caller. BYOK provider-status (`byokHelper.getUserProviderStatus`, a hard
  stub) is meaningless until the vault is populated, so it moves with the vault.
- Cross-cutting: `RATE_LIMITER`/`KV` (auth + global-api limits) still fail open on Vercel (Cloudflare-native
  bindings); only the `DURABLE_OBJECT`-store limits were ported to Postgres this phase.

## Deferred to Phase 4 (retire/cleanup)

- Provider CRUD 503 stubs (`POST`/`PUT`/`DELETE /api/user/providers` — pre-existing upstream dead code).
- The `'agent'` ws-ticket branch (Supabase Realtime replaced the DO WebSocket).
- Unrouted dead `CodingAgentController.handleWebSocketConnection` / `deployPreview`; the now-dead
  `DeferredInPhase2aError` in the favorites/stars path; delete the Cloudflare `worker/index.ts` entrypoint.

## Follow-up nitpicks (non-blocking)
- `favorites_user_idx`/`stars_user_idx` on `user_id` alone are redundant with the composite PK's leftmost-prefix
  index (minor write-amplification; the migration is unapplied so trivially droppable).
- `pgRateLimitStore`'s read-then-write concurrency gap (not one transaction) is now reachable from more live
  traffic — worth a `SELECT … FOR UPDATE` / upsert-returning hardening pass.
