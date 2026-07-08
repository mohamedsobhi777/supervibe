import { describe, expect, it, vi } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from 'worker/database/schema';
import type { StoreSecretRequest } from 'worker/services/secrets/vault-types';

/**
 * `eq`/`and`/`desc` normally compile to SQL fragments that only a live
 * Postgres connection can evaluate. To unit-test `secretsStore`'s
 * user-scoping and round-trip behavior without Docker/a real database,
 * this file swaps them for JS-evaluable predicates that the fake db
 * below applies directly against an in-memory row array.
 *
 * `secretsStore.ts` itself is unaffected: it calls the real
 * `drizzle-orm` exports and is typechecked against the real library -
 * only this test's module graph sees the fakes.
 */
const { fieldOf } = vi.hoisted(() => {
	const FIELD_BY_COLUMN_NAME: Record<string, string> = {
		id: 'id',
		user_id: 'userId',
		secret_type: 'secretType',
		encrypted_name: 'encryptedName',
		name_nonce: 'nameNonce',
		encrypted_value: 'encryptedValue',
		value_nonce: 'valueNonce',
		metadata: 'metadata',
		created_at: 'createdAt',
		updated_at: 'updatedAt',
	};

	function fieldOf(column: unknown): string {
		const name = (column as { name: string }).name;
		const field = FIELD_BY_COLUMN_NAME[name];
		if (!field) {
			throw new Error(`fake db: unmapped column "${name}"`);
		}
		return field;
	}

	return { fieldOf };
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
		desc: (column: unknown) => ({ field: fieldOf(column), direction: 'desc' as const }),
	};
});

import { deleteSecret, getSecret, listSecrets, storeSecret } from 'worker/services/secrets/secretsStore';

/** In-memory shape of a `user_secrets` row (camelCase, matching `.values()`/select output). */
interface Row {
	id: string;
	userId: string;
	secretType: string;
	encryptedName: Buffer;
	nameNonce: Buffer;
	encryptedValue: Buffer;
	valueNonce: Buffer;
	metadata: unknown;
	createdAt: Date;
	updatedAt: Date;
}

type Predicate = (row: Row) => boolean;
type OrderMarker = { field: keyof Row; direction: 'asc' | 'desc' };

function compare(a: unknown, b: unknown): number {
	if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	return String(a).localeCompare(String(b));
}

function project(row: Row, projection?: Record<string, unknown>): Record<string, unknown> {
	if (!projection) return { ...row };
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(projection)) {
		out[key] = row[fieldOf(projection[key]) as keyof Row];
	}
	return out;
}

/**
 * Minimal fake drizzle db: a real in-memory row array backs `insert`,
 * `select`, and `delete`, with `.where()` actually filtering (via the
 * mocked `eq`/`and` predicates above) so round-trip and user-scoping
 * behavior is genuinely exercised, not just recorded.
 */
function createFakeDb() {
	const rows: Row[] = [];

	function selectChain(projection?: Record<string, unknown>) {
		let filtered: Row[] = rows;
		let limitN: number | undefined;
		const chain = {
			from() {
				filtered = rows;
				return chain;
			},
			where(predicate: Predicate) {
				filtered = filtered.filter(predicate);
				return chain;
			},
			orderBy(marker: OrderMarker) {
				const sorted = [...filtered].sort((a, b) => compare(a[marker.field], b[marker.field]));
				filtered = marker.direction === 'desc' ? sorted.reverse() : sorted;
				return chain;
			},
			limit(n: number) {
				limitN = n;
				return chain;
			},
			then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
				const limited = limitN === undefined ? filtered : filtered.slice(0, limitN);
				return Promise.resolve(limited.map((row) => project(row, projection))).then(onFulfilled, onRejected);
			},
		};
		return chain;
	}

	function insertChain() {
		let insertedRow: Row;
		const chain = {
			values(value: Record<string, unknown>) {
				const now = new Date();
				insertedRow = {
					id: value.id as string,
					userId: value.userId as string,
					secretType: value.secretType as string,
					encryptedName: value.encryptedName as Buffer,
					nameNonce: value.nameNonce as Buffer,
					encryptedValue: value.encryptedValue as Buffer,
					valueNonce: value.valueNonce as Buffer,
					metadata: value.metadata ?? null,
					createdAt: (value.createdAt as Date | undefined) ?? now,
					updatedAt: (value.updatedAt as Date | undefined) ?? now,
				};
				rows.push(insertedRow);
				return chain;
			},
			returning(projection?: Record<string, unknown>) {
				return Promise.resolve([project(insertedRow, projection)]);
			},
		};
		return chain;
	}

	function deleteChain() {
		let predicate: Predicate = () => true;
		const chain = {
			where(p: Predicate) {
				predicate = p;
				return chain;
			},
			returning(projection?: Record<string, unknown>) {
				const toRemove = rows.filter(predicate);
				for (const row of toRemove) {
					const idx = rows.indexOf(row);
					if (idx >= 0) rows.splice(idx, 1);
				}
				return Promise.resolve(toRemove.map((row) => project(row, projection)));
			},
		};
		return chain;
	}

	return {
		select: (projection?: Record<string, unknown>) => selectChain(projection),
		insert: () => insertChain(),
		delete: () => deleteChain(),
	};
}

function asDb(fake: ReturnType<typeof createFakeDb>): PostgresJsDatabase<typeof schema> {
	return fake as unknown as PostgresJsDatabase<typeof schema>;
}

