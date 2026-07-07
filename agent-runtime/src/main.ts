/**
 * Bootstrap entrypoint for the standalone agent runtime: reads env, wires
 * Postgres/Realtime-backed infrastructure, boots one `StandaloneAgent`
 * instance for the session named by `SESSION_ID`, and keeps the process
 * alive until a shutdown signal arrives. One process serves exactly one
 * session (agent-runtime/src/standaloneAgent.ts's one-session-per-process
 * model), so nothing here is parameterized beyond the environment.
 *
 * Not covered by any test in this task: booting requires a live Supabase
 * project and a real session JWT, which only exists under a gated smoke
 * test (see docs/superpowers/plans — phase 1 task 11). This file is
 * verified by type-checking only.
 */

import { mkdir } from 'node:fs/promises';

import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

import { setRuntimeEnv } from 'worker/utils/runtimeEnv';
import { createHttpTemplateSource, setTemplateSource } from 'worker/services/sandbox/templateSource';

import { parseBootstrapEnv } from './bootstrapEnv';
import { buildEnvAdapter } from './envAdapter';
import { createStateStore, type SupabaseLike } from './stateStore';
import { createConversationStore, type ConversationClient } from './conversationStore';
import { createRealtimeTransport } from './transport';
import { LocalSandboxService } from './localSandbox';
import { StandaloneAgent } from './standaloneAgent';

