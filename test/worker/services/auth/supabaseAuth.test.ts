import { describe, expect, it } from 'vitest';
import { getUserFromToken, requireUser, type SupabaseClientFactory } from 'worker/services/auth/supabaseAuth';
import { UnauthorizedError } from 'shared/types/errors';

const env = {
    SUPABASE_URL: 'https://project-ref.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
} as unknown as Env;

/**
 * Fake factory matching the task spec: 'good' resolves to a user, 'bad'
 * mirrors what supabase-js returns for a rejected token (null user + error).
 */
const fakeFactory: SupabaseClientFactory = () => ({
    auth: {
        getUser: async (token: string) => {
            if (token === 'good') {
                return { data: { user: { id: 'u1', email: 'a@b.com' } }, error: null };
            }
            return { data: { user: null }, error: { message: 'invalid token' } };
        },
    },
});

describe('getUserFromToken', () => {
    it('maps a valid Supabase user to AuthUser', async () => {
        const user = await getUserFromToken(env, 'good', fakeFactory);
        expect(user).toEqual({ id: 'u1', email: 'a@b.com' });
    });

    it('returns null for a token Supabase rejects', async () => {
        const user = await getUserFromToken(env, 'bad', fakeFactory);
        expect(user).toBeNull();
    });

    it('returns null for an empty token without calling the factory', async () => {
        const user = await getUserFromToken(env, '', fakeFactory);
        expect(user).toBeNull();
    });

    it('maps user_metadata.full_name to displayName when present', async () => {
        const factoryWithMetadata: SupabaseClientFactory = () => ({
            auth: {
                getUser: async () => ({
                    data: { user: { id: 'u2', email: 'x@y.com', user_metadata: { full_name: 'Jane Doe' } } },
                    error: null,
                }),
            },
        });

        const user = await getUserFromToken(env, 'good', factoryWithMetadata);
        expect(user).toEqual({ id: 'u2', email: 'x@y.com', displayName: 'Jane Doe' });
    });

    it('returns null when the Supabase user has no email', async () => {
        const factoryWithoutEmail: SupabaseClientFactory = () => ({
            auth: {
                getUser: async () => ({ data: { user: { id: 'u3' } }, error: null }),
            },
        });

        const user = await getUserFromToken(env, 'good', factoryWithoutEmail);
        expect(user).toBeNull();
    });

    it('never throws, even when the client factory itself throws', async () => {
        const throwingFactory: SupabaseClientFactory = () => {
            throw new Error('network down');
        };

        await expect(getUserFromToken(env, 'good', throwingFactory)).resolves.toBeNull();
    });

    it('returns null when both error and user are present (error takes precedence)', async () => {
        const factoryErrorAndUser: SupabaseClientFactory = () => ({
            auth: {
                getUser: async () => ({
                    data: { user: { id: 'u1', email: 'a@b.com' } },
                    error: { message: 'stale session' },
                }),
            },
        });

        const user = await getUserFromToken(env, 'good', factoryErrorAndUser);
        expect(user).toBeNull();
    });

    it('returns null when getUser rejects (network failure mid-call)', async () => {
        const factoryGetUserThrows: SupabaseClientFactory = () => ({
            auth: {
                getUser: async () => {
                    throw new Error('network');
                },
            },
        });

        const user = await getUserFromToken(env, 'good', factoryGetUserThrows);
        expect(user).toBeNull();
    });

    it('returns null for whitespace-only token', async () => {
        const factoryRejectWhitespace: SupabaseClientFactory = () => ({
            auth: {
                getUser: async (token: string) => {
                    if (token.trim() === '') {
                        return { data: { user: null }, error: { message: 'invalid token' } };
                    }
                    return { data: { user: { id: 'u1', email: 'a@b.com' } }, error: null };
                },
            },
        });

        const user = await getUserFromToken(env, '   ', factoryRejectWhitespace);
        expect(user).toBeNull();
    });
});

describe('requireUser', () => {
    it('resolves the user from an Authorization: Bearer header', async () => {
        const request = new Request('https://worker.test/api', {
            headers: { Authorization: 'Bearer good' },
        });

        const user = await requireUser(env, request, fakeFactory);
        expect(user).toEqual({ id: 'u1', email: 'a@b.com' });
    });

    it('throws UnauthorizedError when no token is present anywhere on the request', async () => {
        const request = new Request('https://worker.test/api');
        await expect(requireUser(env, request, fakeFactory)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('throws UnauthorizedError when the bearer token is rejected by Supabase', async () => {
        const request = new Request('https://worker.test/api', {
            headers: { Authorization: 'Bearer bad' },
        });

        await expect(requireUser(env, request, fakeFactory)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('falls back to the sb-<ref>-auth-token cookie when no Authorization header is present', async () => {
        const cookieValue = encodeURIComponent(JSON.stringify({ access_token: 'good', refresh_token: 'r' }));
        const request = new Request('https://worker.test/api', {
            headers: { Cookie: `sb-project-ref-auth-token=${cookieValue}` },
        });

        const user = await requireUser(env, request, fakeFactory);
        expect(user).toEqual({ id: 'u1', email: 'a@b.com' });
    });

    it('parses a base64-prefixed legacy array-format auth cookie', async () => {
        const raw = `base64-${btoa(JSON.stringify(['good', 'refresh-token']))}`;
        const request = new Request('https://worker.test/api', {
            headers: { Cookie: `sb-project-ref-auth-token=${encodeURIComponent(raw)}` },
        });

        const user = await requireUser(env, request, fakeFactory);
        expect(user).toEqual({ id: 'u1', email: 'a@b.com' });
    });

    it('prefers the Authorization header over a cookie when both are present', async () => {
        const cookieValue = encodeURIComponent(JSON.stringify({ access_token: 'bad' }));
        const request = new Request('https://worker.test/api', {
            headers: {
                Authorization: 'Bearer good',
                Cookie: `sb-project-ref-auth-token=${cookieValue}`,
            },
        });

        const user = await requireUser(env, request, fakeFactory);
        expect(user).toEqual({ id: 'u1', email: 'a@b.com' });
    });

    it('ignores an unparseable auth cookie and throws UnauthorizedError', async () => {
        const request = new Request('https://worker.test/api', {
            headers: { Cookie: 'sb-project-ref-auth-token=not-valid-json-or-base64' },
        });

        await expect(requireUser(env, request, fakeFactory)).rejects.toBeInstanceOf(UnauthorizedError);
    });
});
