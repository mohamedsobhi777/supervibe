/**
 * Deterministic HMAC tokens for SuperServe preview URLs.
 *
 * The Cloudflare sandbox validates its own exposePort tokens inside the
 * Durable Object; for SuperServe the Worker is the auth boundary, so preview
 * URLs carry HMAC-SHA256(secret, "superserve-preview:{port}:{sandboxId}")
 * truncated to 16 hex chars — a subset of the existing route token charset.
 */

const TOKEN_LENGTH = 16;

async function hmacHex(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function mintPreviewToken(secret: string, port: number, sandboxId: string): Promise<string> {
    const digest = await hmacHex(secret, `superserve-preview:${port}:${sandboxId}`);
    return digest.slice(0, TOKEN_LENGTH);
}

export async function verifyPreviewToken(
    secret: string,
    port: number,
    sandboxId: string,
    token: string,
): Promise<boolean> {
    if (token.length !== TOKEN_LENGTH) {
        return false;
    }
    const expected = await mintPreviewToken(secret, port, sandboxId);
    let mismatch = 0;
    for (let i = 0; i < TOKEN_LENGTH; i++) {
        mismatch |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    }
    return mismatch === 0;
}
