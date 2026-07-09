import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { SystemSettingsService } from 'worker/database/services/SystemSettingsService';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';

/**
 * `@cloudflare/vitest-pool-workers` does not dedupe a file reached via the
 * `worker/*` alias (this test file's `import ... from 'worker/database/...'`)
 * against the same file reached via a relative import (the service's
 * `import ... from '../schema'`): the two resolve to structurally-identical
 * but referentially distinct module instances. So table identity is
 * asserted by name via `getTableConfig(...)`, not `toBe(schema.systemSettings)`.
 * Same gotcha documented in `test/worker/database/appService.test.ts`.
 */
function tableName(table: unknown): string {
    return getTableConfig(table as PgTable).name;
}

/**
 * Unit tests for the Postgres-backed `SystemSettingsService`, the read
 * seam `worker/config/index.ts` uses in place of the old
 * `env.VibecoderStore` (Cloudflare KV) reads. Uses a fake drizzle/db that
 * records the built query and returns canned rows (the same technique as
 * `test/worker/database/appService.test.ts` and
 * `test/worker/database/agentSessionService.test.ts`), so these run
 * without Docker/a live Postgres connection.
 */

type Row = Record<string, unknown>;

interface RecordedCall {
    entry: 'select';
    args: unknown[];
    chainCalls: { method: string; args: unknown[] }[];
}

const CHAIN_METHODS = ['from', 'where', 'limit'] as const;

function createFakeDb(rows: Row[]) {
    const calls: RecordedCall[] = [];

    function makeChain(record: RecordedCall) {
        const chain: Record<string, unknown> = {};
        for (const method of CHAIN_METHODS) {
            chain[method] = (...args: unknown[]) => {
                record.chainCalls.push({ method, args });
                return chain;
            };
        }
        chain.then = (onFulfilled?: (v: Row[]) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(onFulfilled, onRejected);
        chain.catch = (onRejected?: (e: unknown) => unknown) => Promise.resolve(rows).catch(onRejected);
        return chain;
    }

    const db = {
        select: (...args: unknown[]) => {
            const record: RecordedCall = { entry: 'select', args, chainCalls: [] };
            calls.push(record);
            return makeChain(record);
        },
    };

    return { db, calls };
}

/** Fake db whose `select()` throws synchronously, simulating a connection/query failure. */
function createThrowingFakeDb(error: unknown) {
    return {
        db: {
            select: () => {
                throw error;
            },
        },
    };
}

const FAKE_ENV = {
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

/**
 * Constructs a real SystemSettingsService (via the standalone-runtime env,
 * so the constructor's `buildDrizzle` never dials a real Postgres
 * connection), then swaps its internal `DatabaseService` handle for the
 * fake above.
 */
function createServiceWithFakeDb(rows: Row[]) {
    const service = new SystemSettingsService(FAKE_ENV);
    const { db, calls } = createFakeDb(rows);
    (service as unknown as { db: { db: unknown; getReadDb: () => unknown } }).db = {
        db,
        getReadDb: () => db,
    };
    return { service, calls };
}

function createServiceWithThrowingDb(error: unknown) {
    const service = new SystemSettingsService(FAKE_ENV);
    const { db } = createThrowingFakeDb(error);
    (service as unknown as { db: { db: unknown; getReadDb: () => unknown } }).db = {
        db,
        getReadDb: () => db,
    };
    return service;
}

describe('SystemSettingsService (postgres)', () => {
    describe('getByKey', () => {
        it('selects value from system_settings filtered by key, limited to 1 row', async () => {
            const { service, calls } = createServiceWithFakeDb([
                { value: { globalMessaging: { globalUserMessage: 'hi' } } },
            ]);

            const result = await service.getByKey('platform_configs');

            expect(result).toEqual({ globalMessaging: { globalUserMessage: 'hi' } });
            expect(calls).toHaveLength(1);
            expect(calls[0].entry).toBe('select');
            const fromCall = calls[0].chainCalls.find((c) => c.method === 'from');
            expect(tableName(fromCall?.args[0])).toBe('system_settings');
            expect(calls[0].chainCalls.some((c) => c.method === 'where')).toBe(true);
            expect(calls[0].chainCalls.some((c) => c.method === 'limit' && c.args[0] === 1)).toBe(true);
        });

        it('returns null when no row matches the key', async () => {
            const { service } = createServiceWithFakeDb([]);

            const result = await service.getByKey('platform_configs');

            expect(result).toBeNull();
        });

        it('returns null when the stored value is a JSON array (not a plain object)', async () => {
            const { service } = createServiceWithFakeDb([{ value: ['not', 'an', 'object'] }]);

            const result = await service.getByKey('platform_configs');

            expect(result).toBeNull();
        });

        it('returns null when the stored value is a JSON string (not a plain object)', async () => {
            const { service } = createServiceWithFakeDb([{ value: 'just-a-string' }]);

            const result = await service.getByKey('platform_configs');

            expect(result).toBeNull();
        });

        it('returns null when the stored value is a JSON number (not a plain object)', async () => {
            const { service } = createServiceWithFakeDb([{ value: 42 }]);

            const result = await service.getByKey('platform_configs');

            expect(result).toBeNull();
        });

        it('returns null when the stored value is SQL NULL', async () => {
            const { service } = createServiceWithFakeDb([{ value: null }]);

            const result = await service.getByKey('platform_configs');

            expect(result).toBeNull();
        });

        it('returns null instead of throwing when the query fails', async () => {
            const service = createServiceWithThrowingDb(new Error('connection refused'));

            await expect(service.getByKey('platform_configs')).resolves.toBeNull();
        });

        it('resolves to null (never throws) under the standalone runtime no-op Postgres client', async () => {
            // No fake db swap here - exercises the real noopPg path used by
            // the standalone agent runtime (worker/database/noopPg.ts),
            // which resolves every select to an empty row array.
            const service = new SystemSettingsService(FAKE_ENV);

            await expect(service.getByKey('platform_configs')).resolves.toBeNull();
        });
    });
});
