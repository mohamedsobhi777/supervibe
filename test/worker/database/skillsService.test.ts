import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { SkillsService } from 'worker/database/services/SkillsService';
import {
    MAX_SKILL_CONTENT_LENGTH,
    MAX_COMBINED_ACTIVE_SKILLS_LENGTH,
} from 'shared/constants/skills';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';
import { setRuntimeEnv } from 'worker/utils/runtimeEnv';

/**
 * Unit tests for SkillsService using the fake-drizzle recorder pattern from
 * `test/worker/database/modelConfig.test.ts` / `appService.test.ts`: a fake
 * db records every `.select()/.insert()/.update()/.delete()` chain, backed
 * by a FIFO queue of canned row arrays - no live Postgres needed.
 *
 * Table identity is asserted by name via `getTableConfig(...)` because
 * `@cloudflare/vitest-pool-workers` does not dedupe `worker/*`-alias vs
 * relative imports of `schema.ts` (same gotcha those files document).
 */

function tableName(table: unknown): string {
    return getTableConfig(table as PgTable).name;
}

type Row = Record<string, unknown>;

interface RecordedCall {
    entry: 'select' | 'insert' | 'update' | 'delete';
    args: unknown[];
    chainCalls: { method: string; args: unknown[] }[];
}

const CHAIN_METHODS = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset', 'values', 'set', 'returning', 'groupBy'] as const;

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
    JWT_SECRET: 'test-jwt-secret-for-skills-tests',
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

setRuntimeEnv(FAKE_ENV);

function createSkillsServiceWithFakeDb(queue: Row[][]) {
    const service = new SkillsService(FAKE_ENV);
    const { db, calls } = createFakeDb(queue);
    (service as unknown as { db: { db: unknown; getReadDb: () => unknown } }).db = {
        db,
        getReadDb: () => db,
    };
    return { service, calls };
}

