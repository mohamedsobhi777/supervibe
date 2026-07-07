/**
 * Detects the standalone agent runtime (agent-runtime/, a plain Bun process)
 * versus the Workers runtime, without requiring a change to the generated
 * `worker-configuration.d.ts` Env type.
 *
 * `agent-runtime/src/envAdapter.ts` sets `env[RUNTIME_MODE_KEY]` to
 * `STANDALONE_RUNTIME_MODE` as a plain string (not a poisoned binding).
 * Workers `Env` never sets this key, so `isStandaloneRuntime()` is false
 * for every real Workers `env` and the Workers code path is unaffected.
 */
export const RUNTIME_MODE_KEY = 'RUNTIME_MODE';
export const STANDALONE_RUNTIME_MODE = 'standalone';

export function isStandaloneRuntime(env: Env): boolean {
    return (env as unknown as Record<string, unknown>)[RUNTIME_MODE_KEY] === STANDALONE_RUNTIME_MODE;
}
