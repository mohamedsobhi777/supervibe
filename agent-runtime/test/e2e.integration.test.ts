import { describe, expect, it } from 'bun:test';

const gate = process.env.SUPABASE_LOCAL === '1' ? describe : describe.skip;

// Requires a running local Supabase stack: `bunx supabase start` and
// `bunx supabase db reset` beforehand (both Docker-backed). Exercises the
// full standalone agent boot + client round trip against Postgres and
// Realtime — no LLM call is made (get_model_configs is a pure config read).
gate('standalone agent e2e (local supabase)', () => {
    it('boots, emits agent_connected, answers get_model_configs, persists state', async () => {
        const { runSmokeSession } = await import('../../scripts/agent-runtime/dev-session');
        const result = await runSmokeSession({ query: 'smoke test app', timeoutMs: 60_000 });
        expect(result.received.some((m) => m.type === 'agent_connected')).toBe(true);
        expect(result.received.some((m) => m.type === 'model_configs_info')).toBe(true);
        expect(result.statePersisted).toBe(true);
    }, 90_000);
});
