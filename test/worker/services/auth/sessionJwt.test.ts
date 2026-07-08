import { describe, expect, it } from 'vitest';
import { jwtVerify } from 'jose';
import { mintSessionJwt } from 'worker/services/auth/sessionJwt';

const TEST_SECRET = 'test-secret-at-least-32-bytes-long-xxxxx';

const env = { SUPABASE_JWT_SECRET: TEST_SECRET } as unknown as Env;

describe('mintSessionJwt', () => {
    it('mints a token carrying session_id, role, and aud claims with a future exp', async () => {
        const token = await mintSessionJwt('session-123', env);

        const { payload } = await jwtVerify(token, new TextEncoder().encode(TEST_SECRET));

        expect(payload.session_id).toBe('session-123');
        expect(payload.role).toBe('authenticated');
        expect(payload.aud).toBe('authenticated');
        expect(payload.exp).toBeDefined();
        expect(payload.exp as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('rejects verification against the wrong secret', async () => {
        const token = await mintSessionJwt('session-123', env);
        const wrongSecret = new TextEncoder().encode('a-completely-different-secret-value-000');

        await expect(jwtVerify(token, wrongSecret)).rejects.toThrow();
    });

    it('throws a clear error when SUPABASE_JWT_SECRET is not configured', async () => {
        const envWithoutSecret = {} as unknown as Env;

        await expect(mintSessionJwt('session-123', envWithoutSecret)).rejects.toThrow(
            'SUPABASE_JWT_SECRET is not configured',
        );
    });
});
