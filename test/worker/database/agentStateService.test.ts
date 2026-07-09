import { describe, expect, it, vi } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { AgentStateService } from 'worker/database/services/AgentStateService';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';

/**
 * `@cloudflare/vitest-pool-workers` does not dedupe a file reached via the
 * `worker/*` alias against the same file reached via a relative import (the
 * service's `import ... from '../schema'`): the two resolve to
 * structurally-identical but referentially distinct module instances. So
 * table identity is asserted by name via `getTableConfig(...)`, not
 * `toBe(schema.agentState)`. Same gotcha documented in
 * `test/worker/database/appService.test.ts` / `agentSessionService.test.ts`.
 */
function tableName(table: unknown): string {
    return getTableConfig(table as PgTable).name;
}

/**
 * Unit tests for AgentStateService, the Drizzle-side read path for
 * `agent_state` (supabase/migrations/20260707000001_agent_runtime.sql).
 * That table holds the agent runtime's full state JSON, written by the
 * standalone agent runtime (agent-runtime/) via supabase-js under RLS; this
 * service is the counterpart used on the service-role Postgres connection
 * (bypasses RLS) so `AppViewController.getAppDetails` can build
 * `agentSummary` without the Durable Object RPC the DO-based runtime used
 * to provide. Reuses the fake-drizzle recorder pattern from
 * `appService.test.ts` / `agentSessionService.test.ts`: a fake db that
 * records every `.select()` call plus its full chain, backed by a FIFO
 * queue of canned row arrays - no Docker/live Postgres needed.
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
 * FIFO queue, one entry per top-level `.select()` call, in the order
 * AgentStateService issues them.
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

/**
 * Fake db whose `.select()` throws synchronously - simulating a genuine
 * query/connection failure rather than a "no row found" result - to exercise
 * `getAgentState`'s fail-safe catch branch.
 */
function createThrowingFakeDb(error: Error) {
    const db = {
        select: () => {
            throw error;
        },
    };
    return { db };
}

const FAKE_ENV = {
    JWT_SECRET: 'test-jwt-secret-for-agentstateservice-tests',
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

/**
 * Constructs a real AgentStateService (via the standalone-runtime env, so
 * the constructor's `buildDrizzle` never dials a real Postgres connection),
 * then swaps its internal `DatabaseService` handle for the fake above.
 */
function createAgentStateServiceWithFakeDb(queue: Row[][]) {
    const service = new AgentStateService(FAKE_ENV);
    const { db, calls } = createFakeDb(queue);
    (service as unknown as { db: { db: unknown; getReadDb: () => unknown } }).db = {
        db,
        getReadDb: () => db,
    };
    return { service, calls };
}

function createAgentStateServiceWithThrowingDb(error: Error) {
    const service = new AgentStateService(FAKE_ENV);
    const { db } = createThrowingFakeDb(error);
    (service as unknown as { db: { db: unknown; getReadDb: () => unknown } }).db = {
        db,
        getReadDb: () => db,
    };
    return { service };
}

describe('AgentStateService (postgres)', () => {
    describe('getAgentState', () => {
        it('selects agent_state filtered by session_id and returns the state jsonb column', async () => {
            const state = { query: 'build a todo app', generatedFilesMap: { 'src/App.tsx': { filePath: 'src/App.tsx' } } };
            const { service, calls } = createAgentStateServiceWithFakeDb([[{ state }]]);

            const result = await service.getAgentState('session-1');

            expect(result).toEqual(state);
            expect(calls).toHaveLength(1);
            expect(calls[0].entry).toBe('select');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'limit']);

            const fromCall = calls[0].chainCalls.find((c) => c.method === 'from');
            expect(tableName(fromCall?.args[0])).toBe('agent_state');

            const limitCall = calls[0].chainCalls.find((c) => c.method === 'limit');
            expect(limitCall?.args[0]).toBe(1);
        });

        it('returns null when no row matches the session_id', async () => {
            const { service, calls } = createAgentStateServiceWithFakeDb([[]]);

            const result = await service.getAgentState('missing-session');

            expect(result).toBeNull();
            expect(calls).toHaveLength(1);
        });

        it('returns null and logs (never throws) when the query errors', async () => {
            const { service } = createAgentStateServiceWithThrowingDb(new Error('connection reset'));
            const logger = (service as unknown as { logger: { error: (message: string, ...args: unknown[]) => void } }).logger;
            const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

            await expect(service.getAgentState('session-1')).resolves.toBeNull();
            expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
        });
    });
});
