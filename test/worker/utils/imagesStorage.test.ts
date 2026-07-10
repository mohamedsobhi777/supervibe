import { describe, expect, it } from 'vitest';
import {
    ImageType,
    getPublicUrlForR2Image,
    getScreenshotBytes,
    uploadImage,
    uploadImageToSupabaseStorage,
    type SupabaseStorageClientFactory,
} from 'worker/utils/images';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';
import type { ImageAttachment } from 'worker/types/image-attachment';

const SAMPLE_BASE64 = Buffer.from('fake-image-bytes-for-storage-abstraction-tests').toString('base64');

function makeImage(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
    return {
        id: 'app-123',
        filename: 'latest.png',
        mimeType: 'image/png',
        base64Data: SAMPLE_BASE64,
        ...overrides,
    };
}

function standaloneEnv(vars: Record<string, unknown> = {}): Env {
    return {
        [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
        SUPABASE_URL: 'https://project-ref.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        ...vars,
    } as unknown as Env;
}

interface RecordedUpload {
    bucket: string;
    path: string;
    body: Uint8Array;
    options?: { upsert?: boolean; contentType?: string };
}

interface RecordedDownload {
    bucket: string;
    path: string;
}

interface FakeStorage {
    factory: SupabaseStorageClientFactory;
    uploadCalls: RecordedUpload[];
    downloadCalls: RecordedDownload[];
    factoryCalls: Array<{ url: string; serviceRoleKey: string }>;
}

function makeFakeStorageFactory(opts?: {
    uploadError?: { message: string };
    downloadResult?: { data: Blob | null; error: { message: string } | null };
}): FakeStorage {
    const uploadCalls: RecordedUpload[] = [];
    const downloadCalls: RecordedDownload[] = [];
    const factoryCalls: Array<{ url: string; serviceRoleKey: string }> = [];

    const factory: SupabaseStorageClientFactory = (url, serviceRoleKey) => {
        factoryCalls.push({ url, serviceRoleKey });
        return {
            storage: {
                from(bucket: string) {
                    return {
                        async upload(path: string, body: Uint8Array, options?: { upsert?: boolean; contentType?: string }) {
                            uploadCalls.push({ bucket, path, body, options });
                            if (opts?.uploadError) {
                                return { data: null, error: opts.uploadError };
                            }
                            return { data: { path }, error: null };
                        },
                        async download(path: string) {
                            downloadCalls.push({ bucket, path });
                            if (opts?.downloadResult) {
                                return opts.downloadResult;
                            }
                            return { data: null, error: { message: 'not found' } };
                        },
                    };
                },
            },
        };
    };

    return { factory, uploadCalls, downloadCalls, factoryCalls };
}

interface FakeR2Entry {
    data: Uint8Array;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
}

interface FakeR2Bucket {
    putCalls: Array<{ key: string; data: Uint8Array; options?: unknown }>;
    put(key: string, data: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<void>;
    get(key: string): Promise<{
        body: object;
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
        arrayBuffer(): Promise<ArrayBuffer>;
    } | null>;
}

function makeFakeR2Bucket(seed: Record<string, FakeR2Entry> = {}): FakeR2Bucket {
    const store = new Map<string, FakeR2Entry>(Object.entries(seed));
    const putCalls: Array<{ key: string; data: Uint8Array; options?: unknown }> = [];

    return {
        putCalls,
        async put(key, data, options) {
            putCalls.push({ key, data, options });
            store.set(key, { data, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
        },
        async get(key) {
            const entry = store.get(key);
            if (!entry) return null;
            return {
                body: {},
                httpMetadata: entry.httpMetadata,
                customMetadata: entry.customMetadata,
                async arrayBuffer() {
                    return entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength) as ArrayBuffer;
                },
            };
        },
    };
}

function workersEnv(bucket: FakeR2Bucket, vars: Record<string, unknown> = {}): Env {
    return {
        TEMPLATES_BUCKET: bucket,
        CUSTOM_DOMAIN: 'app.example.com',
        ...vars,
    } as unknown as Env;
}

function vercelWorkerEnv(vars: Record<string, unknown> = {}): Env {
    // Vercel/Node worker: not the standalone runtime (no RUNTIME_MODE marker)
    // AND no TEMPLATES_BUCKET R2 binding — so image storage must fall back to
    // Supabase, same as the standalone runtime does.
    return {
        SUPABASE_URL: 'https://project-ref.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        ...vars,
    } as unknown as Env;
}

describe('uploadImageToSupabaseStorage', () => {
    it('uploads to the screenshots bucket under the ${type}/${id}/${filename} key with upsert', async () => {
        const { factory, uploadCalls, factoryCalls } = makeFakeStorageFactory();
        const env = standaloneEnv();
        const image = makeImage();

        const result = await uploadImageToSupabaseStorage(env, image, ImageType.SCREENSHOTS, undefined, factory);

        expect(uploadCalls).toHaveLength(1);
        expect(uploadCalls[0].bucket).toBe('screenshots');
        expect(uploadCalls[0].path).toBe('screenshots/app-123/latest.png');
        expect(uploadCalls[0].options).toEqual({ upsert: true, contentType: 'image/png' });
        expect(result.r2Key).toBe('screenshots/app-123/latest.png');
        expect(factoryCalls[0]).toEqual({ url: 'https://project-ref.supabase.co', serviceRoleKey: 'service-role-key' });
    });

    it('uses the uploads key prefix for ImageType.UPLOADS while still targeting the screenshots bucket', async () => {
        const { factory, uploadCalls } = makeFakeStorageFactory();
        const env = standaloneEnv();
        const image = makeImage({ id: 'img-456', filename: 'photo.jpg', mimeType: 'image/jpeg' });

        await uploadImageToSupabaseStorage(env, image, ImageType.UPLOADS, undefined, factory);

        expect(uploadCalls[0].bucket).toBe('screenshots');
        expect(uploadCalls[0].path).toBe('uploads/img-456/photo.jpg');
    });

    it('throws a descriptive error when the Supabase Storage upload fails', async () => {
        const { factory } = makeFakeStorageFactory({ uploadError: { message: 'bucket does not exist' } });
        const env = standaloneEnv();
        const image = makeImage();

        await expect(uploadImageToSupabaseStorage(env, image, ImageType.SCREENSHOTS, undefined, factory))
            .rejects.toThrow(/Supabase Storage upload failed: bucket does not exist/);
    });

    it('throws when SUPABASE_SERVICE_ROLE_KEY is not configured', async () => {
        const { factory } = makeFakeStorageFactory();
        const env = standaloneEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined });
        const image = makeImage();

        await expect(uploadImageToSupabaseStorage(env, image, ImageType.SCREENSHOTS, undefined, factory))
            .rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY is not configured/);
    });
});

