import { describe, it, expect, beforeEach } from 'bun:test';
import type { ConversationClient, ConversationStore } from '../src/conversationStore';
import { createConversationStore } from '../src/conversationStore';

interface StoredRow {
	session_id: string;
	kind: 'full' | 'compact';
	idx: number;
	message: unknown;
}

class FakeConversationClient implements ConversationClient {
	private rows: StoredRow[] = [];

	from(table: string) {
		if (table !== 'agent_conversations') {
			throw new Error(`Unsupported table: ${table}`);
		}

		return {
			insert: async (rows: Record<string, unknown> | Record<string, unknown>[]) => {
				const toInsert = Array.isArray(rows) ? rows : [rows];
				const stored: StoredRow[] = toInsert.map((row) => ({
					session_id: row.session_id as string,
					kind: row.kind as 'full' | 'compact',
					idx: row.idx as number,
					message: row.message,
				}));
				this.rows.push(...stored);
				return Promise.resolve({ error: null } as { error: { message: string } | null });
			},

			delete: () => {
				const state = { accumulated: [] as { column: string; value: string }[] };

				const applyDelete = () => {
					// Delete rows matching ALL accumulated filters (AND semantics)
					this.rows = this.rows.filter((row) => {
						let matches = true;
						for (const filter of state.accumulated) {
							if (filter.column === 'session_id' && row.session_id !== filter.value) {
								matches = false;
								break;
							}
							if (filter.column === 'kind' && row.kind !== filter.value) {
								matches = false;
								break;
							}
						}
						// Return true to KEEP the row, false to DELETE it
						return !matches;
					});
				};

				const chainable = {
					eq: (column: string, value: string): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>; } & PromiseLike<{ error: { message: string } | null }> => {
						state.accumulated.push({ column, value });

						// Create result that can either be awaited OR have another .eq() called
						let promise: Promise<{ error: { message: string } | null }> | null = null;
						const result: any = {
							eq: (column: string, value: string) => {
								state.accumulated.push({ column, value });
								applyDelete();
								return Promise.resolve({ error: null } as { error: { message: string } | null });
							},
							then: (resolve: any, reject: any) => {
								if (!promise) {
									promise = Promise.resolve().then(() => {
										applyDelete();
										return { error: null } as { error: { message: string } | null };
									});
								}
								return promise.then(resolve, reject);
							},
							catch: (reject: any) => {
								if (!promise) {
									promise = Promise.resolve().then(() => {
										applyDelete();
										return { error: null } as { error: { message: string } | null };
									});
								}
								return promise.catch(reject);
							},
						};

						return result;
					},
				};

				return chainable;
			},

			select: (columns?: string) => {
				const selectedColumns = columns ?? 'message';

				return {
					eq: (column: string, value: string) => {
						let filtered = this.rows.filter((row) => {
							if (column === 'session_id') return row.session_id === value;
							if (column === 'kind') return row.kind === value;
							return true;
						});

						return {
							eq: (column: string, value: string) => {
								filtered = filtered.filter((row) => {
									if (column === 'session_id') return row.session_id === value;
									if (column === 'kind') return row.kind === value;
									return true;
								});

								return {
									order: (column: string, opts: { ascending: boolean }) => {
										if (column === 'idx') {
											filtered.sort((a, b) => {
												const diff = a.idx - b.idx;
												return opts.ascending ? diff : -diff;
											});
										}

										const data = filtered.map((row) => ({ message: row.message }));
										return Promise.resolve({ data, error: null } as { data: Array<{ message: unknown }> | null; error: { message: string } | null });
									},
								};
							},
						};
					},
				};
			},
		};
	}

	// Test helper to inspect internal state
	_getRows(): StoredRow[] {
		return structuredClone(this.rows);
	}
}

describe('ConversationStore', () => {
	let client: FakeConversationClient;
	let store: ConversationStore;
	const sessionId = 'session-123';

	beforeEach(() => {
		client = new FakeConversationClient();
		store = createConversationStore(client, sessionId);
	});

	it('should isolate kind when replacing full messages', async () => {
		// Seed both full and compact rows
		await store.append('full', 0, 'full-msg-0');
		await store.append('full', 1, 'full-msg-1');
		await store.append('compact', 0, 'compact-msg-0');
		await store.append('compact', 1, 'compact-msg-1');

		let rows = client._getRows();
		expect(rows).toHaveLength(4);

		// Replace only full
		await store.replaceAll('full', [{ text: 'new-full-a' }, { text: 'new-full-b' }]);

		// Verify compact rows untouched
		rows = client._getRows();
		const compactRows = rows.filter((r) => r.kind === 'compact');
		expect(compactRows).toHaveLength(2);
		expect(compactRows[0].message).toEqual('compact-msg-0');
		expect(compactRows[1].message).toEqual('compact-msg-1');

		// Verify full rows replaced
		const fullRows = rows.filter((r) => r.kind === 'full');
		expect(fullRows).toHaveLength(2);
		expect(fullRows[0].message).toEqual({ text: 'new-full-a' });
		expect(fullRows[1].message).toEqual({ text: 'new-full-b' });
	});

	it('should delete rows without inserting when replaceAll receives empty array', async () => {
		// Seed full rows
		await store.append('full', 0, 'full-msg-0');
		await store.append('full', 1, 'full-msg-1');
		await store.append('compact', 0, 'compact-msg-0');

		// Replace full with empty
		await store.replaceAll('full', []);

		// Verify full rows deleted, compact untouched
		const rows = client._getRows();
		const fullRows = rows.filter((r) => r.kind === 'full');
		const compactRows = rows.filter((r) => r.kind === 'compact');

		expect(fullRows).toHaveLength(0);
		expect(compactRows).toHaveLength(1);
	});

	it('should return messages in ascending index order from loadAll', async () => {
		// Seed out of order
		await store.append('full', 2, 'msg-2');
		await store.append('full', 0, 'msg-0');
		await store.append('full', 1, 'msg-1');

		const loaded = await store.loadAll('full');

		expect(loaded).toHaveLength(3);
		expect(loaded[0]).toBe('msg-0');
		expect(loaded[1]).toBe('msg-1');
		expect(loaded[2]).toBe('msg-2');
	});

	it('should wipe all kinds for session when calling clear', async () => {
		// Seed mixed kinds
		await store.append('full', 0, 'full-msg');
		await store.append('compact', 0, 'compact-msg');

		// Clear entire session
		await store.clear();

		// Verify all rows gone
		const rows = client._getRows();
		expect(rows).toHaveLength(0);
	});

	it('should insert one row with correct kind and idx via append', async () => {
		await store.append('full', 5, { data: 'test' });

		const rows = client._getRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			session_id: sessionId,
			kind: 'full',
			idx: 5,
			message: { data: 'test' },
		});
	});

	it('should isolate kind when replacing compact messages', async () => {
		// Seed both kinds
		await store.append('full', 0, 'full-msg-0');
		await store.append('compact', 0, 'compact-msg-0');

		// Replace only compact
		await store.replaceAll('compact', [{ text: 'new-compact' }]);

		// Verify full rows untouched
		const rows = client._getRows();
		const fullRows = rows.filter((r) => r.kind === 'full');
		expect(fullRows).toHaveLength(1);
		expect(fullRows[0].message).toBe('full-msg-0');

		// Verify compact rows replaced
		const compactRows = rows.filter((r) => r.kind === 'compact');
		expect(compactRows).toHaveLength(1);
		expect(compactRows[0].message).toEqual({ text: 'new-compact' });
	});
});
