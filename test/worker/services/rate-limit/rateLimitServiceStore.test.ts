import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../../../worker/database/schema';
import * as databaseModule from '../../../../worker/database';
import type { DatabaseService } from '../../../../worker/database';
import {
	RateLimitStore,
	RateLimitType,
	type RateLimitSettings,
	type DORateLimitConfig,
	type LLMCallsRateLimitConfig,
	type RLRateLimitConfig,
} from '../../../../worker/services/rate-limit/config';

/**
 * Unit tests for the Postgres-store branch `RateLimitService`
 * (`worker/services/rate-limit/rateLimits.ts`) now takes for its
 * `DURABLE_OBJECT`-backed limits (`appCreation`, `llmCalls`, and
 * `GET /api/limits/usage` via `getRemainingCredits`) when `env.DORateLimitStore`
 * is absent (Vercel / the standalone agent runtime).
 *
 * `RateLimitService` calls `createDatabaseService(env).db` internally to get
 * the Postgres handle it hands to `pgRateLimitStore`. To exercise the real
 * `pgRateLimitStore.increment`/`getRemainingLimit` window arithmetic here
 * (not just prove they were "called with some args"), `createDatabaseService`
 * is spied via its own module namespace - imported here with the same
 * relative-path shape `rateLimits.ts` itself uses (`'../../database'` from
 * `worker/services/rate-limit/`) - and made to return an in-memory fake db.
 * `@cloudflare/vitest-pool-workers` does not dedupe a file reached via the
 * `worker/*` alias against the same file reached via a relative import (see
 * `test/worker/database/agentSessionService.test.ts`), so every worker-side
 * import in this file uses the relative form to guarantee the spy actually
 * intercepts `rateLimits.ts`'s own call.
 *
 * The fake db + `drizzle-orm` mock below is the same technique
 * `test/worker/services/rate-limit/pgRateLimitStore.test.ts` uses (see that
 * file's header for the full rationale), trimmed to the `select`/`insert`
 * surface `pgRateLimitStore` actually needs (no `delete` - `RateLimitService`
 * never calls `cleanupExpiredBuckets`).
 */
const { fieldOf, makeFakeSql, isFakeSql, incrementAmountOf } = vi.hoisted(() => {
	const FIELD_BY_COLUMN_NAME: Record<string, string> = {
		key: 'key',
		bucket_timestamp: 'bucketTimestamp',
		count: 'count',
		created_at: 'createdAt',
	};

	function fieldOf(column: unknown): string {
		const name = (column as { name: string }).name;
		const field = FIELD_BY_COLUMN_NAME[name];
		if (!field) {
			throw new Error(`fake db: unmapped column "${name}"`);
		}
		return field;
	}

	interface FakeSqlExpr {
		readonly __fakeSql__: true;
		readonly values: unknown[];
	}

	function makeFakeSql(values: unknown[]): FakeSqlExpr {
		return { __fakeSql__: true, values };
	}

	function isFakeSql(value: unknown): value is FakeSqlExpr {
		return typeof value === 'object' && value !== null && '__fakeSql__' in value;
	}

	/** Extracts the increment amount from `sql\`${column} + ${incrementBy}\`` - the one numeric literal among the interpolated values. */
	function incrementAmountOf(expr: FakeSqlExpr): number {
		const numeric = expr.values.find((v): v is number => typeof v === 'number');
		if (numeric === undefined) {
			throw new Error('fake db: could not find increment amount in sql expression');
		}
		return numeric;
	}

	return { fieldOf, makeFakeSql, isFakeSql, incrementAmountOf };
});

vi.mock('drizzle-orm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('drizzle-orm')>();
	return {
		...actual,
		eq: (column: unknown, value: unknown) => (row: Record<string, unknown>) => row[fieldOf(column)] === value,
		and:
			(...conditions: Array<(row: Record<string, unknown>) => boolean>) =>
			(row: Record<string, unknown>) =>
				conditions.every((condition) => condition(row)),
		gte: (column: unknown, value: number) => (row: Record<string, unknown>) => (row[fieldOf(column)] as number) >= value,
		lte: (column: unknown, value: number) => (row: Record<string, unknown>) => (row[fieldOf(column)] as number) <= value,
		sql: (_strings: TemplateStringsArray, ...values: unknown[]) => makeFakeSql(values),
	};
});

import { RateLimitService } from '../../../../worker/services/rate-limit/rateLimits';

/** In-memory shape of a `rate_limit_buckets` row (camelCase, matching `.values()`/select output). */
interface Row {
	key: string;
	bucketTimestamp: number;
	count: number;
	createdAt: Date;
}

