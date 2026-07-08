import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { CodingAgentController } from '../../../worker/api/controllers/agent/controller';
import { AgentSessionService } from '../../../worker/database/services/AgentSessionService';
import * as sessionJwtModule from '../../../worker/services/auth/sessionJwt';
import * as agentSandboxBootModule from '../../../worker/services/sandbox/agentSandboxBoot';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from '../../../worker/utils/runtimeMode';
import type { RouteContext } from '../../../worker/api/types/route-context';
import type { ApiResponse } from '../../../worker/api/controllers/types';
import type { AgentBootstrapResponse } from '../../../worker/api/controllers/agent/types';
import type { AgentSession } from '../../../worker/database/schema';

/**
 * Unit tests for `GET /api/agent/:agentId/connect` -> `CodingAgentController.connectToAgent`.
 * Collaborators are spied on their real class prototypes / module namespace
 * (imported here via the same relative-path shape the controller itself
 * uses) rather than `vi.mock`'d - see the header comment in
 * test/worker/api/agentBootstrap.test.ts for why `vi.mock` does not work
 * reliably under `@cloudflare/vitest-pool-workers`.
 */

const FAKE_ENV = {
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

function makeContext(agentId: string | undefined, userId = 'user_1'): RouteContext {
    return {
        user: { id: userId, email: 'u@e.com' },
        sessionId: null,
        config: {},
        pathParams: agentId ? { agentId } : {},
        queryParams: new URLSearchParams(),
    } as unknown as RouteContext;
}

function makeRequest(agentId: string): Request {
    return new Request(`https://example.com/api/agent/${agentId}/connect`, { method: 'GET' });
}

function fakeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        sessionId: 'session-placeholder',
        agentId: 'agent-placeholder',
        userId: null,
        status: 'provisioning',
        initArgs: null,
        sandboxId: null,
        lastActivityAt: now,
        createdAt: now,
        ...overrides,
    };
}

describe('GET /api/agent/:agentId/connect -> CodingAgentController.connectToAgent', () => {
    let getAgentSessionSpy: MockInstance<AgentSessionService['getAgentSession']>;
    let mintSessionJwtSpy: MockInstance<typeof sessionJwtModule.mintSessionJwt>;
    let getAgentPreviewUrlSpy: MockInstance<typeof agentSandboxBootModule.getAgentPreviewUrl>;

    beforeEach(() => {
        // Safe no-op default (never touches the real DB layer); every test
        // overrides this with the session shape it needs before invoking
        // the controller.
        getAgentSessionSpy = vi.spyOn(AgentSessionService.prototype, 'getAgentSession').mockResolvedValue(null);

        mintSessionJwtSpy = vi.spyOn(sessionJwtModule, 'mintSessionJwt').mockResolvedValue('mock.session.jwt');

        getAgentPreviewUrlSpy = vi
            .spyOn(agentSandboxBootModule, 'getAgentPreviewUrl')
            .mockResolvedValue('https://preview.example');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns the bootstrap envelope with a resolved preview url when the session has a sandbox', async () => {
        getAgentSessionSpy.mockResolvedValue(
            fakeAgentSession({ sessionId: 'agent_1', agentId: 'agent_1', sandboxId: 'sb_1' }),
        );

        const response = await CodingAgentController.connectToAgent(
            makeRequest('agent_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('agent_1'),
        );

        expect(response.status).toBe(200);
        const json = (await response.json()) as ApiResponse<AgentBootstrapResponse>;
        expect(json.success).toBe(true);
        const data = json.data as AgentBootstrapResponse;

        expect(data).toEqual({
            agentId: 'agent_1',
            sessionId: 'agent_1',
            realtimeChannel: 'session:agent_1',
            previewUrl: 'https://preview.example',
            token: 'mock.session.jwt',
        });

        expect(getAgentSessionSpy).toHaveBeenCalledWith('agent_1');
        expect(mintSessionJwtSpy).toHaveBeenCalledWith('agent_1', FAKE_ENV);
        expect(getAgentPreviewUrlSpy).toHaveBeenCalledWith('sb_1', FAKE_ENV);
    });

    it('returns previewUrl null and skips getAgentPreviewUrl when the session has no sandbox yet', async () => {
        getAgentSessionSpy.mockResolvedValue(
            fakeAgentSession({ sessionId: 'agent_2', agentId: 'agent_2', sandboxId: null }),
        );

        const response = await CodingAgentController.connectToAgent(
            makeRequest('agent_2'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('agent_2'),
        );

        expect(response.status).toBe(200);
        const json = (await response.json()) as ApiResponse<AgentBootstrapResponse>;
        expect(json.success).toBe(true);
        const data = json.data as AgentBootstrapResponse;

        expect(data.previewUrl).toBeNull();
        expect(data.token).toBe('mock.session.jwt');
        expect(getAgentPreviewUrlSpy).not.toHaveBeenCalled();
    });

    it('returns previewUrl null (best-effort) when getAgentPreviewUrl throws', async () => {
        getAgentSessionSpy.mockResolvedValue(
            fakeAgentSession({ sessionId: 'agent_3', agentId: 'agent_3', sandboxId: 'sb_3' }),
        );
        getAgentPreviewUrlSpy.mockRejectedValueOnce(new Error('sandbox unavailable'));

        const response = await CodingAgentController.connectToAgent(
            makeRequest('agent_3'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('agent_3'),
        );

        expect(response.status).toBe(200);
        const json = (await response.json()) as ApiResponse<AgentBootstrapResponse>;
        expect(json.success).toBe(true);
        const data = json.data as AgentBootstrapResponse;

        expect(data.previewUrl).toBeNull();
        expect(data.token).toBe('mock.session.jwt');
    });

    it('returns 404 and mints no token when the agent session does not exist', async () => {
        getAgentSessionSpy.mockResolvedValue(null);

        const response = await CodingAgentController.connectToAgent(
            makeRequest('agent_missing'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('agent_missing'),
        );

        expect(response.status).toBe(404);
        const json = (await response.json()) as ApiResponse<AgentBootstrapResponse>;
        expect(json.success).toBe(false);
        expect(json.data).toBeUndefined();

        expect(mintSessionJwtSpy).not.toHaveBeenCalled();
        expect(getAgentPreviewUrlSpy).not.toHaveBeenCalled();
    });

    it('returns 400 when the :agentId path parameter is missing', async () => {
        const response = await CodingAgentController.connectToAgent(
            makeRequest('unused'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(undefined),
        );

        expect(response.status).toBe(400);
        expect(getAgentSessionSpy).not.toHaveBeenCalled();
    });

    // Ownership (403) is enforced by the `setAuthLevel(AuthConfig.ownerOnly)`
    // route middleware via `checkAppOwnership`, not by this controller, so
    // it is intentionally not exercised here.
});
