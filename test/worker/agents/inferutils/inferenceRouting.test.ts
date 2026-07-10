import { describe, expect, it } from 'vitest';
import { getConfigurationForModel } from 'worker/agents/inferutils/core';
import { ModelSize, type AIModelConfig } from 'worker/agents/inferutils/config.types';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from 'worker/utils/runtimeMode';

/**
 * Regression coverage for the gateway-less inference routing on the Phoenix
 * (non-Cloudflare) stack. The standalone agent runtime sets `env.AI` to a
 * truthy poison proxy (agent-runtime/src/envAdapter.ts); a bare `!env.AI`
 * check therefore fails to detect "no platform gateway", and the code would
 * dereference `env.AI.gateway(...)` and throw on every LLM call. The fix makes
 * the decision `isStandaloneRuntime(env)`-aware — these tests lock that in.
 */

const OPENAI_MODEL: AIModelConfig = {
    name: 'openai/gpt-5-mini',
    size: ModelSize.LITE,
    provider: 'openai',
    creditCost: 1,
    contextSize: 400_000,
};

const VALID_KEY = 'sk-test-key-1234567890';

/**
 * Truthy proxy that throws the moment any property is read — a faithful
 * stand-in for the standalone runtime's poisoned `AI` binding. If the
 * direct-vs-gateway decision ever dereferences `env.AI.gateway(...)`, the
 * test fails with this exact message instead of the assertion below.
 */
function poisonedAI(): unknown {
    return new Proxy(
        {},
        {
            get() {
                throw new Error('Unsupported binding "AI" in standalone agent runtime');
            },
            apply() {
                throw new Error('Unsupported binding "AI" in standalone agent runtime');
            },
        },
    );
}

describe('getConfigurationForModel — gateway-less provider routing', () => {
    it('routes to the direct OpenAI endpoint in the standalone runtime without dereferencing the poisoned AI binding', async () => {
        const env = {
            [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
            AI: poisonedAI(),
            OPENAI_API_KEY: VALID_KEY,
        } as unknown as Env;

        const result = await getConfigurationForModel(OPENAI_MODEL, env, 'user-1');

        expect(result.isDirect).toBe(true);
        expect(result.baseURL).toBe('https://api.openai.com/v1/');
        expect(result.apiKey).toBe(VALID_KEY);
    });

    it('routes direct on the Vercel worker as well (AI binding genuinely absent, no gateway URL)', async () => {
        const env = { OPENAI_API_KEY: VALID_KEY } as unknown as Env;

        const result = await getConfigurationForModel(OPENAI_MODEL, env, 'user-1');

        expect(result.isDirect).toBe(true);
        expect(result.baseURL).toBe('https://api.openai.com/v1/');
    });

    it('still honors an explicit CLOUDFLARE_AI_GATEWAY_URL in the standalone runtime (gateway wins, AI binding untouched)', async () => {
        const env = {
            [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
            AI: poisonedAI(),
            OPENAI_API_KEY: VALID_KEY,
            CLOUDFLARE_AI_GATEWAY_URL: 'https://gateway.example.com/v1',
        } as unknown as Env;

        const result = await getConfigurationForModel(OPENAI_MODEL, env, 'user-1');

        expect(result.isDirect).toBeFalsy();
        expect(result.baseURL).toContain('gateway.example.com');
    });
});