type Predicate = (row: Row) => boolean;

/** Minimal fake drizzle db (select + insert only, see file header). */
function createFakeDb() {
	const rows: Row[] = [];

	function findRow(key: string, bucketTimestamp: number): Row | undefined {
		return rows.find((row) => row.key === key && row.bucketTimestamp === bucketTimestamp);
	}

	function selectChain(projection: Record<string, unknown>) {
		let filtered: Row[] = rows;
		const chain = {
			from() {
				filtered = rows;
				return chain;
			},
			where(predicate: Predicate) {
				filtered = filtered.filter(predicate);
				return chain;
			},
			then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
				const [alias, expr] = Object.entries(projection)[0] ?? [];
				if (alias === undefined || !isFakeSql(expr)) {
					throw new Error('fake db: unsupported select projection');
				}
				const total = filtered.reduce((sum, row) => sum + row.count, 0);
				// Mimic postgres-js: SUM(integer) is Postgres `bigint`, returned as a string by default.
				return Promise.resolve([{ [alias]: String(total) }]).then(onFulfilled, onRejected);
			},
		};
		return chain;
	}

	function insertChain() {
		let pending: Row | undefined;
		const chain = {
			values(value: Record<string, unknown>) {
				pending = {
					key: value.key as string,
					bucketTimestamp: value.bucketTimestamp as number,
					count: value.count as number,
					createdAt: value.createdAt as Date,
				};
				return chain;
			},
			onConflictDoUpdate(config: { set: Record<string, unknown> }) {
				if (!pending) {
					throw new Error('fake db: onConflictDoUpdate called before values()');
				}
				const existing = findRow(pending.key, pending.bucketTimestamp);
				const setExpr = config.set.count;
				if (!isFakeSql(setExpr)) {
					throw new Error('fake db: unsupported onConflictDoUpdate set value');
				}
				if (existing) {
					existing.count += incrementAmountOf(setExpr);
				} else {
					rows.push({ ...pending });
				}
				return Promise.resolve();
			},
		};
		return chain;
	}

	return {
		select: (projection: Record<string, unknown>) => selectChain(projection),
		insert: () => insertChain(),
	};
}

function asDb(fake: ReturnType<typeof createFakeDb>): PostgresJsDatabase<typeof schema> {
	return fake as unknown as PostgresJsDatabase<typeof schema>;
}

const API_RATE_LIMITER_CONFIG: RLRateLimitConfig = {
	enabled: false,
	store: RateLimitStore.RATE_LIMITER,
	bindingName: 'API_RATE_LIMITER',
};

function buildSettings(overrides: {
	appCreation?: DORateLimitConfig;
	llmCalls?: LLMCallsRateLimitConfig;
}): RateLimitSettings {
	return {
		apiRateLimit: API_RATE_LIMITER_CONFIG,
		authRateLimit: API_RATE_LIMITER_CONFIG,
		appCreation:
			overrides.appCreation ??
			({
				enabled: true,
				store: RateLimitStore.DURABLE_OBJECT,
				limit: 2,
				period: 3600,
			} satisfies DORateLimitConfig),
		llmCalls:
			overrides.llmCalls ??
			({
				enabled: true,
				store: RateLimitStore.DURABLE_OBJECT,
				limit: 10,
				period: 3600,
				excludeBYOKUsers: true,
			} satisfies LLMCallsRateLimitConfig),
	};
}

interface FakeDOStub {
	increment: MockInstance<(key: string, config: unknown, incrementBy: number) => Promise<{ success: boolean; remainingLimit?: number }>>;
	getRemainingLimit: MockInstance<(key: string, config: unknown) => Promise<number>>;
}

/** Env shaped like Vercel/standalone: the `DORateLimitStore` Durable Object binding is simply absent. */
function buildEnvWithoutDO(): Env {
	return {} as unknown as Env;
}

/** Env shaped like Workers: `DORateLimitStore` resolves to a fake stub that records every call. */
function buildEnvWithDOStub(cannedIncrement: { success: boolean; remainingLimit?: number }, cannedRemaining: number): { env: Env; stub: FakeDOStub } {
	const stub: FakeDOStub = {
		increment: vi.fn(async () => cannedIncrement),
		getRemainingLimit: vi.fn(async () => cannedRemaining),
	};
	const env = {
		DORateLimitStore: {
			getByName: vi.fn(() => stub),
		},
	} as unknown as Env;
	return { env, stub };
}

