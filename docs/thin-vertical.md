# Thin End-to-End Vertical — Runbook

The first clickable end-to-end flow on the re-platformed stack (Vercel + Supabase +
Superserve, **no Cloudflare Workers runtime on this path**):

> sign in (Supabase Auth) → create app → agent generates in a Superserve sandbox,
> streaming over Supabase Realtime → live preview iframe.

This document is the **operator runbook**: the vertical is type-correct and unit-tested in
this repo, but it has never been run live here (no Docker / hosted Supabase / built
Superserve template in this environment). The steps below are how you stand it up and drive
it for real. The live end-to-end run is the first time the whole stack executes together.

## Architecture (what a request does)

1. **Frontend** (`src`, static SPA built by `vite build`) calls the API.
2. **API** = `worker/app.ts`'s `createApp(env)` Hono app, served by a Vercel Node function
   (`api/[[...route]].ts`). `worker/index.ts` (the Cloudflare entrypoint) is bypassed.
3. `POST /api/agent` (`CodingAgentController.startCodeGeneration`):
   - `AppService.createApp` → `apps` row (Postgres via Drizzle/`postgres-js`, service-role
     connection, bypasses RLS).
   - `AgentSessionService.createAgentSession` → `agent_sessions` row.
   - `mintSessionJwt(sessionId, env)` → HS256 session JWT (`session_id` claim) signed with
     `SUPABASE_JWT_SECRET`.
   - `bootAgentSandbox(...)` → `Sandbox.create(...)` from the `vibesdk-agent` template, runs
     `agent-runtime/src/main.ts` detached; returns `{ sandboxId, previewUrl }`.
   - Returns `AgentBootstrapResponse { agentId, sessionId, realtimeChannel, previewUrl, token }`.
4. **Browser** joins the private Realtime channel `session:{sessionId}` using `token`,
   sends `generate_all`, and renders the agent's streamed messages through the unchanged
   transport-agnostic dispatcher (`handle-websocket-message.ts`).
5. `GET /api/agent/:agentId/connect` re-mints the token + resolves the preview URL for
   reconnect (owner-only).

Realtime contract (shared by agent + browser, from Phase 1): agent→browser broadcast event
`message` (payload = the message object); browser→agent broadcast event `client` with
`payload.raw = JSON.stringify({ type, ... })`.

## Prerequisites

- A **hosted Supabase project** (the agent sandbox reaches `SUPABASE_URL` over the public
  internet — a laptop-local Supabase at `127.0.0.1` is **not** routable from the sandbox).
- A **Superserve** account + API key (`@superserve/sdk`).
- **Vercel** (or any Node host) for the API function + static SPA. `bun` locally.

## 1. Build the Superserve agent template

The sandbox boots from a template named **`vibesdk-agent`** (distinct from the
deploy/preview template `vibesdk-sandbox` referenced by `SUPERSERVE_TEMPLATE`).

```bash
SUPERSERVE_API_KEY=ss_live_... bun run scripts/superserve/build-agent-template.ts
```

Set `SUPERSERVE_AGENT_TEMPLATE` if you name it something other than `vibesdk-agent`.

## 2. Supabase: apply migrations

Point the Supabase CLI at the hosted project, then push **both** migrations:

```bash
bunx supabase db push
# applies:
#   supabase/migrations/20260707000001_agent_runtime.sql  (agent_sessions/state/messages/
#                                                           conversations + session_id RLS +
#                                                           realtime private-channel policies)
#   supabase/migrations/20260708000001_core.sql           (users/apps/model configs/secrets/
#                                                           rate limits/system settings +
#                                                           auth.uid() RLS + handle_new_user)
```

Enable **Realtime** on the project and confirm the `realtime.messages` policies from the
first migration are present (they authorize joining `session:{session_id}`).

## 3. Environment variables

**API (server-side; Vercel project env or a local `.dev.vars`):**

