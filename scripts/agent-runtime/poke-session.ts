#!/usr/bin/env bun
/**
 * THROWAWAY diagnostic: connect to an EXISTING agent session's Realtime channel
 * as a browser-equivalent client and send get_conversation_state + generate_all,
 * then watch what the agent broadcasts back. Isolates "is the agent + Realtime +
 * generation pipeline alive?" from "is the real frontend delivering the trigger?"
 *
 *   bun --env-file=.env.local scripts/agent-runtime/poke-session.ts <sessionId> [watchMs]
 */
import { createClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';

const src = process.env as Record<string, string | undefined>;
const sessionId = process.argv[2];
const watchMs = Number(process.argv[3] ?? '90000');
if (!sessionId) { console.error('usage: poke-session.ts <sessionId> [watchMs]'); process.exit(1); }

const t = () => new Date().toISOString().slice(11, 19);

async function mintJwt(): Promise<string> {
    const secret = src.SUPABASE_JWT_SECRET;
    if (!secret) throw new Error('SUPABASE_JWT_SECRET missing');
    return new SignJWT({ session_id: sessionId, role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setAudience('authenticated')
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(new TextEncoder().encode(secret));
}

async function main(): Promise<void> {
    const url = src.SUPABASE_URL!, anon = src.SUPABASE_ANON_KEY!;
    const token = await mintJwt();
    const supabase = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
    await supabase.realtime.setAuth(token);

    const seen = new Map<string, number>();
    const channel = supabase.channel(`session:${sessionId}`, { config: { broadcast: { self: false }, private: true } });
    channel.on('broadcast', { event: 'message' }, ({ payload }) => {
        const type = (payload as { type?: string }).type ?? 'unknown';
        seen.set(type, (seen.get(type) ?? 0) + 1);
        if (/agent_connected|generation|phase|file|deploy|blueprint|error/i.test(type)) {
            console.log(`[${t()}] <- ${type}`);
        }
    });

    const subStatus: string = await new Promise((resolve) => {
        const to = setTimeout(() => resolve('TIMEOUT'), 15000);
        channel.subscribe((status: string, err?: Error) => {
            if (status === 'SUBSCRIBED') { clearTimeout(to); resolve('SUBSCRIBED'); }
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                clearTimeout(to); resolve(`${status}${err ? ` (${err.message})` : ''}`);
            }
        });
    });
    console.log(`[${t()}] channel subscribe result: ${subStatus}`);
    if (subStatus !== 'SUBSCRIBED') { console.log('!! could not subscribe — RLS/auth reject is the frontend symptom'); process.exit(2); }

    const send = async (type: string) => {
        for (let i = 0; i < 6; i++) {
            const r = await channel.send({ type: 'broadcast', event: 'client', payload: { raw: JSON.stringify({ type }) } });
            if (r === 'ok') { console.log(`[${t()}] -> ${type} (ack ok)`); return; }
            await new Promise((res) => setTimeout(res, 250));
        }
        console.log(`[${t()}] -> ${type} NEVER ACKED`);
    };
    await send('get_conversation_state');
    await send('generate_all');

    console.log(`[${t()}] watching ${Math.round(watchMs / 1000)}s for agent activity...`);
    await new Promise((r) => setTimeout(r, watchMs));
    console.log(`\n[${t()}] broadcasts received: ${JSON.stringify(Object.fromEntries(seen))}`);
    await channel.unsubscribe();
    process.exit(0);
}
main().catch((e: unknown) => { console.error('fatal:', e); process.exit(1); });
