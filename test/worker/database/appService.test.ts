import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { AppService } from 'worker/database/services/AppService';
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
 * Also covers favorites/stars, ported back to Postgres in
 * supabase/migrations/20260709000001_favorites_stars.sql:
 * `toggleAppFavorite`, `toggleAppStar`, `getFavoriteAppsOnly`, and the
 * `sort=starred` branches of `getUserAppsWithAnalytics`/`getUserAppsCount`,
 * which used to throw `DeferredInPhase2aError` and now resolve normally.
 * `appViews` remains deferred - `recordAppView` stays a documented
 * fail-safe no-op rather than a throw.
 */

type Row = Record<string, unknown>;

interface RecordedCall {
    entry: 'select' | 'insert' | 'update' | 'delete';
    args: unknown[];
    chainCalls: { method: string; args: unknown[] }[];
}

const CHAIN_METHODS = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset', 'values', 'set', 'returning', 'groupBy', 'onConflictDoNothing'] as const;

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
        it('lists apps owned by the user with real isFavorite from the favorites table', async () => {
            const app1 = fakeApp({ id: 'app-1', title: 'First' });
            const app2 = fakeApp({ id: 'app-2', title: 'Second' });
            // Second query returns only app-1's favorites row.
            const { service, calls } = createAppServiceWithFakeDb([[app1, app2], [{ appId: 'app-1' }]]);

            const result = await service.getUserAppsWithFavorites('user-1', { limit: 10, offset: 0 });

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({ id: 'app-1', isFavorite: true });
            expect(result[1]).toMatchObject({ id: 'app-2', isFavorite: false });

            expect(calls).toHaveLength(2);
            expect(calls[0].entry).toBe('select');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'orderBy', 'limit', 'offset']);

            expect(calls[1].entry).toBe('select');
            const favoritesFrom = calls[1].chainCalls.find((c) => c.method === 'from');
            expect(tableName(favoritesFrom?.args[0])).toBe('favorites');
        });

        it('returns an empty array without a second query when the user has no apps', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[]]);

            const result = await service.getUserAppsWithFavorites('user-1');

            expect(result).toEqual([]);
            expect(calls).toHaveLength(1);
        });
    });

    describe('toggleAppFavorite', () => {
        it('inserts a favorites row when none exists yet (favorite)', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[]]);

            const result = await service.toggleAppFavorite('user-1', 'app-1');

            expect(result).toEqual({ isFavorite: true });
            expect(calls).toHaveLength(2);

            expect(calls[0].entry).toBe('select');
            const selectFrom = calls[0].chainCalls.find((c) => c.method === 'from');
            expect(tableName(selectFrom?.args[0])).toBe('favorites');

            expect(calls[1].entry).toBe('insert');
            expect(tableName(calls[1].args[0])).toBe('favorites');
            expect(calls[1].chainCalls.map((c) => c.method)).toEqual(['values', 'onConflictDoNothing']);
            expect(calls[1].chainCalls[0].args[0]).toEqual({ userId: 'user-1', appId: 'app-1' });
        });

        it('deletes the favorites row when one already exists (unfavorite)', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[{ userId: 'user-1' }]]);

            const result = await service.toggleAppFavorite('user-1', 'app-1');

            expect(result).toEqual({ isFavorite: false });
            expect(calls).toHaveLength(2);
            expect(calls[1].entry).toBe('delete');
            expect(tableName(calls[1].args[0])).toBe('favorites');
        });
    });

    describe('toggleAppStar', () => {
        it('inserts a stars row and returns the new count when none exists yet (star)', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[], [], [{ count: 1 }]]);

            const result = await service.toggleAppStar('user-1', 'app-1');

            expect(result).toEqual({ isStarred: true, starCount: 1 });
            expect(calls).toHaveLength(3);

            expect(calls[0].entry).toBe('select');
            const existsFrom = calls[0].chainCalls.find((c) => c.method === 'from');
            expect(tableName(existsFrom?.args[0])).toBe('stars');

            expect(calls[1].entry).toBe('insert');
            expect(tableName(calls[1].args[0])).toBe('stars');
            expect(calls[1].chainCalls.map((c) => c.method)).toEqual(['values', 'onConflictDoNothing']);

            expect(calls[2].entry).toBe('select');
            const countFrom = calls[2].chainCalls.find((c) => c.method === 'from');
            expect(tableName(countFrom?.args[0])).toBe('stars');
        });

        it('deletes the stars row and returns the new count when one already exists (unstar)', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[{ userId: 'user-1' }], [], [{ count: 4 }]]);

            const result = await service.toggleAppStar('user-1', 'app-1');

            expect(result).toEqual({ isStarred: false, starCount: 4 });
            expect(calls[1].entry).toBe('delete');
            expect(tableName(calls[1].args[0])).toBe('stars');
        });

        it('returns starCount 0 when the count query returns no row', async () => {
            const { service } = createAppServiceWithFakeDb([[], [], []]);

            const result = await service.toggleAppStar('user-1', 'app-1');

            expect(result).toEqual({ isStarred: true, starCount: 0 });
        });
    });

    describe('getFavoriteAppsOnly', () => {
        it('joins favorites to apps and marks every row isFavorite=true', async () => {
            const app1 = fakeApp({ id: 'app-1', title: 'Favorited One' });
            const app2 = fakeApp({ id: 'app-2', title: 'Favorited Two' });
            const { service, calls } = createAppServiceWithFakeDb([[{ app: app1 }, { app: app2 }]]);

            const result = await service.getFavoriteAppsOnly('user-1');

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({ id: 'app-1', isFavorite: true });
            expect(result[1]).toMatchObject({ id: 'app-2', isFavorite: true });

            expect(calls).toHaveLength(1);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']);
            const fromCall = calls[0].chainCalls.find((c) => c.method === 'from');
            expect(tableName(fromCall?.args[0])).toBe('favorites');
            const joinCall = calls[0].chainCalls.find((c) => c.method === 'innerJoin');
            expect(tableName(joinCall?.args[0])).toBe('apps');
        });

        it('returns an empty array when the user has no favorites', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[]]);

            const result = await service.getFavoriteAppsOnly('user-1');

            expect(result).toEqual([]);
            expect(calls).toHaveLength(1);
        });
    });

    describe('sort=starred (favorites/stars now ported)', () => {
        it('getUserAppsWithAnalytics resolves (no longer throws) for sort=starred', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[]]);
            await expect(service.getUserAppsWithAnalytics('user-1', { sort: 'starred' })).resolves.toEqual([]);
            expect(calls).toHaveLength(1);
        });

        it('getUserAppsCount resolves (no longer throws) for sort=starred', async () => {
            const { service } = createAppServiceWithFakeDb([[{ count: 5 }]]);
            await expect(service.getUserAppsCount('user-1', { sort: 'starred' })).resolves.toBe(5);
        });
    });

    describe('recordAppView (appViews table still deferred in 2a)', () => {
        it('is a fail-safe no-op, not a throw', async () => {
            const { service, calls } = createAppServiceWithFakeDb([]);
            await expect(service.recordAppView('app-1', 'user-1')).resolves.toBeUndefined();
            expect(calls).toHaveLength(0);
        });
    });

    describe('getSingleAppWithFavoriteStatus (isFavorite now wired to the favorites table)', () => {
        it('returns isFavorite=true when a favorites row exists for (userId, appId)', async () => {
            const app = fakeApp({ id: 'app-1' });
            const { service, calls } = createAppServiceWithFakeDb([[app], [{ appId: 'app-1' }]]);

            const result = await service.getSingleAppWithFavoriteStatus('app-1', 'user-1');

            expect(result).toMatchObject({ id: 'app-1', isFavorite: true });
            expect(calls).toHaveLength(2);
            expect(calls[1].entry).toBe('select');
            const favoritesFrom = calls[1].chainCalls.find((c) => c.method === 'from');
            expect(tableName(favoritesFrom?.args[0])).toBe('favorites');
        });

        it('returns isFavorite=false when no favorites row exists', async () => {
            const app = fakeApp({ id: 'app-1' });
            const { service } = createAppServiceWithFakeDb([[app], []]);

            const result = await service.getSingleAppWithFavoriteStatus('app-1', 'user-1');

            expect(result).toMatchObject({ id: 'app-1', isFavorite: false });
        });

        it('returns null without querying favorites when the app is not found', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[]]);

            const result = await service.getSingleAppWithFavoriteStatus('missing-app', 'user-1');

            expect(result).toBeNull();
            expect(calls).toHaveLength(1);
        });
    });

    describe('getAppDetails (starCount/userStarred/userFavorited now wired to stars/favorites)', () => {
        it('returns the real starCount and false userStarred/userFavorited for an anonymous viewer', async () => {
            const app = fakeApp({ id: 'app-1' });
            const { service, calls } = createAppServiceWithFakeDb([
                [{ app, userName: 'Alice', userAvatar: null, starCount: 3 }],
            ]);

            const result = await service.getAppDetails('app-1');

            expect(result).toMatchObject({
                id: 'app-1',
                starCount: 3,
                userStarred: false,
                userFavorited: false,
                viewCount: 0,
            });
            // No userId -> addUserSpecificAppData short-circuits with no
            // additional stars/favorites queries.
            expect(calls).toHaveLength(1);
        });

        it('returns real userStarred/userFavorited for an authenticated viewer', async () => {
            const app = fakeApp({ id: 'app-1' });
            const { service, calls } = createAppServiceWithFakeDb([
                [{ app, userName: 'Alice', userAvatar: null, starCount: 5 }],
                [{ appId: 'app-1' }], // getUserStarredAppIds
                [], // getUserFavoriteAppIds
            ]);

            const result = await service.getAppDetails('app-1', 'user-1');

            expect(result).toMatchObject({
                id: 'app-1',
                starCount: 5,
                userStarred: true,
                userFavorited: false,
            });
            expect(calls).toHaveLength(3);
            const starsFrom = calls[1].chainCalls.find((c) => c.method === 'from');
            expect(tableName(starsFrom?.args[0])).toBe('stars');
            const favoritesFrom = calls[2].chainCalls.find((c) => c.method === 'from');
            expect(tableName(favoritesFrom?.args[0])).toBe('favorites');
        });

        it('returns null without querying stars/favorites when the app is not found', async () => {
            const { service, calls } = createAppServiceWithFakeDb([[]]);

            const result = await service.getAppDetails('missing-app', 'user-1');

            expect(result).toBeNull();
            expect(calls).toHaveLength(1);
        });

        it('defaults starCount to 0 when the subquery returns no value', async () => {
            const app = fakeApp({ id: 'app-1' });
            const { service } = createAppServiceWithFakeDb([
                [{ app, userName: null, userAvatar: null, starCount: 0 }],
            ]);

            const result = await service.getAppDetails('app-1');

            expect(result).toMatchObject({ starCount: 0 });
        });
    });
});