describe('uploadImage', () => {
    it('resolves to Supabase Storage on the standalone runtime', async () => {
        const { factory, uploadCalls } = makeFakeStorageFactory();
        const env = standaloneEnv();
        const image = makeImage();

        const result = await uploadImage(env, image, ImageType.SCREENSHOTS, factory);

        expect(uploadCalls).toHaveLength(1);
        expect(result.r2Key).toBe('screenshots/app-123/latest.png');
        // No CUSTOM_DOMAIN in the standalone env fixture -> relative fallback.
        expect(result.publicUrl).toBe('/api/screenshots/app-123/latest.png');
    });

    it('resolves to Supabase Storage on the Vercel worker when the R2 binding is absent', async () => {
        const { factory, uploadCalls } = makeFakeStorageFactory();
        const env = vercelWorkerEnv();
        const image = makeImage();

        const result = await uploadImage(env, image, ImageType.SCREENSHOTS, factory);

        expect(uploadCalls).toHaveLength(1);
        expect(uploadCalls[0].bucket).toBe('screenshots');
        expect(result.r2Key).toBe('screenshots/app-123/latest.png');
    });

    it('still resolves to R2 on Workers when the TEMPLATES_BUCKET binding is present', async () => {
        const bucket = makeFakeR2Bucket();
        const env = workersEnv(bucket);
        const image = makeImage();

        const result = await uploadImage(env, image, ImageType.SCREENSHOTS);

        expect(bucket.putCalls).toHaveLength(1);
        expect(bucket.putCalls[0].key).toBe('screenshots/app-123/latest.png');
        expect(result.r2Key).toBe('screenshots/app-123/latest.png');
        expect(result.publicUrl).toBe('https://app.example.com/api/screenshots/app-123/latest.png');
    });
});

