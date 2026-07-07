/// <reference path="../../worker-configuration.d.ts" />

/**
 * Builds an Env-shaped object for the standalone runtime. String vars come
 * from process.env; Workers bindings are poisoned proxies so any code path
 * that would need Cloudflare infrastructure fails loudly and by name.
 */
const POISONED_BINDINGS = [
    'AI', 'DB', 'Sandbox', 'DISPATCHER', 'CodeGenObject', 'UserSecretsStore',
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
    return env as unknown as Env;
}
