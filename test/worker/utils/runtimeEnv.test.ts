import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getRuntimeEnv, setRuntimeEnv } from 'worker/utils/runtimeEnv';

describe('runtimeEnv', () => {
    it('returns the env set at bootstrap', () => {
        setRuntimeEnv(env as never);
        expect(getRuntimeEnv()).toBe(env);
    });
});
