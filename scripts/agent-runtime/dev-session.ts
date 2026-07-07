#!/usr/bin/env bun
/**
 * Local end-to-end smoke driver for the standalone agent runtime.
 *
 * Seeds an `agent_sessions` row against a LOCAL Supabase stack (service
 * role), mints a session JWT, spawns `bun agent-runtime/src/main.ts` with
 * the env contract from `agent-runtime/src/bootstrapEnv.ts`, subscribes to
 * `session:{id}` as a browser-side Realtime client, sends `get_model_configs`,
 * waits for the `model_configs_info` response, then tears the agent process
 * down and confirms `agent_state` persisted a row.
 *
 * This exercises boot, the `agent_connected` snapshot broadcast, a
 * client -> agent -> client round trip, and Postgres-backed state
 * persistence — no LLM call is made (`get_model_configs` is a pure config
 * read), so no provider API key is required.
 *
 * Requires a running local Supabase stack (`bunx supabase start` +
 * `bunx supabase db reset`, both Docker-backed). Run directly with:
 *   bun scripts/agent-runtime/dev-session.ts --query "build a todo app"
 * or import `runSmokeSession` from a gated integration test
 * (agent-runtime/test/e2e.integration.test.ts).
 */

import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { SignJWT } from 'jose';

const AGENT_MAIN_ENTRY = 'agent-runtime/src/main.ts';
const SESSION_JWT_TTL_SECONDS = 3600;
const REALTIME_READY_TIMEOUT_MS = 15_000;
const AGENT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;
/** Unreachable by design: a bare boot with no persisted query never fetches a template. */
const PLACEHOLDER_TEMPLATES_BASE_URL = 'http://127.0.0.1:0';

export interface ReceivedMessage {
    type: string;
    [key: string]: unknown;
}

export interface RunSmokeSessionOptions {
    query: string;
    timeoutMs?: number;
}

export interface RunSmokeSessionResult {
    received: ReceivedMessage[];
    statePersisted: boolean;
}

interface LocalSupabaseKeys {
    apiUrl: string;
    anonKey: string;
    serviceRoleKey: string;
    jwtSecret: string;
}

/**
 * Parses `KEY=VALUE` lines from `bunx supabase status` output. Splits on the
 * first `=` only (base64-encoded values, e.g. JWT secrets, may contain `=`
 * padding) and strips a single layer of surrounding quotes if present.
 */
function parseKeyValueLines(text: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex <= 0) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if (value.length >= 2) {
            const first = value[0];
            const last = value[value.length - 1];
            if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                value = value.slice(1, -1);
            }
        }
        if (key && value) {
            result.set(key, value);
        }
    }
    return result;
}

/**
 * Reads the local Supabase stack's connection details. Tries `-o env` first
 * (stable `KEY=VALUE` format); falls back to parsing the default pretty
 * `status` text if the env-format run fails or is missing a required key.
 * The CLI's `-o env` field names are unprefixed (`API_URL`, `ANON_KEY`,
 * `SERVICE_ROLE_KEY`, `JWT_SECRET`); `SUPABASE_`-prefixed aliases are also
 * accepted for callers who export overrides manually (matching the
 * convention in agent-runtime/test/schema.integration.test.ts).
 */
