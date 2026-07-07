/**
 * No-op D1Database stub for the standalone agent runtime.
 *
 * Satisfies the full `D1Database` surface that `drizzle-orm/d1`'s driver and
 * `@sentry/cloudflare`'s `instrumentD1WithSentry` touch (`prepare().bind()`,
 * `.run()`, `.all()`, `.raw()`, `.first()`, `.batch()`, `.exec()`), without
 * ever throwing. Reads default to empty results; writes report success with
 * zero rows affected. Used only when `isStandaloneRuntime(env)` is true —
 * see `worker/database/database.ts`.
 */

const EMPTY_META: D1Meta & Record<string, unknown> = {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
};

function emptyResult<T = Record<string, unknown>>(): D1Result<T> {
    return { success: true, meta: EMPTY_META, results: [] };
}

function createNoopPreparedStatement(): D1PreparedStatement {
    const statement: D1PreparedStatement = {
        bind: () => statement,
        first: async () => null,
        run: async () => emptyResult(),
        all: async () => emptyResult(),
        raw: async () => [] as never,
    };
    return statement;
}

export function createNoopD1Database(): D1Database {
    return {
        prepare: () => createNoopPreparedStatement(),
        batch: async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> =>
            statements.map(() => emptyResult<T>()),
        exec: async () => ({ count: 0, duration: 0 }),
        withSession: () => createNoopD1Database() as unknown as D1DatabaseSession,
        dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;
}
