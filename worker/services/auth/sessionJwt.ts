/**
 * Session JWT minting for the per-session agent sandbox and the browser
 * Realtime client (server-side counterpart of the Phase-1 smoke driver's
 * `signSessionJwt` in scripts/agent-runtime/dev-session.ts). The claims
 * mirror the `session_id = (auth.jwt() ->> 'session_id')` RLS predicate in
 * supabase/migrations/20260707000001_agent_runtime.sql; `aud:
 * 'authenticated'` is set explicitly because hosted Supabase enforces
 * strict `aud` checking (the local stack's default GoTrue config does not).
 */

import { SignJWT } from 'jose';

const SESSION_JWT_TTL_SECONDS = 3600;

/**
 * Mints an HS256 Supabase session JWT scoped to a single agent session.
 * Throws if `SUPABASE_JWT_SECRET` is not configured rather than minting an
 * unsigned or empty-secret token.
 */
export async function mintSessionJwt(sessionId: string, env: Env): Promise<string> {
    const jwtSecret = (env as unknown as Record<string, string | undefined>).SUPABASE_JWT_SECRET;
    if (!jwtSecret) {
        throw new Error('SUPABASE_JWT_SECRET is not configured');
    }

    const secretKey = new TextEncoder().encode(jwtSecret);
    return new SignJWT({ session_id: sessionId, role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setAudience('authenticated')
        .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_JWT_TTL_SECONDS)
        .sign(secretKey);
}
