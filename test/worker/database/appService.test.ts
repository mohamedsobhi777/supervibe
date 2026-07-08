import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { AppService, DeferredInPhase2aError } from 'worker/database/services/AppService';
import * as schema from 'worker/database/schema';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';

/**
 * `@cloudflare/vitest-pool-workers` does not dedupe a file reached via the
 * `worker/*` alias (this test file's `import ... from 'worker/database/schema'`)
 * against the same file reached via a relative import (AppService's
 * `import ... from '../schema'`): the two resolve to structurally-identical
 * but referentially distinct module instances. So table identity is
 * asserted by name via `getTableConfig(...)`, not `toBe(schema.apps)`.
 */
function tableName(table: unknown): string {
    return getTableConfig(table as PgTable).name;
}

/**
 * Unit tests for the Postgres port of AppService (option (a) from the
 * task brief: a fake drizzle/db that records the built queries and
 * returns canned rows, rather than a live Supabase/Postgres connection,
 * so these run without Docker).
 *
 * Covers the brief's create -> get -> update -> list-by-user sequence
 * mapped onto AppService's real method names (it has no literal
 * `getApp`/`getById`/`listByUser`):
 *   - createApp        -> createApp
 *   - getApp/getById   -> checkAppOwnership (single-row read by id)
 *   - updateDeploymentId -> updateDeploymentId
 *   - listByUser       -> getUserAppsWithFavorites
 *
 * Also covers the phase-2a "deferred" contract: methods/branches that
 * depend on the favorites/stars/appViews tables (dropped in the lean
 * 7-table Postgres schema rewrite) throw `DeferredInPhase2aError`, except
 * `recordAppView`, which is a documented fail-safe no-op.
 */

type Row = Record<string, unknown>;

interface RecordedCall {
    entry: 'select' | 'insert' | 'update' | 'delete';
    args: unknown[];
    chainCalls: { method: string; args: unknown[] }[];
}

const CHAIN_METHODS = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset', 'values', 'set', 'returning', 'groupBy'] as const;

/**
 * Minimal fake drizzle query builder. Every chain method records its call
 * and returns itself; the chain resolves - via `.then`/`.catch`, matching
 * drizzle's thenable query builders - to a canned row array pulled off a
 * FIFO queue, one entry per top-level `.select()/.insert()/.update()/
 * .delete()` call, in the order AppService issues them.
 */