| Var | Purpose |
|-----|---------|
| `SUPABASE_URL` | hosted project URL (e.g. `https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | anon key (used by the auth adapter + handed to the sandbox) |
| `SUPABASE_DB_URL` | direct/pooler Postgres connection string (service-role writes) |
| `SUPABASE_SERVICE_ROLE_KEY` | service role (admin operations) |
| `SUPABASE_JWT_SECRET` | HS256 secret to mint session JWTs — **NOT** the legacy `JWT_SECRET` |
| `SUPERSERVE_API_KEY` | Superserve control-plane key |
| `SUPERSERVE_AGENT_TEMPLATE` | agent template name (default `vibesdk-agent`) |
| `SUPERSERVE_BASE_URL` | optional Superserve API base override |
| `TEMPLATES_BASE_URL` | HTTP base the agent fetches project templates from |
| `CLOUDFLARE_AI_GATEWAY_URL` / `_TOKEN` | optional, if routing LLM calls via AI Gateway |

**Frontend (Vite, build-time, public):**

| Var | Purpose |
|-----|---------|
| `VITE_SUPABASE_URL` | same hosted project URL |
| `VITE_SUPABASE_ANON_KEY` | anon key (public, RLS-protected) |

See `.dev.vars.example` for the browser vars. Never put `SUPABASE_SERVICE_ROLE_KEY` /
`SUPABASE_JWT_SECRET` / `SUPERSERVE_API_KEY` behind a `VITE_` prefix — they must never reach
the client bundle.

## 4. Run

Build the SPA and serve the API:

```bash
bun run build           # emits static SPA to dist/ (vite; the cloudflare() plugin is removed)
vercel dev              # serves api/[[...route]].ts + dist/ ; OR:
# local alternative: run the Hono app under @hono/node-server on :3000 and `vite dev` on :5173
```

`vercel.json` rewrites `/api/*` → the function and everything else → the SPA.

## 5. Manual end-to-end test

1. Open the app, **sign in** (Supabase Auth — OAuth or email/password).
2. Enter a build prompt (e.g. "build a todo app") and start generation.
3. Watch generation **stream over Realtime** — the agent's messages (blueprint, phases, file
   writes) render live in the chat.
4. When the sandbox dev server is up, the **preview iframe** loads the app.
5. Reload the chat URL → it reconnects via `GET /api/agent/:id/connect` (re-minted token +
   preview URL).

## 6. Deferred live verifications (first real full-stack run)

These were unit-tested with fakes here and are validated for real during step 5:

- Session JWT accepted by hosted Supabase RLS + Realtime private-channel join.
- `bootAgentSandbox` against the live Superserve control plane (template boot, detached
  agent process, preview URL).
- The agent runtime's Postgres-backed state + Realtime streaming end to end.
- (Optional) `SUPABASE_LOCAL=1 bun run test` runs the Docker-gated local-Supabase
  integration tests (`scripts/agent-runtime/dev-session.ts`).

## Known items / follow-ups

- **`vercel.json` rewrite**: the `{"source":"/api/(.*)","destination":"/api"}` rule has no
  path capture; Vercel resolves the filesystem function (`api/[[...route]].ts`) before user
  rewrites, so it is most likely inert. Confirm (or drop it) during the first real
  `vercel dev` / `vercel build`.
- **Formatting**: the re-platform files (Phases 1/2a + this vertical) use 4-space indent;
  the pre-existing vibesdk code uses tabs, and the repo as a whole does not currently pass
  `prettier --check` (prettier was never enforced repo-wide). A single repo-wide `prettier
  --write` pass is the right normalization — deferred, out of scope for the vertical (eslint,
  the actual lint gate, passes clean).
- **Blueprint live-preview**: the old create-time NDJSON blueprint stream is gone; blueprint
  chunks now arrive as Realtime messages via the dispatcher. If the live blueprint-typing UX
  needs a dedicated message type the agent emits, that is an agent-runtime follow-up.
- Retired endpoints still referenced by unrelated older frontend code (`/preview`, `/db/*`)
  are Phase 3 / Phase 4 cleanup.
