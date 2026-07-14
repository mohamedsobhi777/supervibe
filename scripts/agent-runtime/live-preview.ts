#!/usr/bin/env bun
/**
 * THROWAWAY live driver (not committed): exercises the real preview path
 * against HOSTED Supabase + the rebuilt SuperServe template, mirroring
 * worker/api/controllers/agent/controller.ts::startCodeGeneration WITHOUT the
 * HTTP/auth layer. Mints a session, boots the sandbox via the real
 * bootAgentSandbox (which injects the LLM key + egress allowlist), joins the
 * session:{id} Realtime channel like the browser does, sends generate_all, and
 * prints the preview URL + which message types the agent streamed back.
 *
 *   bun --env-file=.env.local scripts/agent-runtime/live-preview.ts \
 *       --query "build a simple todo app" --watch-ms 150000
 */
import { createClient } from '@supabase/supabase-js';
import { bootAgentSandbox } from '../../worker/services/sandbox/agentSandboxBoot';
import { mintSessionJwt } from '../../worker/services/auth/sessionJwt';
import { getBehaviorTypeForProject } from '../../worker/agents/core/features';

const env = process.env as unknown as Env;
const src = process.env as Record<string, string | undefined>;

function arg(name: string, def: string): string {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const query = arg('--query', 'build a simple todo app with add, toggle and delete');
const watchMs = Number(arg('--watch-ms', '150000'));

function nowIso(): string {
    return new Date().toISOString().slice(11, 19);
}

async function main(): Promise<void> {
    const supabaseUrl = src.SUPABASE_URL!;
    const anonKey = src.SUPABASE_ANON_KEY!;
    const serviceRoleKey = src.SUPABASE_SERVICE_ROLE_KEY!;

    const sessionId = crypto.randomUUID();
    const agentId = sessionId;

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const initArgs = { query, projectType: 'auto', behaviorType: getBehaviorTypeForProject('app') };
    const { error: seedErr } = await admin
        .from('agent_sessions')
        .insert({ session_id: sessionId, agent_id: agentId, status: 'provisioning', init_args: initArgs });
    if (seedErr) throw new Error(`seed agent_sessions failed: ${seedErr.message}`);
    console.log(`[${nowIso()}] session ${sessionId} seeded (behavior=${initArgs.behaviorType}); query="${query}"`);

    const token = await mintSessionJwt(sessionId, env);

    // Boot the sandbox exactly as the worker does (LLM key + egress injected).
    console.log(`[${nowIso()}] booting sandbox from template "${src.SUPERSERVE_AGENT_TEMPLATE ?? 'bun-agent-runtime'}"...`);
    const boot = await bootAgentSandbox({ sessionId, agentId, sessionJwt: token, env });
    await admin.from('agent_sessions').update({ sandbox_id: boot.sandboxId }).eq('session_id', sessionId);
    console.log(`[${nowIso()}] sandbox ${boot.sandboxId} booted; boot previewUrl=${boot.previewUrl}`);

    // Browser-side watcher: anon key + per-session JWT (same wiring as use-chat.ts / dev-session.ts).
    const browser = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
    await browser.realtime.setAuth(token);

    const seenTypes = new Map<string, number>();
    let agentPreviewUrl: string | undefined;
    let sawGenerationSignal = false;
    let sawInferenceError = false;

    const channel = browser.channel(`session:${sessionId}`, {
        config: { broadcast: { self: false }, private: true },
    });
    channel.on('broadcast', { event: 'message' }, ({ payload }) => {
        const msg = payload as { type?: string; previewUrl?: string; error?: unknown; message?: unknown };
        const type = msg.type ?? 'unknown';
        seenTypes.set(type, (seenTypes.get(type) ?? 0) + 1);
        if (type === 'agent_connected' && msg.previewUrl) agentPreviewUrl = msg.previewUrl;
        if (/phase|file|generat|deploy|conversation/i.test(type)) sawGenerationSignal = true;
        const blob = JSON.stringify(msg);
        if (/error/i.test(type) || /Unsupported binding|gateway|No AI gateway|is not previewable/i.test(blob)) {
            if (/Unsupported binding|No AI gateway/i.test(blob)) sawInferenceError = true;
            console.log(`[${nowIso()}] [ERR] ${type}: ${blob.slice(0, 320)}`);
        } else if (type === 'agent_connected' || /complete|deploy/i.test(type)) {
            console.log(`[${nowIso()}] ${type}: ${blob.slice(0, 200)}`);
        }
    });

    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('channel subscribe timeout')), 15_000);
        channel.subscribe((status, err) => {
            if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                clearTimeout(t); reject(new Error(`subscribe ${status}: ${err?.message ?? ''}`));
            }
        });
    });
    console.log(`[${nowIso()}] channel subscribed; sending get_conversation_state + generate_all`);

    const reliableSend = async (type: string): Promise<void> => {
        for (let i = 0; i < 6; i++) {
            const res = await channel.send({ type: 'broadcast', event: 'client', payload: { raw: JSON.stringify({ type }) } });
            if (res === 'ok') return;
            await new Promise((r) => setTimeout(r, 250));
        }
    };
    await reliableSend('get_conversation_state');
    await reliableSend('generate_all');

    // Backstop: if the agent connects after our first send (boot-race), resend once.
    setTimeout(() => { void reliableSend('generate_all'); }, 20_000);

    console.log(`[${nowIso()}] watching for ${Math.round(watchMs / 1000)}s...`);
    await new Promise((r) => setTimeout(r, watchMs));

    console.log(`\n[${nowIso()}] ===== SUMMARY =====`);
    console.log(`message types: ${JSON.stringify(Object.fromEntries(seenTypes))}`);
    console.log(`boot previewUrl:  ${boot.previewUrl}`);
    console.log(`agent previewUrl: ${agentPreviewUrl ?? '(none seen)'}`);
    console.log(`generation signal seen: ${sawGenerationSignal}`);
    console.log(`inference-throw seen:   ${sawInferenceError}  (must be false = blocker-1 fixed)`);
    console.log(`sandbox ${boot.sandboxId} left RUNNING so you can open the preview URL above.`);
    await channel.unsubscribe();
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error('[live] fatal:', error);
    process.exit(1);
});
