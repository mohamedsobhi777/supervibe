
// ===============================
// Screenshot storage helpers
// ===============================

import { createClient } from "@supabase/supabase-js";
import { ImageAttachment, ProcessedImageAttachment, SupportedImageMimeType } from "worker/types/image-attachment";
import { getProtocolForHost } from "./urls";
import { isStandaloneRuntime } from "./runtimeMode";

// ===============================
// Blank screenshot detection
// ===============================

interface BlankDetectionResult {
    isBlank: boolean;
    reason: string;
}

/**
 * Calculates Shannon entropy of byte data.
 * Higher entropy indicates more randomness/variation.
 * Uniform/blank images have very low entropy (< 2.0).
 */
export function calculateEntropy(data: Uint8Array): number {
    const freq = new Array(256).fill(0);
    for (const byte of data) {
        freq[byte]++;
    }

    let entropy = 0;
    for (const count of freq) {
        if (count > 0) {
            const p = count / data.length;
            entropy -= p * Math.log2(p);
        }
    }
    return entropy;
}

/**
 * Detects if a screenshot is blank/uniform using file size and entropy analysis.
 * Memory-efficient: doesn't decode full PNG pixel data.
 *
 * @param base64Data - Base64 encoded PNG (without data URL prefix)
 * @param minFileSize - Minimum expected file size in bytes (default: 10KB)
 * @param minEntropy - Minimum entropy threshold (default: 2.0)
 */
export function detectBlankScreenshot(
    base64Data: string,
    minFileSize: number = 10000,
    minEntropy: number = 2.0
): BlankDetectionResult {
    const bytes = base64ToUint8Array(base64Data);

    // Check 1: File size
    // A blank 1280x720 PNG typically compresses to < 5KB
    // Real screenshots with content are usually > 50KB
    if (bytes.length < minFileSize) {
        return {
            isBlank: true,
            reason: `File size too small: ${bytes.length} bytes (minimum: ${minFileSize})`
        };
    }

    // Check 2: Entropy of the last portion of the file (compressed pixel data)
    // Sample the last 1000 bytes which contains compressed image data
    const sampleSize = Math.min(1000, bytes.length);
    const sample = bytes.slice(-sampleSize);
    const entropy = calculateEntropy(sample);

    if (entropy < minEntropy) {
        return {
            isBlank: true,
            reason: `Low entropy: ${entropy.toFixed(2)} (minimum: ${minEntropy})`
        };
    }

    return {
        isBlank: false,
        reason: 'Passed all checks'
    };
}

    
export function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export enum ImageType {
    SCREENSHOTS = 'screenshots',
    UPLOADS = 'uploads',
}

export async function uploadImageToCloudflareImages(env: Env, image: ImageAttachment, type: ImageType, bytes?: Uint8Array): Promise<string> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/images/v1`;

    const filename = `${image.id}-${type}-${image.filename}`;

    const data = bytes ?? base64ToUint8Array(image.base64Data!);
    const blob = new Blob([data], { type: image.mimeType });
    const form = new FormData();
    form.append('file', blob, filename);

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        body: form,
    });

    const json = await resp.json() as {
        success: boolean;
        result?: { id: string; variants?: string[] };
        errors?: Array<{ message?: string }>;
    };

    if (!resp.ok || !json.success || !json.result) {
        const errMsg = json.errors?.map(e => e.message).join('; ') || `status ${resp.status}`;
        throw new Error(`Cloudflare Images upload failed: ${errMsg}`);
    }

    const variants = json.result.variants || [];
    if (variants.length > 0) {
        // Prefer first variant URL
        return variants[0];
    }
    throw new Error('Cloudflare Images upload succeeded without variants');
}

export function getPublicUrlForR2Image(env: Env, r2Key: string): string {
    // The sandboxed standalone agent runtime does not receive CUSTOM_DOMAIN
    // in its process env (worker/services/sandbox/agentSandboxBoot.ts's
    // envVars), so getProtocolForHost(undefined) would throw there. Falling
    // back to a path-only URL is safe and correct: ScreenshotSecurity.signUrl
    // already treats any URL that isn't "http(s)://"-prefixed as relative and
    // returns it unchanged (aside from the signed query param), and the SPA
    // + /api/* are served from the same origin, so a relative path resolves
    // correctly in the browser regardless of which backend stored the bytes.
    if (!env.CUSTOM_DOMAIN) {
        return `/api/${r2Key}`;
    }
    const protocol = getProtocolForHost(env.CUSTOM_DOMAIN);
    const base = `${protocol}://${env.CUSTOM_DOMAIN}`;
    const url = `${base}/api/${r2Key}`;
    return url;
}

