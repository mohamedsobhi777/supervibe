import { describe, expect, it } from 'bun:test';
import { StandaloneAgent } from '../src/standaloneAgent';
import { buildEnvAdapter } from '../src/envAdapter';
import { setRuntimeEnv } from 'worker/utils/runtimeEnv';
import { AppService } from 'worker/database';

/**
 * Regression coverage for the whole-branch review C1/C2 findings: both bugs
 * traced back to `DatabaseService` (worker/database/database.ts) touching
 * the poisoned `env.DB` binding on the standalone runtime's happy path.
 *
 * - C1: `BaseCodingBehavior.buildWrapper()`'s `finally` block constructs
 *   `AppService` and awaits `updateApp(...)` BEFORE clearing
 *   `generationPromise` and broadcasting `GENERATION_COMPLETE`. A throw
 *   there replaces normal completion, so the agent wedges permanently
 *   (`isCodeGenerating()` stuck true).
 * - C2: `getModelConfigsInfo()` constructs `ModelConfigService`, whose
 *   D1-backed `getModelConfigsInfo(userId)` throws immediately on
 *   construction (poisoned `env.DB`) and also on an empty `userId` — the
 *   standalone runtime's only path to `model_configs_info` is unreachable.
 */

function fakes() {
    const broadcasts: Array<Record<string, unknown>> = [];
    const persisted: unknown[] = [];
    return {
        broadcasts,
        persisted,
        transport: {
            ready: async () => {},
            broadcast: (m: Record<string, unknown>) => {
                broadcasts.push(m);
            },
            connection: {
                id: 'c1',
                send: (d: string) => {
                    broadcasts.push(JSON.parse(d));
                },
                url: null,
            },
            close: async () => {},
        },
        stateStore: {
            load: async () => null,
            persist: (s: unknown) => {
                persisted.push(s);
            },
            flush: async () => {},
        },
        conversationStore: {
            append: async () => {},
            loadAll: async () => [],
            clear: async () => {},
            replaceAll: async () => {},
        },
    };
}

describe('standalone runtime D1 seam (C1/C2 regression)', () => {
    it('C2: get_model_configs yields model_configs_info, not error, with no D1 and no userId', async () => {
        const f = fakes();
        const env = buildEnvAdapter({});
        setRuntimeEnv(env);

        const agent = await StandaloneAgent.boot({
            sessionId: 's-d1-seam-1',
            agentId: 'a-d1-seam-1',
            workspaceDir: '/tmp/vibesdk-test-d1-seam-1',
            env,
            transport: f.transport as never,
            stateStore: f.stateStore as never,
            conversationStore: f.conversationStore as never,
            sandbox: { shutdownInstance: async () => ({ success: true }) } as never,
            initArgs: undefined, // bare boot: no userId, no query
        });

        f.broadcasts.length = 0; // drop the boot-time agent_connected broadcast

        await agent.handleClientMessage(JSON.stringify({ type: 'get_model_configs' }));
        // GET_MODEL_CONFIGS resolves getModelConfigsInfo() via .then()/.catch()
        // rather than awaiting it inline (worker/agents/core/websocket.ts);
        // flush the microtask queue so that callback has run.
        await Promise.resolve();
        await Promise.resolve();

        const errorMessage = f.broadcasts.find((b) => b.type === 'error');
        expect(errorMessage).toBeUndefined();

        const configsMessage = f.broadcasts.find((b) => b.type === 'model_configs_info');
        expect(configsMessage).toBeDefined();
        const configs = configsMessage?.configs as { agents: unknown[]; userConfigs: object; defaultConfigs: object };
        expect(Array.isArray(configs.agents)).toBe(true);
        expect(configs.agents.length).toBeGreaterThan(0);
        expect(configs.userConfigs).toEqual({});
        expect(Object.keys(configs.defaultConfigs).length).toBeGreaterThan(0);
    });

    it('C1: AppService construction and updateApp() no-op instead of throwing under the poisoned DB binding', async () => {
        const env = buildEnvAdapter({});

        // This is the exact construction that base.ts's buildWrapper() finally
        // block performs (worker/agents/core/behaviors/base.ts): before this
        // fix, `new AppService(env)` threw synchronously because DatabaseService
        // unconditionally called Sentry.instrumentD1WithSentry(env.DB) against
        // the poisoned proxy, which replaces normal completion (generationPromise
        // clear + GENERATION_COMPLETE broadcast) with an unhandled throw.
        expect(() => new AppService(env)).not.toThrow();

        const appService = new AppService(env);
        const result = await appService.updateApp('some-agent-id', { status: 'completed' });
        // No-op D1 stub resolves the write cleanly; updateApp() returns true
        // rather than catching a thrown error and returning false.
        expect(result).toBe(true);
    });
});
