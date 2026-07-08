import { describe, expect, it } from 'vitest';
import { bootAgentSandbox, getAgentPreviewUrl } from 'worker/services/sandbox/agentSandboxBoot';
import type { CommandOptions, CommandResult, ConnectionOptions, Sandbox, SandboxCreateOptions } from '@superserve/sdk';

const BASE_ENV = {
    SUPERSERVE_API_KEY: 'ss_test_key',
    SUPABASE_URL: 'https://xyzcompany.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key-value',
    TEMPLATES_BASE_URL: 'https://templates.example.com',
} as unknown as Env;

interface RecordedRun {
    command: string;
    options?: CommandOptions;
}

interface FakeApi {
    create: (options: SandboxCreateOptions) => Promise<Sandbox>;
    createCalls: SandboxCreateOptions[];
    runCalls: RecordedRun[];
    previewUrlCalls: number[];
}

function makeFakeApi(overrides?: { sandboxId?: string; previewUrl?: string }): FakeApi {
    const sandboxId = overrides?.sandboxId ?? 'sandbox-abc123';
    const previewUrl = overrides?.previewUrl ?? 'https://8080-sandbox-abc123.superserve.dev';
    const createCalls: SandboxCreateOptions[] = [];
    const runCalls: RecordedRun[] = [];
    const previewUrlCalls: number[] = [];

    const fakeSandbox = {
        id: sandboxId,
        commands: {
            run: async (command: string, options?: CommandOptions): Promise<CommandResult> => {
                runCalls.push({ command, options });
                return { stdout: '4242\n', stderr: '', exitCode: 0 };
            },
        },
        getPreviewUrl: (port: number): string => {
            previewUrlCalls.push(port);
            return previewUrl;
        },
    } as unknown as Sandbox;

    return {
        create: async (options: SandboxCreateOptions): Promise<Sandbox> => {
            createCalls.push(options);
            return fakeSandbox;
        },
        createCalls,
        runCalls,
        previewUrlCalls,
    };
}

describe('bootAgentSandbox', () => {
    it('creates a sandbox named after the session from the default template', async () => {
        const fake = makeFakeApi();

        await bootAgentSandbox({
            sessionId: 'session-1',
            agentId: 'agent-1',
            sessionJwt: 'jwt-token',
            env: BASE_ENV,
            api: fake,
        });

        expect(fake.createCalls).toHaveLength(1);
        const options = fake.createCalls[0];
        expect(options.name).toBe('agent-session-1');
        expect(options.fromTemplate).toBe('vibesdk-agent');
        expect(options.baseUrl).toBeUndefined();
        expect(options.metadata).toEqual({ vibesdk_kind: 'agent', vibesdk_session: 'session-1' });
    });

    it('builds the agent bootstrap envVars contract', async () => {
        const fake = makeFakeApi();

        await bootAgentSandbox({
            sessionId: 'session-2',
            agentId: 'agent-2',
            sessionJwt: 'jwt-session-2',
            env: BASE_ENV,
            api: fake,
        });

        const envVars = fake.createCalls[0].envVars ?? {};
        expect(envVars.SESSION_ID).toBe('session-2');
        expect(envVars.AGENT_ID).toBe('agent-2');
        expect(envVars.WORKSPACE_DIR).toBe('/workspace');
        expect(envVars.SUPABASE_SESSION_JWT).toBe('jwt-session-2');
        expect(envVars.SUPABASE_URL).toBe('https://xyzcompany.supabase.co');
        expect(envVars.SUPABASE_ANON_KEY).toBe('anon-key-value');
        expect(envVars.TEMPLATES_BASE_URL).toBe('https://templates.example.com');
    });

    it('adds CLOUDFLARE_AI_GATEWAY envVars only when present in env', async () => {
        const fakeWithout = makeFakeApi();
        await bootAgentSandbox({
            sessionId: 'session-7',
            agentId: 'agent-7',
            sessionJwt: 'jwt-7',
            env: BASE_ENV,
            api: fakeWithout,
        });
        expect(fakeWithout.createCalls[0].envVars?.CLOUDFLARE_AI_GATEWAY_URL).toBeUndefined();
        expect(fakeWithout.createCalls[0].envVars?.CLOUDFLARE_AI_GATEWAY_TOKEN).toBeUndefined();

        const fakeWith = makeFakeApi();
        const envWithGateway = {
            ...BASE_ENV,
            CLOUDFLARE_AI_GATEWAY_URL: 'https://gateway.example.com',
            CLOUDFLARE_AI_GATEWAY_TOKEN: 'gw-token',
        } as unknown as Env;
        await bootAgentSandbox({
            sessionId: 'session-8',
            agentId: 'agent-8',
            sessionJwt: 'jwt-8',
            env: envWithGateway,
            api: fakeWith,
        });
        expect(fakeWith.createCalls[0].envVars?.CLOUDFLARE_AI_GATEWAY_URL).toBe('https://gateway.example.com');
        expect(fakeWith.createCalls[0].envVars?.CLOUDFLARE_AI_GATEWAY_TOKEN).toBe('gw-token');
    });

    it('allows egress to the Supabase project host plus the default allowlist', async () => {
        const fake = makeFakeApi();

        await bootAgentSandbox({
            sessionId: 'session-3',
            agentId: 'agent-3',
            sessionJwt: 'jwt-3',
            env: BASE_ENV,
            api: fake,
        });

        const allowOut = fake.createCalls[0].network?.allowOut ?? [];
        expect(allowOut).toContain('xyzcompany.supabase.co');
        expect(allowOut).toContain('registry.npmjs.org');
    });

    it('starts the agent process detached via setsid/nohup with a 15s timeout', async () => {
        const fake = makeFakeApi();

        await bootAgentSandbox({
            sessionId: 'session-4',
            agentId: 'agent-4',
            sessionJwt: 'jwt-4',
            env: BASE_ENV,
            api: fake,
        });

        expect(fake.runCalls).toHaveLength(1);
        const { command, options } = fake.runCalls[0];
        expect(command).toContain('setsid nohup');
        expect(command).toContain('bun agent-runtime/src/main.ts');
        expect(command).toContain('& echo $!');
        expect(options?.timeoutMs).toBe(15_000);
    });

    it('returns the sandbox id and the port-8080 preview URL', async () => {
        const fake = makeFakeApi({
            sandboxId: 'sandbox-xyz',
            previewUrl: 'https://8080-sandbox-xyz.superserve.dev',
        });

        const result = await bootAgentSandbox({
            sessionId: 'session-5',
            agentId: 'agent-5',
            sessionJwt: 'jwt-5',
            env: BASE_ENV,
            api: fake,
        });

        expect(fake.previewUrlCalls).toEqual([8080]);
        expect(result).toEqual({
            sandboxId: 'sandbox-xyz',
            previewUrl: 'https://8080-sandbox-xyz.superserve.dev',
        });
    });

    it('honors a SUPERSERVE_AGENT_TEMPLATE override', async () => {
        const fake = makeFakeApi();
        const env = {
            ...BASE_ENV,
            SUPERSERVE_AGENT_TEMPLATE: 'custom-agent-template',
        } as unknown as Env;

        await bootAgentSandbox({
            sessionId: 'session-6',
            agentId: 'agent-6',
            sessionJwt: 'jwt-6',
            env,
            api: fake,
        });

        expect(fake.createCalls[0].fromTemplate).toBe('custom-agent-template');
    });

    it('throws listing SUPERSERVE_API_KEY when it is missing', async () => {
        const fake = makeFakeApi();
        const env = { ...BASE_ENV, SUPERSERVE_API_KEY: undefined } as unknown as Env;

        await expect(
            bootAgentSandbox({ sessionId: 's', agentId: 'a', sessionJwt: 'j', env, api: fake }),
        ).rejects.toThrow('SUPERSERVE_API_KEY');
        expect(fake.createCalls).toHaveLength(0);
    });

    it('throws listing SUPABASE_URL when it is missing', async () => {
        const fake = makeFakeApi();
        const env = { ...BASE_ENV, SUPABASE_URL: undefined } as unknown as Env;

        await expect(
            bootAgentSandbox({ sessionId: 's', agentId: 'a', sessionJwt: 'j', env, api: fake }),
        ).rejects.toThrow('SUPABASE_URL');
        expect(fake.createCalls).toHaveLength(0);
    });
});