export async function uploadImageToR2(env: Env, image: ImageAttachment, type: ImageType, cfImagesUrl?: string, bytes?: Uint8Array): Promise<{ url: string; r2Key: string }> {
    const data = bytes ?? base64ToUint8Array(image.base64Data!);
    const r2Key = `${type}/${image.id}/${encodeURIComponent(image.filename)}`;
    await env.TEMPLATES_BUCKET.put(r2Key, data, { httpMetadata: { contentType: image.mimeType }, customMetadata: { "cfImagesUrl": cfImagesUrl || '' } });

    return { url: getPublicUrlForR2Image(env, r2Key), r2Key };
}

// ===============================
// Supabase Storage (new-stack image backend)
// ===============================

/**
 * Single Supabase Storage bucket backing both screenshot and upload images
 * on the standalone runtime, mirroring how `TEMPLATES_BUCKET` is one R2
 * bucket shared across image types on Workers (images are differentiated by
 * the `${type}/${id}/${filename}` key prefix, not by bucket). Must be
 * created in the Supabase project before screenshots work on the new stack.
 */
const SCREENSHOTS_BUCKET = 'screenshots';

/**
 * Minimal surface of a Supabase Storage bucket client this module depends
 * on, narrowed so tests can inject a fake without touching the network or
 * the real SDK. The real `StorageFileApi` returned by
 * `createClient(...).storage.from(bucket)` structurally satisfies this —
 * same narrowing approach as `SupabaseClientFactory` in
 * `worker/services/auth/supabaseAuth.ts`.
 */
interface SupabaseStorageBucketApi {
    upload(
        path: string,
        body: Uint8Array,
        options?: { upsert?: boolean; contentType?: string },
    ): Promise<{ data: { path: string } | null; error: { message: string } | null }>;
    download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
}

export type SupabaseStorageClientFactory = (
    url: string,
    serviceRoleKey: string,
) => {
    storage: {
        from(bucket: string): SupabaseStorageBucketApi;
    };
};

const defaultStorageClientFactory: SupabaseStorageClientFactory = (url, serviceRoleKey) => createClient(url, serviceRoleKey);

/**
 * True when image bytes should be stored in / read from Supabase Storage
 * rather than R2. Covers both non-Cloudflare runtimes:
 *   - the standalone agent runtime, where `isStandaloneRuntime(env)` is true
 *     and `env.TEMPLATES_BUCKET` is a truthy poison proxy (so a bare
 *     `!env.TEMPLATES_BUCKET` would miss it);
 *   - the Vercel/Node worker, where `isStandaloneRuntime(env)` is false but
 *     the R2 binding is genuinely absent (`env.TEMPLATES_BUCKET` undefined).
 * Real Cloudflare Workers have the binding and are not standalone, so they
 * keep using R2 — same binding-presence seam as the rate limiter
 * (worker/services/rate-limit/rateLimits.ts).
 */
function shouldUseSupabaseStorage(env: Env): boolean {
    return isStandaloneRuntime(env) || !env.TEMPLATES_BUCKET;
}

/**
 * Reads SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY without widening the
 * generated `Env` type — same indexed-cast precedent as `getSupabaseDbUrl`
 * (worker/database/pgConnection.ts) and `getConfigValue`
 * (worker/services/auth/supabaseAuth.ts). A service-role key (not the anon
 * key) is required: screenshot storage writes/reads run for any app
 * regardless of which user is browsing, so they must bypass Storage RLS.
 */
function getSupabaseStorageConfig(env: Env): { url: string; serviceRoleKey: string } {
    const source = env as unknown as Record<string, unknown>;
    const url = source.SUPABASE_URL;
    const serviceRoleKey = source.SUPABASE_SERVICE_ROLE_KEY;
    if (typeof url !== 'string' || url.length === 0) {
        throw new Error('SUPABASE_URL is not configured');
    }
    if (typeof serviceRoleKey !== 'string' || serviceRoleKey.length === 0) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    }
    return { url, serviceRoleKey };
}

/**
 * Uploads image bytes to Supabase Storage — the standalone runtime's sibling
 * to `uploadImageToR2`. Same key scheme (`${type}/${id}/${filename}`), so
 * the two backends are interchangeable from every caller's perspective.
 */
export async function uploadImageToSupabaseStorage(
    env: Env,
    image: ImageAttachment,
    type: ImageType,
    bytes?: Uint8Array,
    clientFactory: SupabaseStorageClientFactory = defaultStorageClientFactory,
): Promise<{ url: string; r2Key: string }> {
    const data = bytes ?? base64ToUint8Array(image.base64Data!);
    const key = `${type}/${image.id}/${encodeURIComponent(image.filename)}`;

    const { url: supabaseUrl, serviceRoleKey } = getSupabaseStorageConfig(env);
    const client = clientFactory(supabaseUrl, serviceRoleKey);
    const { error } = await client.storage.from(SCREENSHOTS_BUCKET).upload(key, data, {
        upsert: true,
        contentType: image.mimeType,
    });
    if (error) {
        throw new Error(`Supabase Storage upload failed: ${error.message}`);
    }

    return { url: getPublicUrlForR2Image(env, key), r2Key: key };
}