async function readLocalSupabaseKeys(): Promise<LocalSupabaseKeys> {
    const lookup = (map: Map<string, string>, ...names: string[]): string | undefined => {
        for (const name of names) {
            const value = map.get(name);
            if (value) return value;
        }
        return undefined;
    };

    const tryExtract = (map: Map<string, string>): LocalSupabaseKeys | undefined => {
        const apiUrl = lookup(map, 'API_URL', 'SUPABASE_URL');
        const anonKey = lookup(map, 'ANON_KEY', 'SUPABASE_ANON_KEY');
        const serviceRoleKey = lookup(map, 'SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
        const jwtSecret = lookup(map, 'JWT_SECRET', 'SUPABASE_JWT_SECRET');
        if (apiUrl && anonKey && serviceRoleKey && jwtSecret) {
            return { apiUrl, anonKey, serviceRoleKey, jwtSecret };
        }
        return undefined;
    };

    const envProc = Bun.spawn(['bunx', 'supabase', 'status', '-o', 'env'], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [envStdout, envExitCode] = await Promise.all([
        new Response(envProc.stdout).text(),
        envProc.exited,
    ]);
    if (envExitCode === 0) {
        const parsed = tryExtract(parseKeyValueLines(envStdout));
        if (parsed) return parsed;
    }

    const plainProc = Bun.spawn(['bunx', 'supabase', 'status'], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [plainStdout, plainStderr, plainExitCode] = await Promise.all([
        new Response(plainProc.stdout).text(),
        new Response(plainProc.stderr).text(),
        plainProc.exited,
    ]);
    if (plainExitCode !== 0) {
        throw new Error(
            `Failed to read local Supabase status (is 'bunx supabase start' running?): ${plainStderr || plainStdout}`,
        );
    }
    // The pretty text format uses "key: value" lines rather than "KEY=VALUE".
    const normalized = plainStdout
        .split('\n')
        .map((line) => line.replace(/^(\s*)([A-Za-z][\w ]*?):\s*/, (_match, indent: string, label: string) => {
            return `${indent}${label.trim().toUpperCase().replace(/\s+/g, '_')}=`;
        }))
        .join('\n');
    const fallback = tryExtract(parseKeyValueLines(normalized));
    if (!fallback) {
        throw new Error(
            'Could not determine API URL, anon key, service role key, and JWT secret from `bunx supabase status`. ' +
                'Ensure the local stack is running (`bunx supabase start`) and re-run.',
        );
    }
    return fallback;
}

/** Signs an HS256 session JWT with the local stack's `SUPABASE_JWT_SECRET`, matching the RLS predicate in supabase/migrations/20260707000001_agent_runtime.sql. */
async function signSessionJwt(sessionId: string, jwtSecret: string): Promise<string> {
    const secretKey = new TextEncoder().encode(jwtSecret);
    return new SignJWT({ session_id: sessionId, role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_JWT_TTL_SECONDS)
        .sign(secretKey);
}

function waitForReady(channel: RealtimeChannel, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Realtime channel failed to subscribe within ${timeoutMs}ms`));
        }, timeoutMs);
        channel.subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
                clearTimeout(timer);
                resolve();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                clearTimeout(timer);
                reject(new Error(`Realtime channel subscribe failed: ${status}${err ? ` (${err.message})` : ''}`));
            }
        });
    });
}

/**
 * Runs the full local smoke flow described in the module header and returns
 * every broadcast the agent sent plus whether `agent_state` persisted a row.
 */
export async function runSmokeSession(options: RunSmokeSessionOptions): Promise<RunSmokeSessionResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
    const keys = await readLocalSupabaseKeys();

    const sessionId = `smoke-${crypto.randomUUID()}`;
    const agentId = `agent-${sessionId}`;

    const admin = createClient(keys.apiUrl, keys.serviceRoleKey);
    const { error: seedError } = await admin.from('agent_sessions').insert({
        session_id: sessionId,
        agent_id: agentId,
        init_args: { query: options.query },
    });
    if (seedError) {
        throw new Error(`Failed to seed agent_sessions row: ${seedError.message}`);
    }

    const sessionJwt = await signSessionJwt(sessionId, keys.jwtSecret);

    const received: ReceivedMessage[] = [];
    let modelConfigsResolve: (() => void) | undefined;
    const modelConfigsReceived = new Promise<void>((resolve) => {
        modelConfigsResolve = resolve;
    });

    // Browser-side client: anon key + per-session JWT, exactly as main.ts
    // wires the agent-side client (see main.ts's ONE-CLIENT comment).
    const browserClient = createClient(keys.apiUrl, keys.anonKey, {
        global: { headers: { Authorization: `Bearer ${sessionJwt}` } },
    });
    await browserClient.realtime.setAuth(sessionJwt);
    const channel = browserClient.channel(`session:${sessionId}`, {
        config: { broadcast: { self: false }, private: true },
    });
    channel.on('broadcast', { event: 'message' }, ({ payload }) => {
        const message = payload as ReceivedMessage;
        received.push(message);
        if (message.type === 'model_configs_info') {
            modelConfigsResolve?.();
        }
    });
    await waitForReady(channel, REALTIME_READY_TIMEOUT_MS);

    const agentProc = Bun.spawn(['bun', AGENT_MAIN_ENTRY], {
        env: {
            ...process.env,
            SESSION_ID: sessionId,
            AGENT_ID: agentId,
            SUPABASE_URL: keys.apiUrl,
            SUPABASE_ANON_KEY: keys.anonKey,
            SUPABASE_SESSION_JWT: sessionJwt,
            TEMPLATES_BASE_URL: PLACEHOLDER_TEMPLATES_BASE_URL,
            WORKSPACE_DIR: `/tmp/vibesdk-smoke-${sessionId}`,
        },
        stdout: 'inherit',
        stderr: 'inherit',
    });

    try {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
        try {
            await Promise.race([
                modelConfigsReceived,
                new Promise<never>((_resolve, reject) => {
                    timeoutController.signal.addEventListener('abort', () => {
                        reject(new Error(`Timed out after ${timeoutMs}ms waiting for model_configs_info`));
                    });
                }),
                agentProc.exited.then((code) => {
                    throw new Error(`Agent process exited early with code ${code} before responding`);
                }),
            ]);

            await channel.send({
                type: 'broadcast',
                event: 'client',
                payload: { raw: JSON.stringify({ type: 'get_model_configs' }) },
            });

            await modelConfigsReceived;
        } finally {
            clearTimeout(timeoutId);
        }
    } finally {
        await channel.unsubscribe();
        agentProc.kill('SIGTERM');
        await Promise.race([
            agentProc.exited,
            new Promise((resolve) => setTimeout(resolve, AGENT_SHUTDOWN_TIMEOUT_MS)),
        ]);
    }

    const { data: stateRow, error: stateError } = await admin
        .from('agent_state')
        .select('session_id')
        .eq('session_id', sessionId)
        .maybeSingle();
    if (stateError) {
        throw new Error(`Failed to read agent_state: ${stateError.message}`);
    }

    await admin.from('agent_sessions').delete().eq('session_id', sessionId);

    return { received, statePersisted: stateRow !== null };
}

function parseCliArgs(argv: string[]): { query: string } {
    const queryIndex = argv.indexOf('--query');
    const query = queryIndex >= 0 ? argv[queryIndex + 1] : undefined;
    if (!query) {
        throw new Error('Usage: bun scripts/agent-runtime/dev-session.ts --query "<prompt>"');
    }
    return { query };
}

async function main(): Promise<void> {
    const { query } = parseCliArgs(process.argv.slice(2));
    console.log(`[dev-session] starting smoke session for query: ${query}`);
    const result = await runSmokeSession({ query });
    console.log(`[dev-session] received ${result.received.length} broadcast(s):`);
    for (const message of result.received) {
        console.log(`  - ${message.type}`);
    }
    console.log(`[dev-session] agent_state persisted: ${result.statePersisted}`);
    if (!result.statePersisted) {
        console.error('[dev-session] FAILED: agent_state has no row for this session');
        process.exit(1);
    }
    console.log('[dev-session] smoke session PASSED');
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        console.error('[dev-session] fatal error:', error);
        process.exit(1);
    });
}