describe('getScreenshotBytes', () => {
    it('downloads and returns bytes + content-type from Supabase Storage on the standalone runtime', async () => {
        const original = new Uint8Array([10, 20, 30, 40, 50]);
        const blob = new Blob([original], { type: 'image/png' });
        const { factory, downloadCalls } = makeFakeStorageFactory({ downloadResult: { data: blob, error: null } });
        const env = standaloneEnv();

        const result = await getScreenshotBytes(env, 'screenshots/app-123/latest.png', factory);

        expect(downloadCalls).toEqual([{ bucket: 'screenshots', path: 'screenshots/app-123/latest.png' }]);
        expect(result).not.toBeNull();
        expect(Array.from(result!.bytes)).toEqual(Array.from(original));
        expect(result!.contentType).toBe('image/png');
    });

    it('returns null when Supabase Storage reports an error or no data', async () => {
        const { factory } = makeFakeStorageFactory({ downloadResult: { data: null, error: { message: 'not found' } } });
        const env = standaloneEnv();

        const result = await getScreenshotBytes(env, 'screenshots/missing/latest.png', factory);

        expect(result).toBeNull();
    });

    it('round-trips bytes + content-type through R2 on Workers', async () => {
        const original = new Uint8Array([1, 2, 3]);
        const bucket = makeFakeR2Bucket({
            'screenshots/app-123/latest.png': { data: original, httpMetadata: { contentType: 'image/png' } },
        });
        const env = workersEnv(bucket);

        const result = await getScreenshotBytes(env, 'screenshots/app-123/latest.png');

        expect(result).not.toBeNull();
        expect(Array.from(result!.bytes)).toEqual(Array.from(original));
        expect(result!.contentType).toBe('image/png');
    });

    it('returns null when the key does not exist in R2', async () => {
        const bucket = makeFakeR2Bucket();
        const env = workersEnv(bucket);

        const result = await getScreenshotBytes(env, 'screenshots/missing/latest.png');

        expect(result).toBeNull();
    });

    it('reads from Supabase Storage on the Vercel worker when the R2 binding is absent', async () => {
        const original = new Uint8Array([7, 8, 9]);
        const blob = new Blob([original], { type: 'image/png' });
        const { factory, downloadCalls } = makeFakeStorageFactory({ downloadResult: { data: blob, error: null } });
        const env = vercelWorkerEnv();

        const result = await getScreenshotBytes(env, 'screenshots/app-123/latest.png', factory);

        expect(downloadCalls).toEqual([{ bucket: 'screenshots', path: 'screenshots/app-123/latest.png' }]);
        expect(result).not.toBeNull();
        expect(Array.from(result!.bytes)).toEqual(Array.from(original));
    });
});

describe('getPublicUrlForR2Image', () => {
    it('builds an absolute URL when CUSTOM_DOMAIN is configured', () => {
        const env = { CUSTOM_DOMAIN: 'app.example.com' } as unknown as Env;
        expect(getPublicUrlForR2Image(env, 'screenshots/app-123/latest.png')).toBe(
            'https://app.example.com/api/screenshots/app-123/latest.png',
        );
    });

    it('falls back to a relative path when CUSTOM_DOMAIN is absent (standalone runtime)', () => {
        const env = {} as unknown as Env;
        expect(getPublicUrlForR2Image(env, 'screenshots/app-123/latest.png')).toBe(
            '/api/screenshots/app-123/latest.png',
        );
    });
});