export async function uploadImage(
    env: Env,
    image: ImageAttachment,
    type: ImageType,
    storageClientFactory: SupabaseStorageClientFactory = defaultStorageClientFactory,
): Promise<ProcessedImageAttachment> {
    // Hash in parallel to uploads
    const hashPromise = hashImageB64url(image.base64Data!);
    // Compute bytes once for both CF Images and the storage backend
    const bytes = base64ToUint8Array(image.base64Data!);

    // Obtain CF Images URL first (when enabled) so we can pass it into R2 metadata
    let cfImagesUrl = '';
    if (env.USE_CLOUDFLARE_IMAGES) {
        try {
            cfImagesUrl = await uploadImageToCloudflareImages(env, image, type, bytes);
        } catch (err) {
            console.warn('Cloudflare Images upload failed, will try storage fallback', { error: err instanceof Error ? err.message : String(err), image, type });
        }
    }

    // Storage backend: Supabase Storage off Cloudflare (standalone runtime and
    // the Vercel/Node worker), R2 on real Workers — same seam as buildDrizzle()
    // in worker/database/pgConnection.ts.
    const { r2Key, url } = shouldUseSupabaseStorage(env)
        ? await uploadImageToSupabaseStorage(env, image, type, bytes, storageClientFactory)
        : await uploadImageToR2(env, image, type, cfImagesUrl, bytes);
    const hash = await hashPromise;

    return {
        ...image,
        publicUrl: cfImagesUrl || url,
        hash,
        mimeType: image.mimeType,
        r2Key,
    }
}

function sanitizeBase64Data(dataUrl: string): string {
    return dataUrl.replace(/^data:image\/\w+;base64,/, '');
}

export async function hashImageB64url(dataUrl: string): Promise<string> {
    // This is required for both hashing and uploading.
    const imageBuffer = Buffer.from(sanitizeBase64Data(dataUrl), 'base64');

    // Calculate the SHA-256 hash of the image data for a unique fingerprint.
    const hashBuffer = await crypto.subtle.digest('SHA-256', imageBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hash;
}

export async function imageToBase64(env: Env, image: ProcessedImageAttachment): Promise<string> {
    try {
        // If base64 data is not available, try to fetch it from the r2 key
        if (!image.base64Data) {
            const r2Key = image.r2Key;
            if (!r2Key) {
                throw new Error('No R2 key provided for image');
            }
            image = await downloadR2Image(env, r2Key);
        }
        return `data:${image.mimeType};base64,${image.base64Data}`;
    } catch (error) {
        console.error('Failed to convert image to base64:', error, image);
        return '';
    }
}

export async function imagesToBase64(env: Env, images: ProcessedImageAttachment[]): Promise<string[]> {
    return (await Promise.all(images.map(image => imageToBase64(env, image)))).filter((image) => image !== '');
}

export async function downloadR2Image(env: Env, r2Key: string) : Promise<ProcessedImageAttachment> {
    const response = await env.TEMPLATES_BUCKET.get(r2Key);
    if (!response || !response.body) {
        throw new Error('Failed to fetch image from R2');
    }
    const arrayBuffer = await response.arrayBuffer();
    const mimeType = response.httpMetadata!.contentType! as SupportedImageMimeType;
    const customMetadata = response.customMetadata;
    const cfImagesUrl = customMetadata?.cfImagesUrl;
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    // Get the filename and mimeType from response
    return {
        base64Data: sanitizeBase64Data(base64),
        r2Key,
        publicUrl: cfImagesUrl || getPublicUrlForR2Image(env, r2Key),
        hash: await hashImageB64url(base64),
        mimeType,    }
}

export interface StoredImageBytes {
    bytes: Uint8Array;
    contentType: string | null;
}

/**
 * Reads raw stored image bytes for a given storage key
 * (`${type}/${id}/${filename}`) — Supabase Storage on the standalone
 * runtime, R2 on Workers. Used by `ScreenshotsController.serveScreenshot` to
 * serve screenshot bytes directly, independent of which backend stored them.
 * Never throws for a missing object — returns `null`, mirroring R2's `.get()`
 * "returns null when absent" contract.
 */
export async function getScreenshotBytes(
    env: Env,
    key: string,
    clientFactory: SupabaseStorageClientFactory = defaultStorageClientFactory,
): Promise<StoredImageBytes | null> {
    if (shouldUseSupabaseStorage(env)) {
        const { url, serviceRoleKey } = getSupabaseStorageConfig(env);
        const client = clientFactory(url, serviceRoleKey);
        const { data, error } = await client.storage.from(SCREENSHOTS_BUCKET).download(key);
        if (error || !data) {
            return null;
        }
        const bytes = new Uint8Array(await data.arrayBuffer());
        return { bytes, contentType: data.type || null };
    }

    const obj = await env.TEMPLATES_BUCKET.get(key);
    if (!obj || !obj.body) {
        return null;
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    return { bytes, contentType: obj.httpMetadata?.contentType ?? null };
}