const HEARTBEAT_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
    const cfg = parseBootstrapEnv(process.env);

    // Route worker-tree code (templateSource, sandbox factory, etc.) to the
    // standalone env/template seams instead of Workers bindings.
    setRuntimeEnv(buildEnvAdapter());
    setTemplateSource(createHttpTemplateSource(cfg.templatesBaseUrl));

    // The GitVersionControl adapter (agent-runtime/src/nodeGitFs.ts) rebases
    // isomorphic-git's assumed virtual root ('/') onto workspaceDir but never
    // creates workspaceDir itself — StandaloneAgent.boot() would fail the
    // first git operation against a missing directory.
    await mkdir(cfg.workspaceDir, { recursive: true });

    // One Supabase client, two layered auth mechanisms:
    //
    // `supabaseKey` (createClient's 2nd positional arg) is NOT optional —
    // the SDK throws "supabaseKey is required." if omitted
    // (@supabase/supabase-js dist/index.mjs, SupabaseClient constructor) —
    // and it is used unconditionally as the `apikey` header on every
    // PostgREST request and on the Realtime websocket handshake
    // (dist/index.mjs: `_getAccessToken` falls back to `this.supabaseKey`
    // for the `Authorization` header; `_realtime()` sends
    // `params: { apikey: this.supabaseKey, ... }`). That key must be the
    // project's anon key, not the per-session JWT: passing the JWT in that
    // slot would send it as `apikey` too, which Postgres/GoTrue does not
    // accept as a project API key.
    //
    // The per-session JWT layers on top of the anon key via two separate
    // mechanisms (both required — they authorize different subsystems):
    //   - PostgREST (`.from(...)`): `global.headers.Authorization` sets the
    //     bearer token, which the SDK's `_getAccessToken()` treats as an
    //     override of the anon key: "resolves session -> returns
    //     accessToken result -> returns key" (dist/index.mjs), so a header
    //     already carrying `Authorization: Bearer <jwt>` reaches PostgREST
    //     and `auth.jwt() ->> 'session_id'` (the RLS predicate in
    //     supabase/migrations/20260707000001_agent_runtime.sql) resolves to
    //     this session's claim.
    //   - Realtime (`.channel(...)`): the client's `apikey` connection
    //     param (source above) authenticates the websocket transport, but
    //     channel-level authorization for the `session:{id}` private
    //     broadcast topic (also RLS-gated, on `realtime.messages`) is a
    //     separate JWT carried per-channel. `client.realtime.setAuth(jwt)`
    //     is the documented mechanism (realtime-js RealtimeClient.d.ts:
    //     "Sets the JWT access token used for channel subscription
    //     authorization and Realtime RLS... token will be preserved across
    //     channel operations"). It must run before `channel.subscribe()` is
    //     called by createRealtimeTransport() below, since the join
    //     handshake is where the RLS check happens.
    //
    // This confirms the crib's suggested approach and required adding
    // SUPABASE_ANON_KEY (see bootstrapEnv.ts) — the session JWT alone
    // cannot satisfy createClient's mandatory key argument.
    const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${cfg.supabaseSessionJwt}` } },
    });
    await supabase.realtime.setAuth(cfg.supabaseSessionJwt);

    const { data: sessionRow, error: sessionError } = await supabase
        .from('agent_sessions')
        .select('init_args')
        .eq('session_id', cfg.sessionId)
        .maybeSingle();
    if (sessionError) {
        throw new Error(`Failed to load agent_sessions row: ${sessionError.message}`);
    }
    const initArgs = (sessionRow?.init_args as Record<string, unknown> | null) ?? undefined;

    // `SupabaseClient`'s `.from()` return type is a deeply generic PostgREST
    // builder chain; asking TypeScript to structurally prove it satisfies
    // the narrow `SupabaseLike`/`ConversationClient` façades (rather than
    // being told it does) exceeds the compiler's generic-instantiation
    // depth (TS2589). The real client is a strict structural superset of
    // both façades at runtime — this assertion only skips the recursive
    // proof, not a real mismatch.
    const stateStore = createStateStore(supabase as unknown as SupabaseLike, cfg.sessionId);
    const conversationStore = createConversationStore(supabase as unknown as ConversationClient, cfg.sessionId);
    const sandbox = new LocalSandboxService({
        sessionId: cfg.sessionId,
        workspaceDir: cfg.workspaceDir,
        previewBaseUrl: cfg.selfPreviewBaseUrl,
    });

    // The transport's onClientMessage callback must reference the agent
    // instance, but the agent can only be constructed after the transport
    // is ready (StandaloneAgent.boot() takes a live AgentTransport). A
    // mutable ref bridges the two: onClientMessage forwards to whatever
    // `agentRef.current` holds, and boot() assigns it once the agent
    // exists. Messages arriving in the (sub-millisecond) window between
    // transport.ready() and the boot() assignment are not expected in
    // practice — the client only starts sending after observing this same
    // process's `agent_connected` broadcast, which boot() emits after the
    // assignment below — but the ref is still checked defensively.
    const agentRef: { current: StandaloneAgent | undefined } = { current: undefined };

    const transport = createRealtimeTransport({
        channelFactory: (topic) =>
            supabase.channel(topic, {
                config: { broadcast: { self: false }, private: true },
            }) as unknown as RealtimeChannel,
        sessionId: cfg.sessionId,
        onClientMessage: (raw: string) => {
            if (!agentRef.current) {
                console.error(`Dropped client message: agent not yet booted for session ${cfg.sessionId}`);
                return;
            }
            void agentRef.current.handleClientMessage(raw);
        },
    });

    await transport.ready();

    const agent = await StandaloneAgent.boot({
        sessionId: cfg.sessionId,
        agentId: cfg.agentId,
        workspaceDir: cfg.workspaceDir,
        env: buildEnvAdapter(),
        transport,
        stateStore,
        conversationStore,
        sandbox,
        initArgs,
        selfPreviewBaseUrl: cfg.selfPreviewBaseUrl,
    });
    agentRef.current = agent;

    const heartbeat = setInterval(() => {
        void supabase
            .from('agent_sessions')
            .update({ last_activity_at: new Date().toISOString() })
            .eq('session_id', cfg.sessionId)
            .then(({ error }) => {
                if (error) {
                    console.error(`Heartbeat update failed: ${error.message}`);
                }
            });
    }, HEARTBEAT_INTERVAL_MS);

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Received ${signal}, shutting down session ${cfg.sessionId}`);
        clearInterval(heartbeat);
        await agent.shutdown();
        process.exit(0);
    };

    process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
        void shutdown('SIGINT');
    });
}

main().catch((error: unknown) => {
    console.error('Fatal error during standalone agent bootstrap:', error);
    process.exit(1);
});
