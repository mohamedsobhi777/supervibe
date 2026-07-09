#!/usr/bin/env bun
/**
 * Local single-origin runner for the re-platformed stack (no Vercel login,
 * no extra deps). Serves the Hono API (`createApp`, the same app
 * `api/[[...route]].ts` runs on Vercel) under `/api/*` and the built SPA
 * (`dist/`) for everything else, matching `vercel.json`'s rewrites.
 *
 * Env comes from `.env.local` (Bun auto-loads it into `process.env`).
 *
 * Usage:
 *   bun run build            # build the SPA into dist/ (needs VITE_* in .env.local)
 *   bun scripts/local-serve.ts   # serve on http://localhost:3000
 *   bun scripts/local-serve.ts --smoke   # in-process API check, no server, exits
 */
import { createApp } from '../worker/app';

const env = process.env as unknown as Env;
const app = createApp(env);

// Vercel Node has no isolate past the response; waitUntil just runs the
// promise and logs rejections (matches api/[[...route]].ts).
const executionContext = {
	waitUntil(promise: Promise<unknown>): void {
		promise.catch((error: unknown) => console.error('[local-serve] waitUntil failed', error));
	},
	passThroughOnException(): void {},
} as unknown as ExecutionContext;

async function apiFetch(request: Request): Promise<Response> {
	return app.fetch(request, env, executionContext);
}

if (process.argv.includes('--smoke')) {
	// In-process verification — no listening server.
	const paths = ['/api/health', '/api/apps/public'];
	for (const path of paths) {
		try {
			const res = await apiFetch(new Request(`http://localhost${path}`));
			const body = await res.text();
			console.log(`${path}\t${res.status}\t${body.slice(0, 240)}`);
		} catch (error) {
			console.log(`${path}\tERROR\t${error instanceof Error ? error.message : String(error)}`);
		}
	}
	process.exit(0);
}

const PORT = Number(process.env.PORT ?? 3000);
const DIST = new URL('../dist/', import.meta.url).pathname;

Bun.serve({
	port: PORT,
	idleTimeout: 120,
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
			return apiFetch(request);
		}
		// Static SPA with index.html fallback (client-side routing).
		const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
		let file = Bun.file(DIST + rel);
		if (!(await file.exists())) file = Bun.file(DIST + 'index.html');
		if (!(await file.exists())) {
			return new Response('SPA not built. Run `bun run build` first.', { status: 503 });
		}
		return new Response(file);
	},
});

console.log(`[local-serve] http://localhost:${PORT}  (API /api/* -> Hono; else -> dist/ SPA)`);
