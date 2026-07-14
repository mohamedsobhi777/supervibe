#!/usr/bin/env bun
/**
 * THROWAWAY verification for the boot auto-start fix: boot a fresh session
 * exactly like the worker's startCodeGeneration, subscribe to its Realtime
 * channel, and DELIBERATELY never send `generate_all`. If generation happens
 * anyway (generation_started / conversation_response / template_updated), the
 * agent auto-started from init_args.query as intended — no client trigger.
 *
 *   bun --env-file=.env.local scripts/agent-runtime/verify-autostart.ts "build a hello landing page" 150000
 */
import { createClient } from '@supabase/supabase-js';
import { bootAgentSandbox } from '../../worker/services/sandbox/agentSandboxBoot';
import { mintSessionJwt } from '../../worker/services/auth/sessionJwt';
import { getBehaviorTypeForProject } from '../../worker/agents/core/features';

const env = process.env as unknown as Env;
const src = process.env as Record<string, string | undefined>;
const query = process.argv[2] ?? 'build a hello landing page';
const watchMs = Number(process.argv[3] ?? '150000');
const t = () => new Date().toISOString().slice(11, 19);

async function main(): Promise<void> {
    const supabaseUrl = src.SUPABASE_URL!, anon = src.SUPABASE_ANON_KEY!, service = src.SUPABASE_SERVICE_ROLE_KEY!;
    const sessionId = crypto.randomUUID();
    const admin = createClient(supabaseUrl, service);
    const initArgs = { query, projectType: 'auto', behaviorType: getBehaviorTypeForProject('app') };
    const { error } = await admin.from('agent_sessions').insert({ session_id: sessionId, agent_id: sessionId, status: 'provisioning', init_args: initArgs });
    if (error) throw new Error(`seed failed: ${error.message}`);
    console.log(`[${t()}] session ${sessionId} seeded; query="${query}"`);

    const token = await mintSessionJwt(sessionId, env);
    console.log(`[${t()}] booting sandbox (NOT sending generate_all)...`);
    const boot = await bootAgentSandbox({ sessionId, agentId: sessionId, sessionJwt: token, env });
    await admin.from('agent_sessions').update({ sandbox_id: boot.sandboxId }).eq('session_id', sessionId);
    console.log(`[${t()}] sandbox ${boot.sandboxId} booted; preview ${boot.previewUrl}`);

    const browser = createClient(supabaseUrl, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
    await browser.realtime.setAuth(token);
    const seen = new Map<string, number>();
    const channel = browser.channel(`session:${sessionId}`, { config: { broadcast: { self: false }, private: true } });
    channel.on('broadcast', { event: 'message' }, ({ payload }) => {
        const type = (payload as { type?: string }).type ?? 'unknown';
        seen.set(type, (seen.get(type) ?? 0) + 1);
        if (/generation_started|conversation_response|phase|file_|template_updated|deployment_completed|error/i.test(type)) {
            console.log(`[${t()}] <- ${type}`);
        }
    });
    await new Promise<void>((res, rej) => {
        const to = setTimeout(() => rej(new Error('subscribe timeout')), 15000);
        channel.subscribe((s: string) => { if (s === 'SUBSCRIBED') { clearTimeout(to); res(); } else if (/ERROR|TIMED_OUT|CLOSED/.test(s)) { clearTimeout(to); rej(new Error(s)); } });
    });
    // Mimic the frontend's reconnect path: request conversation state, but NEVER send generate_all.
    await channel.send({ type: 'broadcast', event: 'client', payload: { raw: JSON.stringify({ type: 'get_conversation_state' }) } });
    console.log(`[${t()}] subscribed; sent get_conversation_state only. Watching ${Math.round(watchMs / 1000)}s (NO generate_all)...`);

    await new Promise((r) => setTimeout(r, watchMs));
    const generated = (seen.get('generation_started') ?? 0) > 0 || (seen.get('conversation_response') ?? 0) > 0 || (seen.get('template_updated') ?? 0) > 0;
    console.log(`\n[${t()}] broadcasts: ${JSON.stringify(Object.fromEntries(seen))}`);
    console.log(`[${t()}] AUTO-START ${generated ? 'CONFIRMED ✓ (generation ran with no generate_all sent)' : 'FAILED ✗ (agent stayed idle)'}`);
    console.log(`[${t()}] sandbox ${boot.sandboxId} left running; preview: ${boot.previewUrl}`);
    await channel.unsubscribe();
    process.exit(generated ? 0 : 2);
}
main().catch((e: unknown) => { console.error('fatal:', e); process.exit(1); });
