# Local Review: SuperServe sandbox migration (uncommitted changes)

**Reviewed**: 2026-07-11
**Branch**: mohamedsobhi777/sandbox-provider-migration-assessment
**Scope**: 2 modified + 6 untracked paths (bulk-write script, InstanceMetadata type, Realtime send retry, template build pipeline, react-vite template, throwaway live driver)
**Decision**: REQUEST CHANGES — HIGH issues present (one active, three latent-until-wired)

## Method

Fresh-eyes review across 3 dimensions (bulk-script, use-chat, templates+scripts), each finding
adversarially verified by an independent agent instructed to refute. 4 verifiers that died on the
Fable-5 limit were re-run on Opus 4.8. Net: **14 confirmed, 9 refuted**. Two findings (base64
corruption, Realtime ack no-op) were reproduced directly before the workflow ran.

## Validation

| Check | Result |
|---|---|
| Type check (`tsc -b`) | Pass |
| Lint (`eslint`) | Pass (0 errors; scripts/ + test file are eslint-ignored) |
| Tests (`vitest` bulkFileScript) | 3/3 pass — but the suite never crosses 8 KB or uses metacharacter paths, so it misses both bulkFileScript bugs |
| Build (`vite build`) | Pass (pre-existing chunk-size warning only) |

## Findings

### HIGH

**H1 — `worker/services/sandbox/bulkFileScript.ts:28` — shell expansion of `filePath`.**
`filePath` is interpolated inside **double** quotes in four places (`"$(dirname "${filePath}")"`,
`> "${filePath}"`, `echo "OK:${filePath}"`, `"FAIL:${filePath}"`) while the base64 payload is
defensively single-quoted. Bash performs `$var` / `$(...)` / backtick expansion on the
LLM-controlled path. A Remix / React-Router route like `app/routes/blog.$slug.tsx` writes to
`app/routes/blog..tsx` (intended file never created) and `app/$(touch X).tsx` executes the embedded
command (reproduced). These are ordinary generated-app filenames. Fix: single-quote the path with
`'\''`-escaping, exactly like the base64 payload. *Latent:* no production caller today (see N1).

**H2 — `worker/services/sandbox/bulkFileScript.ts:14-26` — base64 chunk-boundary corruption.**
`btoa` is applied per 8192-byte chunk; 8192 % 3 = 2, so every boundary injects `=` padding
mid-stream. Reproduced: a 10 KB file fails `base64 -d` ("error decoding base64 input stream"),
leaves a truncated 7680-byte file, and is reported FAIL. The sibling `zipExtractor.ts:137-149`
does this correctly (single `btoa` at the end). Fix: encode the whole buffer once, or use a
chunk size divisible by 3.

