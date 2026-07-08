import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { AgentSessionService } from 'worker/database/services/AgentSessionService';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';

/**
 * `@cloudflare/vitest-pool-workers` does not dedupe a file reached via the
 * `worker/*` alias against the same file reached via a relative import (the
 * service's `import ... from '../schema'`): the two resolve to
 * structurally-identical but referentially distinct module instances. So
 * table identity is asserted by name via `getTableConfig(...)`, not
 * `toBe(schema.agentSessions)`. Same gotcha documented in
 * `test/worker/database/appService.test.ts`.
 */
function tableName(table: unknown): string {
    return getTableConfig(table as PgTable).name;
}

/**
 * Unit tests for AgentSessionService, the Drizzle-side home for the
 * `agent_sessions` table (supabase/migrations/20260707000001_agent_runtime.sql).
 * That table previously had no Drizzle mapping - the Phase-1 standalone
 * agent runtime (agent-runtime/) writes it via supabase-js under RLS. This
 * service is the counterpart used on the service-role Postgres connection
 * (bypasses RLS), reusing the fake-drizzle recorder pattern from
 * `test/worker/database/appService.test.ts`: a fake db that records every
 * `.select()/.insert()/.update()` call plus its full chain, backed by a
 * FIFO queue of canned row arrays - no Docker/live Postgres needed.
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
 * .delete()` call, in the order AgentSessionService issues them.
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
    JWT_SECRET: 'test-jwt-secret-for-agentsessionservice-tests',
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

/**
 * Constructs a real AgentSessionService (via the standalone-runtime env, so
 * the constructor's `buildDrizzle` never dials a real Postgres connection),
 * then swaps its internal `DatabaseService` handle for the fake above.
 */
function createAgentSessionServiceWithFakeDb(queue: Row[][]) {
    const service = new AgentSessionService(FAKE_ENV);
    const { db, calls } = createFakeDb(queue);
    (service as unknown as { db: { db: unknown; getReadDb: () => unknown } }).db = {
        db,
        getReadDb: () => db,
    };
    return { service, calls };
}

function fakeAgentSession(overrides: Partial<Row> = {}): Row {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        sessionId: 'session-1',
        agentId: 'agent-1',
        userId: null,
        status: 'provisioning',
        initArgs: null,
        sandboxId: null,
        lastActivityAt: now,
        createdAt: now,
        ...overrides,
    };
}

describe('AgentSessionService (postgres)', () => {
    describe('createAgentSession', () => {
        it('inserts into agent_sessions with status "provisioning" and returns the created row', async () => {
            const created = fakeAgentSession({
                sessionId: 'session-new',
                agentId: 'agent-1',
                userId: 'user-1',
                initArgs: { query: 'test' },
            });
            const { service, calls } = createAgentSessionServiceWithFakeDb([[created]]);

            const result = await service.createAgentSession({
                sessionId: 'session-new',
                agentId: 'agent-1',
                userId: 'user-1',
                initArgs: { query: 'test' },
            });

            expect(result).toEqual(created);
            expect(calls).toHaveLength(1);
            expect(calls[0].entry).toBe('insert');
            expect(tableName(calls[0].args[0])).toBe('agent_sessions');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['values', 'returning']);

            const valuesCall = calls[0].chainCalls.find((c) => c.method === 'values');
            expect(valuesCall?.args[0]).toMatchObject({
                sessionId: 'session-new',
                agentId: 'agent-1',
                userId: 'user-1',
                status: 'provisioning',
                initArgs: { query: 'test' },
            });
        });

        it('defaults userId and initArgs to null when omitted', async () => {
            const created = fakeAgentSession({ sessionId: 'session-minimal', agentId: 'agent-2' });
            const { service, calls } = createAgentSessionServiceWithFakeDb([[created]]);

            const result = await service.createAgentSession({
                sessionId: 'session-minimal',
                agentId: 'agent-2',
            });

            expect(result).toEqual(created);
            const valuesCall = calls[0].chainCalls.find((c) => c.method === 'values');
            expect(valuesCall?.args[0]).toMatchObject({
                sessionId: 'session-minimal',
                agentId: 'agent-2',
                userId: null,
                status: 'provisioning',
                initArgs: null,
            });
        });
    });

    describe('getAgentSession', () => {
        it('selects filtered by session_id and returns the row when found', async () => {
            const row = fakeAgentSession({ sessionId: 'session-1' });
            const { service, calls } = createAgentSessionServiceWithFakeDb([[row]]);

            const result = await service.getAgentSession('session-1');

            expect(result).toEqual(row);
            expect(calls).toHaveLength(1);
            expect(calls[0].entry).toBe('select');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'limit']);

            const fromCall = calls[0].chainCalls.find((c) => c.method === 'from');
            expect(tableName(fromCall?.args[0])).toBe('agent_sessions');

            const limitCall = calls[0].chainCalls.find((c) => c.method === 'limit');
            expect(limitCall?.args[0]).toBe(1);
        });

        it('returns null when no row matches the session_id', async () => {
            const { service, calls } = createAgentSessionServiceWithFakeDb([[]]);

            const result = await service.getAgentSession('missing-session');

            expect(result).toBeNull();
            expect(calls).toHaveLength(1);
        });
    });

    describe('updateSandboxId', () => {
        it('updates sandbox_id for the given session_id', async () => {
            const { service, calls } = createAgentSessionServiceWithFakeDb([[]]);

            const result = await service.updateSandboxId('session-1', 'sandbox-abc');

            expect(result).toBeUndefined();
            expect(calls).toHaveLength(1);
            expect(calls[0].entry).toBe('update');
            expect(tableName(calls[0].args[0])).toBe('agent_sessions');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['set', 'where']);

            const setCall = calls[0].chainCalls.find((c) => c.method === 'set');
            expect(setCall?.args[0]).toMatchObject({ sandboxId: 'sandbox-abc' });
        });
    });
});
