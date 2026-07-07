/**
 * Process-global Env holder so agent code can run both on Workers (set from
 * `cloudflare:workers` at entry) and in the standalone Bun runtime (set from
 * an adapter over process.env). Direct `import { env } from
 * 'cloudflare:workers'` is unresolvable under Bun, so agent-tree modules must
 * read env through this seam instead.
 */
let runtimeEnv: Env | undefined;

export function setRuntimeEnv(e: Env): void {
    runtimeEnv = e;
}

export function getRuntimeEnv(): Env {
    if (!runtimeEnv) {
        throw new Error('Runtime env not initialized — call setRuntimeEnv() at process bootstrap');
    }
    return runtimeEnv;
}