function createFakeDb(queue: Row[][]) {
    const calls: RecordedCall[] = [];
    let cursor = 0;

    function nextRows(): Row[] {
        const rows = queue[cursor] ?? [];
        cursor += 1;
        return rows;
    }

    function makeChain(rows: Row[], record: RecordedCall) {
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

    function entryPoint(entry: RecordedCall['entry']) {
        return (...args: unknown[]) => {
            const record: RecordedCall = { entry, args, chainCalls: [] };
            calls.push(record);
            return makeChain(nextRows(), record);
        };
    }

    const db = {
        select: entryPoint('select'),
        insert: entryPoint('insert'),
        update: entryPoint('update'),
        delete: entryPoint('delete'),
    };

    return { db, calls };
}

const FAKE_ENV = {
    JWT_SECRET: 'test-jwt-secret-for-appservice-tests',
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

/**
 * Constructs a real AppService (via the standalone-runtime env, so the
 * constructor's `buildDrizzle` never dials a real Postgres connection),
 * then swaps its internal `DatabaseService` handle for the fake above.
 */
function createAppServiceWithFakeDb(queue: Row[][]) {
    const service = new AppService(FAKE_ENV);
    const { db, calls } = createFakeDb(queue);
    (service as unknown as { db: { db: unknown; getReadDb: () => unknown } }).db = {
        db,
        getReadDb: () => db,
    };
    return { service, calls };
}

function fakeApp(overrides: Partial<Row> = {}): Row {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'app-1',
        title: 'Test App',
        description: null,
        iconUrl: null,
        originalPrompt: 'build me an app',
        finalPrompt: null,
        framework: 'react',
        userId: 'user-1',
        sessionToken: null,
        visibility: 'private',
        status: 'completed',
        deploymentId: null,
        githubRepositoryUrl: null,
        githubRepositoryVisibility: null,
        isArchived: false,
        isFeatured: false,
        version: 1,
        parentAppId: null,
        screenshotUrl: null,
        screenshotCapturedAt: null,
        createdAt: now,
        updatedAt: now,
        lastDeployedAt: null,
        ...overrides,
    };
}

describe('AppService (postgres)', () => {
    describe('createApp', () => {
        it('inserts into the apps table and returns the created row', async () => {
            const created = fakeApp({ id: 'app-new' });
            const { service, calls } = createAppServiceWithFakeDb([[created]]);

            const result = await service.createApp({
                id: 'app-new',
                title: 'Test App',
                originalPrompt: 'build me an app',
                userId: 'user-1',
            });

            expect(result).toEqual(created);
            expect(calls).toHaveLength(1);
            expect(calls[0].entry).toBe('insert');
            expect(tableName(calls[0].args[0])).toBe('apps');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['values', 'returning']);
        });
    });

    describe('checkAppOwnership (getApp/getById analog)', () => {
        it('returns exists+isOwner+visibility for an app the caller owns', async () => {
            const row = { id: 'app-1', userId: 'user-1', visibility: 'private' };
            const { service, calls } = createAppServiceWithFakeDb([[row]]);

            const result = await service.checkAppOwnership('app-1', 'user-1');

            expect(result).toEqual({ exists: true, isOwner: true, visibility: 'private' });
            expect(calls[0].entry).toBe('select');
            expect(calls[0].chainCalls.some((c) => c.method === 'limit' && c.args[0] === 1)).toBe(true);
        });

        it('returns isOwner=false when a different user owns the app', async () => {
            const row = { id: 'app-1', userId: 'someone-else', visibility: 'public' };
            const { service } = createAppServiceWithFakeDb([[row]]);

            const result = await service.checkAppOwnership('app-1', 'user-1');

            expect(result).toEqual({ exists: true, isOwner: false, visibility: 'public' });
        });

        it('returns exists=false when no app row is found', async () => {
            const { service } = createAppServiceWithFakeDb([[]]);

            const result = await service.checkAppOwnership('missing-app', 'user-1');

            expect(result).toEqual({ exists: false, isOwner: false });
        });
    });

    describe('updateDeploymentId', () => {
        it('updates the apps table with the given deploymentId', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[]]);

            const result = await service.updateDeploymentId('app-1', 'deployment-123');

            expect(result).toBe(true);
            expect(calls[0].entry).toBe('update');
            expect(tableName(calls[0].args[0])).toBe('apps');
            const setCall = calls[0].chainCalls.find((c) => c.method === 'set');
            expect(setCall?.args[0]).toMatchObject({ deploymentId: 'deployment-123' });
        });

        it('returns false without querying when appId is empty', async () => {
            const { service, calls } = createAppServiceWithFakeDb([]);

            const result = await service.updateDeploymentId('', 'deployment-123');

            expect(result).toBe(false);
            expect(calls).toHaveLength(0);
        });
    });

    describe('getUserAppsWithFavorites (listByUser)', () => {
        it('lists apps owned by the user with isFavorite stubbed false', async () => {
            const app1 = fakeApp({ id: 'app-1', title: 'First' });
            const app2 = fakeApp({ id: 'app-2', title: 'Second' });
            const { service, calls } = createAppServiceWithFakeDb([[app1, app2]]);

            const result = await service.getUserAppsWithFavorites('user-1', { limit: 10, offset: 0 });

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({ id: 'app-1', isFavorite: false });
            expect(result[1]).toMatchObject({ id: 'app-2', isFavorite: false });
            expect(calls[0].entry).toBe('select');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'orderBy', 'limit', 'offset']);
            // Only one query - the (now-dropped) favorites lookup no longer runs.
            expect(calls).toHaveLength(1);
        });

        it('returns an empty array without a second query when the user has no apps', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[]]);

            const result = await service.getUserAppsWithFavorites('user-1');

            expect(result).toEqual([]);
            expect(calls).toHaveLength(1);
        });
    });

    describe('deferred-in-2a stubs (favorites/stars/appViews tables not yet ported)', () => {
        it('toggleAppFavorite throws DeferredInPhase2aError', async () => {
            const { service } = createAppServiceWithFakeDb([]);
            await expect(service.toggleAppFavorite('user-1', 'app-1')).rejects.toThrow(DeferredInPhase2aError);
        });

        it('toggleAppStar throws DeferredInPhase2aError', async () => {
            const { service } = createAppServiceWithFakeDb([]);
            await expect(service.toggleAppStar('user-1', 'app-1')).rejects.toThrow(DeferredInPhase2aError);
        });

        it('getFavoriteAppsOnly throws DeferredInPhase2aError', async () => {
            const { service } = createAppServiceWithFakeDb([]);
            await expect(service.getFavoriteAppsOnly('user-1')).rejects.toThrow(DeferredInPhase2aError);
        });

        it('getUserAppsWithAnalytics throws for sort=starred but resolves normally for sort=recent', async () => {
            const { service: starredService } = createAppServiceWithFakeDb([]);
            await expect(starredService.getUserAppsWithAnalytics('user-1', { sort: 'starred' }))
                .rejects.toThrow(DeferredInPhase2aError);

            const { service: recentService, calls } = createAppServiceWithFakeDb([[]]);
            await expect(recentService.getUserAppsWithAnalytics('user-1', { sort: 'recent' })).resolves.toEqual([]);
            expect(calls).toHaveLength(1);
        });

        it('getUserAppsCount throws for sort=starred but resolves normally for sort=recent', async () => {
            const { service: starredService } = createAppServiceWithFakeDb([]);
            await expect(starredService.getUserAppsCount('user-1', { sort: 'starred' }))
                .rejects.toThrow(DeferredInPhase2aError);

            const { service: recentService } = createAppServiceWithFakeDb([[{ count: 3 }]]);
            await expect(recentService.getUserAppsCount('user-1', { sort: 'recent' })).resolves.toBe(3);
        });

        it('recordAppView is a fail-safe no-op, not a throw', async () => {
            const { service, calls } = createAppServiceWithFakeDb([]);
            await expect(service.recordAppView('app-1', 'user-1')).resolves.toBeUndefined();
            expect(calls).toHaveLength(0);
        });
    });
});
