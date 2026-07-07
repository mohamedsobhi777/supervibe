/// <reference path="../../worker-configuration.d.ts" />

import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';

/**
 * Builds an Env-shaped object for the standalone runtime. String vars come
 * from process.env; Workers bindings are poisoned proxies so any code path
 * that would need Cloudflare infrastructure fails loudly and by name.
 *
 * `DB` is deliberately excluded from the poison list: `DatabaseService`
 * (worker/database/database.ts) reads the `RUNTIME_MODE` sentinel set below
 * and substitutes a no-op D1 stub instead of touching this binding, so `DB`
 * never needs a value here at all — see `isStandaloneRuntime()`.
 */
const POISONED_BINDINGS = [
    'AI', 'Sandbox', 'DISPATCHER', 'CodeGenObject', 'UserSecretsStore',
    'THINK_DO', 'SPACE_DO', 'TEMPLATES_BUCKET', 'VibecoderStore',
] as const;

function poisoned(name: string): unknown {
    return new Proxy({}, {
        get() { throw new Error(`Unsupported binding "${name}" in standalone agent runtime`); },
        apply() { throw new Error(`Unsupported binding "${name}" in standalone agent runtime`); },
    });
}

export function buildEnvAdapter(source: Record<string, string | undefined> = process.env): Env {
    const env: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined) env[key] = value;
    }
    for (const name of POISONED_BINDINGS) {
        env[name] = poisoned(name);
    }
    // Plain string marker (not a poisoned proxy): lets D1-backed services
    // detect the standalone runtime and degrade gracefully instead of
    // throwing. See worker/utils/runtimeMode.ts.
    env[RUNTIME_MODE_KEY] = STANDALONE_RUNTIME_MODE;
    return env as unknown as Env;
}