**H3 — `worker/services/sandbox/bulkFileScript.ts:28,40` — success-marker mismatch.**
Same root cause as H1: the `OK:` marker is shell-expanded, so the echoed path differs from the
original, and `parseBulkWriteOutput`'s exact `successPaths.has(filePath)` never matches. Any path
with `$`, backtick, `"`, `\` is reported as a write failure even though a (wrong) file was written.

**H4 — `templates-src/react-vite/package.json:15` — pristine template fails the sandbox typecheck.**
`vite.config.ts` uses `process.env`, but `@types/node` is not a devDependency and `tsconfig.json`
includes `vite.config.ts`. Reproduced: the exact command the sandbox runs
(`bunx tsc -b --incremental --noEmit --pretty false`) exits 1 with
`vite.config.ts(6,21): error TS2580: Cannot find name 'process'` on the untouched template. Because
`vite.config.ts` is in `.donttouch_files.json` (and the catalog says "Do not edit vite.config.ts"),
**every generated project starts with a phantom typecheck error the agent cannot legitimately fix**,
and the review/fix loop never sees a clean pass. This is active on every session. Fix: add
`@types/node` to devDependencies, or drop `vite.config.ts` from the tsconfig include.

### MEDIUM

**M1 — `src/routes/chat/hooks/use-chat.ts:405-421` — Realtime retry loop is a no-op.**
The `reliableSend` retry assumes `channel.send()` resolves `'ok'` only on server ack, but the
channel is created without `broadcast: { ack: true }` (line 373), and installed
`@supabase/realtime-js@2.110.1` resolves `'ok'` immediately in that case
(`RealtimeChannel.js:561-563`). The retry never detects the dropped-broadcast race it documents.
Same pattern in `scripts/agent-runtime/live-preview.ts`. `generate_all` is idempotent server-side
(`worker/agents/core/websocket.ts:89`), so enabling `ack` and keeping the retry is safe.

**M2 — `templates-src/react-vite/vite.config.ts:8` — drops the `VITE_LOGGER_TYPE=json` contract.**
The runtime spawns the dev server with `VITE_LOGGER_TYPE='json'` (`localSandbox.ts:160`) and
`process-monitor.ts` parseJsonLog only stores pino-style JSON errors (level ≥ 50). The platform's
canonical config (`worker/agents/utils/templates.ts` VITE_CONFIG_MINIMAL:68) implements the matching
customLogger; this template omits it, so Vite emits plain ANSI, `errors.db` stays empty, and
`get_runtime_errors` reports `hasErrors=false` — the deep debugger's primary runtime-error channel
is blind. (Raw text still reaches `get_logs`.)

**M3 — `templates-src/react-vite/package.json:6` — no `lint` script → lint pass is a silent no-op.**
`runStaticAnalysisCode` runs `bun run lint` (`localSandbox.ts:540`), which exits 1 with
`Script not found "lint"`; `parseESLintJson` swallows the non-JSON output to `[]`. Every
`run_analysis` reports zero lint issues regardless of code quality. The retired template contract
had `"lint": "eslint --cache -f json --quiet ."`.

**M4 — `templates-src/react-vite/.donttouch_files.json` — sandbox-side donttouch/redaction is inert.**
`BaseSandboxService.getTemplateDetails:153` filters dot-JSON files out of the deploy file list, so
`localSandbox.createInstance:131-132` re-parses `.donttouch_files.json` from that list and always
gets `[]`. The `writeFiles` guard (`localSandbox.ts:289-296`) that should reject writes to
`vite.config.ts`/`tsconfig.json` never blocks anything, and redaction masking would be skipped for
any template that lists a redacted file. Worker-layer donttouch checks still exist (exact-string,
with an overwrite bypass), so this is the missing backstop rather than a total gap. `.redacted_files.json`
is currently `[]`, so the redaction leg is latent.

**M5 — `scripts/build-project-templates.ts:16` — secret files not excluded from the zip.**
`EXCLUDE_FILES` omits `.env` / `.env.local` / `.dev.vars`. A developer testing a template locally
with a real key in `.env` (gitignored on disk, so invisible to review) gets it packed into
`dist-templates/react-vite.zip` — a committed blob served unauthenticated from `TEMPLATES_BASE_URL`.
Add `.env*` / `.dev.vars*` to the set.

**M6 — `scripts/build-project-templates.ts` — committed generated output with no freshness gate.**
`dist-templates/` is committed but wired to no npm script or CI check, so `templates-src` edits
without a manual rebuild ship a stale zip to every new sandbox with no failure signal. Add a
build/CI check that fails when `dist-templates` is stale.

### LOW

- **L1 — `src/routes/chat/hooks/use-chat.ts:409`** — retry loop has no unmount cancellation; captures
  local `channel` (not `channelRef.current`), and realtime-js falls back to authenticated REST on a
  non-joined channel, so broadcasts (and possible double-delivery on a `timed out` that was actually
  accepted) continue after `unsubscribe()`/unmount. Bounded by server/client dedup.
- **L2 — `scripts/agent-runtime/live-preview.ts:96`** — `reliableSend` gives up silently after 6
  tries; a total send failure (reachable only via the REST-fallback branch, not the rate-limit
  example in the claim) yields a misleading `generation signal seen: false`. Throwaway dev script.
- **L3 — `scripts/agent-runtime/live-preview.ts:28`** — `Number(--watch-ms)` with no NaN guard;
  `--watch-ms 150s` collapses the watch window to ~0 and reports a false negative.
- **L4 — `scripts/build-project-templates.ts:34`** — no catalog/dir name cross-validation; a mismatch
  builds clean and only surfaces at session time (standalone path degrades to from-scratch, not a
  hard crash).
- **L5 — `scripts/build-project-templates.ts:38`** — `zipSync` embeds `Date.now()` by default
  (verified: fflate 0.8.3, `index.cjs:1889`; byte-compare of two identical builds differs), churning
  the committed binary. Pass a fixed `mtime` for reproducible output.

### NOTE

- **N1 — `bulkFileScript.ts` is currently dead code** — imported only by its own test; the sole wired
  provider (`LocalSandboxService.writeFiles`) uses Node `fs` directly. H1–H3 are real bugs in the
  string-building logic that fire the moment it is wired into the planned `writeFilesViaScript`, but
  they do not affect the running system today. Its docstring also references "the Cloudflare and
  SuperServe providers," but the Cloudflare provider was deleted in `d0e5ed5` and no SuperServe client
  file exists — stale comment.

## Refuted (9)

parseBulkWriteOutput unanchored regex (only full expected paths match; in-sandbox self-forgery is
out of scope) · buildBulkWriteScript missing donttouch (wrong layer — belongs in the provider
`writeFiles`; and it's dead code) · InstanceMetadata omits `importantFiles` (type-checker would catch
loudly; intentional divergence from `LocalInstanceMetadata`) · use-chat "permanent spinner" (auto-rejoin
re-fires SUBSCRIBED and resends; CHANNEL_ERROR path shows a toast) · collect() symlink guard
(`templates-src` is trusted repo content, no trust boundary) · buildEgressAllowlist missing
TEMPLATES_BASE_URL host (actual config serves templates from the already-allowlisted Supabase host) ·
live-preview "not committed" header contradiction (file is untracked, not staged; the grep strings are
live post-migration paths, not retired CF strings) · live-preview non-null env assertions (supabase-js
raises named errors; `bootAgentSandbox` validates) · React 18 vs 19 (intentional self-contained React 18
template; LLM told via catalog text + `.important_files.json` + setup prompt).

## Files reviewed

- `src/routes/chat/hooks/use-chat.ts` (Modified)
- `worker/services/sandbox/types.ts` (Modified)
- `worker/services/sandbox/bulkFileScript.ts` (Added)
- `test/worker/services/sandbox/bulkFileScript.test.ts` (Added)
- `scripts/build-project-templates.ts` (Added)
- `scripts/agent-runtime/live-preview.ts` (Added)
- `templates-src/**`, `dist-templates/**` (Added)