describe('RateLimitService - store selection (DO stub vs. pgRateLimitStore)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('env.DORateLimitStore absent (Vercel / standalone)', () => {
		it('enforce() increments via the Postgres store and denies once the limit is reached', async () => {
			const fakeDb = asDb(createFakeDb());
			vi.spyOn(databaseModule, 'createDatabaseService').mockReturnValue({ db: fakeDb } as unknown as DatabaseService);

			const env = buildEnvWithoutDO();
			const settings = buildSettings({});
			const key = RateLimitService.buildRateLimitKey(RateLimitType.APP_CREATION, 'user:pg-enforce-test');

			const r1 = await RateLimitService.enforce(env, key, settings, RateLimitType.APP_CREATION);
			const r2 = await RateLimitService.enforce(env, key, settings, RateLimitType.APP_CREATION);
			const r3 = await RateLimitService.enforce(env, key, settings, RateLimitType.APP_CREATION);

			expect(r1).toEqual({ success: true, remainingLimit: 1 });
			expect(r2).toEqual({ success: true, remainingLimit: 0 });
			expect(r3).toEqual({
				success: false,
				remainingLimit: 0,
				exceededLimit: 'main',
				limitValue: 2,
				periodSeconds: 3600,
			});
		});

		it('routes through createDatabaseService(env) rather than a Durable Object binding', async () => {
			const fakeDb = asDb(createFakeDb());
			const createDatabaseServiceSpy = vi
				.spyOn(databaseModule, 'createDatabaseService')
				.mockReturnValue({ db: fakeDb } as unknown as DatabaseService);

			const env = buildEnvWithoutDO();
			const settings = buildSettings({});
			const key = RateLimitService.buildRateLimitKey(RateLimitType.APP_CREATION, 'user:pg-routing-test');

			await RateLimitService.enforce(env, key, settings, RateLimitType.APP_CREATION);

			expect(createDatabaseServiceSpy).toHaveBeenCalledWith(env);
		});

		it('getRemainingCredits() reflects usage already recorded via the Postgres store', async () => {
			const fakeDb = asDb(createFakeDb());
			vi.spyOn(databaseModule, 'createDatabaseService').mockReturnValue({ db: fakeDb } as unknown as DatabaseService);

			const env = buildEnvWithoutDO();
			const settings = buildSettings({});
			const userId = 'pg-credits-test';
			const key = RateLimitService.buildRateLimitKey(RateLimitType.LLM_CALLS, `user:${userId}`);

			await RateLimitService.enforce(env, key, settings, RateLimitType.LLM_CALLS, 3);
			await RateLimitService.enforce(env, key, settings, RateLimitType.LLM_CALLS, 2);

			const credits = await RateLimitService.getRemainingCredits(env, settings, userId);

			expect(credits).toEqual({ remaining: 5, limit: 10, dailyLimit: undefined });
		});
	});

	describe('env.DORateLimitStore present (Workers)', () => {
		it('enforce() calls the Durable Object stub and never touches the Postgres store', async () => {
			const createDatabaseServiceSpy = vi.spyOn(databaseModule, 'createDatabaseService');
			const { env, stub } = buildEnvWithDOStub({ success: true, remainingLimit: 99 }, 0);
			const settings = buildSettings({});
			const key = RateLimitService.buildRateLimitKey(RateLimitType.APP_CREATION, 'user:do-enforce-test');

			const result = await RateLimitService.enforce(env, key, settings, RateLimitType.APP_CREATION, 1);

			expect(result).toEqual({ success: true, remainingLimit: 99 });
			expect(stub.increment).toHaveBeenCalledWith(key, expect.objectContaining({ limit: 2, period: 3600 }), 1);
			expect(createDatabaseServiceSpy).not.toHaveBeenCalled();
		});

		it('getRemainingCredits() calls the Durable Object stub and never touches the Postgres store', async () => {
			const createDatabaseServiceSpy = vi.spyOn(databaseModule, 'createDatabaseService');
			const { env, stub } = buildEnvWithDOStub({ success: true }, 77);
			const settings = buildSettings({});

			const credits = await RateLimitService.getRemainingCredits(env, settings, 'do-credits-test');

			expect(credits).toEqual({ remaining: 77, limit: 10, dailyLimit: undefined });
			expect(stub.getRemainingLimit).toHaveBeenCalledWith(
				RateLimitService.buildRateLimitKey(RateLimitType.LLM_CALLS, 'user:do-credits-test'),
				expect.objectContaining({ limit: 10, period: 3600 }),
			);
			expect(createDatabaseServiceSpy).not.toHaveBeenCalled();
		});
	});
});
