import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { getGlobalConfigurableSettings, getUserConfigurableSettings } from '../../../worker/config';
import { SystemSettingsService } from '../../../worker/database/services/SystemSettingsService';
import { getConfigurableSecurityDefaults } from '../../../worker/config/security';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from '../../../worker/utils/runtimeMode';

/**
 * Unit tests for the Postgres port of `worker/config/index.ts`'s
 * `getGlobalConfigurableSettings` / `getUserConfigurableSettings`, which
 * used to read `env.VibecoderStore` (Cloudflare KV) and now read
 * `system_settings` via `SystemSettingsService`.
 *
 * `SystemSettingsService` is spied on its real class prototype (imported
 * here via the same relative-path shape `worker/config/index.ts` itself
 * uses) rather than `vi.mock`'d, because `@cloudflare/vitest-pool-workers`
 * resolves the `worker/*` tsconfig alias and a relative import of the same
 * file to two distinct module instances - see the header comment in
 * `test/worker/api/agentBootstrap.test.ts`. Mixing alias- and
 * relative-style imports here would let the spy silently miss
 * config/index.ts's own call, so every worker-side import in this file
 * uses the relative form.
 *
 * Both `getGlobalConfigurableSettings` and `getUserConfigurableSettings`
 * keep a module-level cache (`cachedConfig` / `invocationUserCache`) that
 * is populated only on a *found* override and is never reset - this
 * mirrors the pre-existing KV-backed behavior and is intentionally
 * preserved (see task brief's perf note). There is no reset hook between
 * tests, so:
 *  - user-config scenarios each use a distinct userId, so every test gets
 *    its own `invocationUserCache` slot and none can bleed into another;
 *  - the global config has a single cache slot, so every scenario needing
 *    an *uncached* global lookup runs before the one test that seeds (and
 *    thus permanently warms, for the rest of this file's module instance)
 *    the global cache - that test is last in the file.
 */

const FAKE_ENV = {
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

const DEFAULT_RATE_LIMIT = getConfigurableSecurityDefaults().rateLimit;
const DEFAULT_MESSAGING = { globalUserMessage: '', changeLogs: '' };

describe('worker/config (postgres system_settings)', () => {
    let getByKeySpy: MockInstance<SystemSettingsService['getByKey']>;

    beforeEach(() => {
        getByKeySpy = vi.spyOn(SystemSettingsService.prototype, 'getByKey');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getGlobalConfigurableSettings - uncached scenarios', () => {
        it('falls back to defaults when no platform_configs row is stored', async () => {
            getByKeySpy.mockResolvedValue(null);

            const config = await getGlobalConfigurableSettings(FAKE_ENV);

            expect(config.security.rateLimit).toEqual(DEFAULT_RATE_LIMIT);
            expect(config.globalMessaging).toEqual(DEFAULT_MESSAGING);
            expect(getByKeySpy).toHaveBeenCalledWith('platform_configs');
        });

        it('falls back to defaults when the stored value is not a plain object', async () => {
            getByKeySpy.mockResolvedValue(['not', 'an', 'object'] as unknown as Record<string, unknown>);

            const config = await getGlobalConfigurableSettings(FAKE_ENV);

            expect(config.security.rateLimit).toEqual(DEFAULT_RATE_LIMIT);
            expect(config.globalMessaging).toEqual(DEFAULT_MESSAGING);
        });
    });

    describe('getUserConfigurableSettings', () => {
        it('falls back to the global config when no user_config row is stored', async () => {
            getByKeySpy.mockResolvedValue(null);

            const config = await getUserConfigurableSettings(FAKE_ENV, 'user-missing');

            expect(config.globalMessaging).toEqual(DEFAULT_MESSAGING);
            expect(getByKeySpy).toHaveBeenCalledWith('user_config:user-missing');
        });

        it('falls back to the global config when the stored user value is not a plain object', async () => {
            getByKeySpy.mockImplementation(async (key: string) =>
                key === 'user_config:user-malformed' ? ('nope' as unknown as Record<string, unknown>) : null,
            );

            const config = await getUserConfigurableSettings(FAKE_ENV, 'user-malformed');

            expect(config.globalMessaging).toEqual(DEFAULT_MESSAGING);
        });

        it('merges a seeded user_config row over the global config', async () => {
            getByKeySpy.mockImplementation(async (key: string) =>
                key === 'user_config:user-merge' ? { globalMessaging: { changeLogs: 'user override' } } : null,
            );

            const config = await getUserConfigurableSettings(FAKE_ENV, 'user-merge');

            expect(config.globalMessaging.changeLogs).toBe('user override');
            expect(config.globalMessaging.globalUserMessage).toBe('');
            expect(config.security.rateLimit).toEqual(DEFAULT_RATE_LIMIT);
        });

        it('caches a merged user config: a second call skips the user_config re-query', async () => {
            getByKeySpy.mockImplementation(async (key: string) =>
                key === 'user_config:user-cache' ? { globalMessaging: { globalUserMessage: 'cache me' } } : null,
            );

            const first = await getUserConfigurableSettings(FAKE_ENV, 'user-cache');
            expect(first.globalMessaging.globalUserMessage).toBe('cache me');

            getByKeySpy.mockClear();
            const second = await getUserConfigurableSettings(FAKE_ENV, 'user-cache');

            expect(second).toEqual(first);
            // The global lookup may still re-run (it has its own, separate
            // cache), but the per-user override must not be re-queried.
            expect(getByKeySpy).not.toHaveBeenCalledWith('user_config:user-cache');
        });

        it('skips the user_config lookup and returns the global config when userId is empty', async () => {
            getByKeySpy.mockResolvedValue(null);

            const config = await getUserConfigurableSettings(FAKE_ENV, '');

            expect(config.globalMessaging).toEqual(DEFAULT_MESSAGING);
            expect(getByKeySpy).not.toHaveBeenCalledWith(expect.stringContaining('user_config:'));
        });
    });

    // MUST run last: seeds and thus permanently warms the module-level
    // `cachedConfig` in worker/config/index.ts, which is never reset and
    // would short-circuit every earlier "uncached" scenario above
    // (including via getUserConfigurableSettings's internal call to
    // getGlobalConfigurableSettings) for the rest of this file's module
    // instance.
    describe('getGlobalConfigurableSettings - caching (must run last)', () => {
        it('merges a seeded platform_configs row over defaults and caches it for subsequent calls', async () => {
            getByKeySpy.mockResolvedValue({ globalMessaging: { globalUserMessage: 'admin banner' } });

            const first = await getGlobalConfigurableSettings(FAKE_ENV);
            expect(first.globalMessaging.globalUserMessage).toBe('admin banner');
            expect(first.security.rateLimit).toEqual(DEFAULT_RATE_LIMIT);

            getByKeySpy.mockClear();
            const second = await getGlobalConfigurableSettings(FAKE_ENV);

            expect(second).toBe(first); // same cached object reference
            expect(getByKeySpy).not.toHaveBeenCalled();
        });
    });
});