function fakeSkill(overrides: Partial<Row> = {}): Row {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'skill-1',
        userId: 'user-1',
        name: 'Tailwind conventions',
        description: 'How I like utility classes organized',
        content: '# Tailwind\n- Prefer utility classes',
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

describe('SkillsService', () => {
    describe('getUserSkills', () => {
        it('selects from agent_skills scoped by user with deterministic ordering', async () => {
            const rows = [fakeSkill(), fakeSkill({ id: 'skill-2', name: 'API errors' })];
            const { service, calls } = createSkillsServiceWithFakeDb([rows]);

            const result = await service.getUserSkills('user-1');

            expect(result).toHaveLength(2);
            expect(calls).toHaveLength(1);
            expect(calls[0].entry).toBe('select');
            const fromCall = calls[0].chainCalls.find((c) => c.method === 'from');
            expect(tableName(fromCall?.args[0])).toBe('agent_skills');
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['from', 'where', 'orderBy']);
        });
    });

    describe('createSkill', () => {
        it('inserts with a generated id, defaults isActive to true, and returns the row', async () => {
            const created = fakeSkill();
            const { service, calls } = createSkillsServiceWithFakeDb([[created]]);

            const result = await service.createSkill('user-1', {
                name: 'Tailwind conventions',
                description: 'How I like utility classes organized',
                content: '# Tailwind\n- Prefer utility classes',
            });

            expect(result).toEqual(created);
            expect(calls[0].entry).toBe('insert');
            expect(tableName(calls[0].args[0])).toBe('agent_skills');
            const valuesCall = calls[0].chainCalls.find((c) => c.method === 'values');
            const inserted = valuesCall?.args[0] as Row;
            expect(inserted.userId).toBe('user-1');
            expect(inserted.isActive).toBe(true);
            expect(typeof inserted.id).toBe('string');
            expect((inserted.id as string).length).toBeGreaterThan(0);
            expect(calls[0].chainCalls.map((c) => c.method)).toEqual(['values', 'returning']);
        });

        it('respects an explicit isActive: false', async () => {
            const created = fakeSkill({ isActive: false });
            const { service, calls } = createSkillsServiceWithFakeDb([[created]]);

            await service.createSkill('user-1', {
                name: 'Draft skill',
                description: 'Not yet enabled',
                content: 'Draft content',
                isActive: false,
            });

            const inserted = calls[0].chainCalls.find((c) => c.method === 'values')?.args[0] as Row;
            expect(inserted.isActive).toBe(false);
        });
    });

    describe('updateSkill', () => {
        it('updates scoped by user and bumps updatedAt', async () => {
            const updated = fakeSkill({ name: 'Renamed' });
            const { service, calls } = createSkillsServiceWithFakeDb([[updated]]);

            const result = await service.updateSkill('user-1', 'skill-1', { name: 'Renamed' });

            expect(result).toEqual(updated);
            expect(calls[0].entry).toBe('update');
            const setCall = calls[0].chainCalls.find((c) => c.method === 'set');
            const setData = setCall?.args[0] as Row;
            expect(setData.name).toBe('Renamed');
            expect(setData.updatedAt).toBeInstanceOf(Date);
        });

        it('returns null when no row matches', async () => {
            const { service } = createSkillsServiceWithFakeDb([[]]);

            const result = await service.updateSkill('user-1', 'missing', { name: 'x' });

            expect(result).toBeNull();
        });
    });

    describe('deleteSkill', () => {
        it('returns true when a row was deleted and false otherwise', async () => {
            const { service } = createSkillsServiceWithFakeDb([[fakeSkill()], []]);

            expect(await service.deleteSkill('user-1', 'skill-1')).toBe(true);
            expect(await service.deleteSkill('user-1', 'missing')).toBe(false);
        });
    });

    describe('getCombinedActiveContentLength', () => {
        it('sums active content lengths, excluding the given skill id', async () => {
            const rows = [
                fakeSkill({ id: 'skill-1', content: 'aaaa' }),
                fakeSkill({ id: 'skill-2', content: 'bbbbbb' }),
            ];
            const { service } = createSkillsServiceWithFakeDb([rows, rows]);

            expect(await service.getCombinedActiveContentLength('user-1')).toBe(10);
            expect(await service.getCombinedActiveContentLength('user-1', 'skill-1')).toBe(6);
        });
    });

    describe('resolveActiveSkillsSnapshot', () => {
        it('maps rows to the snapshot shape', async () => {
            const rows = [fakeSkill()];
            const { service } = createSkillsServiceWithFakeDb([rows]);

            const snapshot = await service.resolveActiveSkillsSnapshot('user-1');

            expect(snapshot).toEqual([
                {
                    id: 'skill-1',
                    name: 'Tailwind conventions',
                    description: 'How I like utility classes organized',
                    content: '# Tailwind\n- Prefer utility classes',
                },
            ]);
        });

        it('skips whole skills that exceed the per-skill cap', async () => {
            const rows = [
                fakeSkill({ id: 'skill-1', content: 'a'.repeat(MAX_SKILL_CONTENT_LENGTH + 1) }),
                fakeSkill({ id: 'skill-2', name: 'Small', content: 'small content' }),
            ];
            const { service } = createSkillsServiceWithFakeDb([rows]);

            const snapshot = await service.resolveActiveSkillsSnapshot('user-1');

            expect(snapshot.map((s) => s.id)).toEqual(['skill-2']);
        });

        it('greedily skips skills that would overflow the combined cap but keeps later ones that fit', async () => {
            const bigChunk = 'a'.repeat(MAX_SKILL_CONTENT_LENGTH);
            const rows = [
                fakeSkill({ id: 'skill-1', content: bigChunk }),
                fakeSkill({ id: 'skill-2', name: 'B', content: bigChunk }),
                fakeSkill({ id: 'skill-3', name: 'C', content: bigChunk }),
                // Would overflow the combined cap (3 * 16k = 48k already used)
                fakeSkill({ id: 'skill-4', name: 'D', content: 'a' }),
            ];
            const { service } = createSkillsServiceWithFakeDb([rows]);

            const snapshot = await service.resolveActiveSkillsSnapshot('user-1');

            const included = snapshot.map((s) => s.id);
            expect(included).toEqual(['skill-1', 'skill-2', 'skill-3']);
            const combined = snapshot.reduce((total, s) => total + s.content.length, 0);
            expect(combined).toBeLessThanOrEqual(MAX_COMBINED_ACTIVE_SKILLS_LENGTH);
        });
    });
});