function bytes(...values: number[]): ArrayBuffer {
	return new Uint8Array(values).buffer;
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

function fakePayload(overrides: Partial<StoreSecretRequest> = {}): StoreSecretRequest {
	return {
		encryptedValue: bytes(1, 2, 3, 4, 5),
		valueNonce: bytes(9, 9, 9),
		encryptedName: bytes(6, 7, 8),
		nameNonce: bytes(4, 4, 4),
		secretType: 'secret',
		metadata: { provider: 'openai', envVarName: 'OPENAI_API_KEY' },
		...overrides,
	};
}

describe('secretsStore (postgres)', () => {
	describe('storeSecret -> getSecret round trip', () => {
		it('returns the exact ciphertext bytes that were stored, never plaintext', async () => {
			const db = asDb(createFakeDb());
			const payload = fakePayload();

			const { id } = await storeSecret(db, USER_A, payload);
			expect(typeof id).toBe('string');
			expect(id.length).toBeGreaterThan(0);

			const fetched = await getSecret(db, USER_A, id);

			expect(fetched).not.toBeNull();
			expect(Array.from(fetched!.encryptedValue)).toEqual(Array.from(new Uint8Array(payload.encryptedValue)));
			expect(Array.from(fetched!.valueNonce)).toEqual(Array.from(new Uint8Array(payload.valueNonce)));
			expect(Array.from(fetched!.encryptedName)).toEqual(Array.from(new Uint8Array(payload.encryptedName)));
			expect(Array.from(fetched!.nameNonce)).toEqual(Array.from(new Uint8Array(payload.nameNonce)));
			expect(fetched!.metadata).toEqual(payload.metadata);
			expect(fetched!.secretType).toBe('secret');

			// The only fields the server ever returns are the ciphertext/nonce
			// pairs plus plaintext lookup metadata - there is no plaintext
			// "value" field anywhere in the response shape.
			expect(Object.keys(fetched!).sort()).toEqual(
				['id', 'encryptedValue', 'valueNonce', 'encryptedName', 'nameNonce', 'metadata', 'secretType', 'createdAt', 'updatedAt'].sort(),
			);
		});

		it('getSecret returns null for an id that was never stored', async () => {
			const db = asDb(createFakeDb());
			const result = await getSecret(db, USER_A, 'nonexistent-id');
			expect(result).toBeNull();
		});
	});

	describe('user scoping', () => {
		it('getSecret returns null when the secret belongs to a different user', async () => {
			const db = asDb(createFakeDb());
			const { id } = await storeSecret(db, USER_A, fakePayload());

			const resultForOwner = await getSecret(db, USER_A, id);
			const resultForOther = await getSecret(db, USER_B, id);

			expect(resultForOwner).not.toBeNull();
			expect(resultForOther).toBeNull();
		});

		it('deleteSecret returns false and leaves the row intact when called by a different user', async () => {
			const db = asDb(createFakeDb());
			const { id } = await storeSecret(db, USER_A, fakePayload());

			const deletedByOther = await deleteSecret(db, USER_B, id);
			expect(deletedByOther).toBe(false);

			// Still readable by the actual owner - the failed cross-user
			// delete must not have removed the row.
			const stillThere = await getSecret(db, USER_A, id);
			expect(stillThere).not.toBeNull();
		});

		it('deleteSecret returns true and removes the row for the owning user', async () => {
			const db = asDb(createFakeDb());
			const { id } = await storeSecret(db, USER_A, fakePayload());

			const deleted = await deleteSecret(db, USER_A, id);
			expect(deleted).toBe(true);

			const afterDelete = await getSecret(db, USER_A, id);
			expect(afterDelete).toBeNull();
		});
	});

	describe('listSecrets', () => {
		it('returns only the caller\'s own rows', async () => {
			const db = asDb(createFakeDb());
			await storeSecret(db, USER_A, fakePayload({ metadata: { provider: 'openai', envVarName: 'A1' } }));
			await storeSecret(db, USER_A, fakePayload({ metadata: { provider: 'openai', envVarName: 'A2' } }));
			await storeSecret(db, USER_B, fakePayload({ metadata: { provider: 'openai', envVarName: 'B1' } }));

			const listForA = await listSecrets(db, USER_A);
			const listForB = await listSecrets(db, USER_B);

			expect(listForA).toHaveLength(2);
			expect(listForB).toHaveLength(1);
			expect(listForA.every((s) => s.metadata?.envVarName?.startsWith('A'))).toBe(true);
		});

		it('returns an empty array for a user with no secrets', async () => {
			const db = asDb(createFakeDb());
			const list = await listSecrets(db, USER_A);
			expect(list).toEqual([]);
		});

		it('orders results newest first', async () => {
			const db = asDb(createFakeDb());
			const { id: firstId } = await storeSecret(db, USER_A, fakePayload({ metadata: { envVarName: 'FIRST' } }));
			const { id: secondId } = await storeSecret(db, USER_A, fakePayload({ metadata: { envVarName: 'SECOND' } }));

			const list = await listSecrets(db, USER_A);

			expect(list.map((s) => s.id)).toEqual([secondId, firstId]);
		});

		it('does not include the value ciphertext - name and metadata only', async () => {
			const db = asDb(createFakeDb());
			await storeSecret(db, USER_A, fakePayload());

			const [item] = await listSecrets(db, USER_A);

			expect(item).not.toHaveProperty('encryptedValue');
			expect(item).not.toHaveProperty('valueNonce');
			expect(item).toHaveProperty('encryptedName');
			expect(item).toHaveProperty('nameNonce');
		});
	});
});