interface RecordedConnectCall {
    sandboxId: string;
    options?: ConnectionOptions;
}

interface FakeConnectApi {
    connect: (sandboxId: string, options?: ConnectionOptions) => Promise<Sandbox>;
    connectCalls: RecordedConnectCall[];
    previewUrlCalls: number[];
}

function makeFakeConnectApi(overrides?: { previewUrl?: string }): FakeConnectApi {
    const previewUrl = overrides?.previewUrl ?? 'https://8080-sandbox-abc123.superserve.dev';
    const connectCalls: RecordedConnectCall[] = [];
    const previewUrlCalls: number[] = [];

    const fakeSandbox = {
        getPreviewUrl: (port: number): string => {
            previewUrlCalls.push(port);
            return previewUrl;
        },
    } as unknown as Sandbox;

    return {
        connect: async (sandboxId: string, options?: ConnectionOptions): Promise<Sandbox> => {
            connectCalls.push({ sandboxId, options });
            return fakeSandbox;
        },
        connectCalls,
        previewUrlCalls,
    };
}

describe('getAgentPreviewUrl', () => {
    it('reconnects to the sandbox with the configured api key/base url and returns the port-8080 preview url', async () => {
        const fake = makeFakeConnectApi({ previewUrl: 'https://8080-sandbox-abc123.superserve.dev' });
        const env = {
            SUPERSERVE_API_KEY: 'ss_test_key',
            SUPERSERVE_BASE_URL: 'https://api.superserve.example',
        } as unknown as Env;

        const result = await getAgentPreviewUrl('sandbox-abc123', env, fake);

        expect(fake.connectCalls).toEqual([
            {
                sandboxId: 'sandbox-abc123',
                options: { apiKey: 'ss_test_key', baseUrl: 'https://api.superserve.example' },
            },
        ]);
        expect(fake.previewUrlCalls).toEqual([8080]);
        expect(result).toBe('https://8080-sandbox-abc123.superserve.dev');
    });

    it('omits baseUrl when SUPERSERVE_BASE_URL is not configured', async () => {
        const fake = makeFakeConnectApi();
        const env = { SUPERSERVE_API_KEY: 'ss_test_key' } as unknown as Env;

        await getAgentPreviewUrl('sandbox-1', env, fake);

        expect(fake.connectCalls).toHaveLength(1);
        expect(fake.connectCalls[0].options?.apiKey).toBe('ss_test_key');
        expect(fake.connectCalls[0].options?.baseUrl).toBeUndefined();
    });

    it('throws listing SUPERSERVE_API_KEY when it is missing', async () => {
        const fake = makeFakeConnectApi();
        const env = {} as unknown as Env;

        await expect(getAgentPreviewUrl('sandbox-1', env, fake)).rejects.toThrow('SUPERSERVE_API_KEY');
        expect(fake.connectCalls).toHaveLength(0);
    });
});
