import { describe, expect, it } from 'vitest';
import { mintPreviewToken, verifyPreviewToken } from 'worker/services/sandbox/previewToken';

const SECRET = 'test-secret-value';

describe('previewToken', () => {
    it('mints a 16-char token matching the preview route charset', async () => {
        const token = await mintPreviewToken(SECRET, 8080, '2b7e1c1e-9d1c-4a7b-b1e0-1f2e3d4c5b6a');
        expect(token).toMatch(/^[a-z0-9_-]{16}$/);
        expect(token).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is deterministic for the same inputs', async () => {
        const a = await mintPreviewToken(SECRET, 8080, 'sandbox-a');
        const b = await mintPreviewToken(SECRET, 8080, 'sandbox-a');
        expect(a).toBe(b);
    });

    it('verifies a minted token', async () => {
        const token = await mintPreviewToken(SECRET, 8080, 'sandbox-a');
        expect(await verifyPreviewToken(SECRET, 8080, 'sandbox-a', token)).toBe(true);
    });

    it('rejects a token minted for a different port, sandbox, or secret', async () => {
        const token = await mintPreviewToken(SECRET, 8080, 'sandbox-a');
        expect(await verifyPreviewToken(SECRET, 8081, 'sandbox-a', token)).toBe(false);
        expect(await verifyPreviewToken(SECRET, 8080, 'sandbox-b', token)).toBe(false);
        expect(await verifyPreviewToken('other-secret', 8080, 'sandbox-a', token)).toBe(false);
    });

    it('rejects malformed tokens without throwing', async () => {
        expect(await verifyPreviewToken(SECRET, 8080, 'sandbox-a', '')).toBe(false);
        expect(await verifyPreviewToken(SECRET, 8080, 'sandbox-a', 'zzzzzzzzzzzzzzzz')).toBe(false);
    });
});
