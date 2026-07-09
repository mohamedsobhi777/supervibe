import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { AppViewController } from '../../../worker/api/controllers/appView/controller';
import { BaseController } from '../../../worker/api/controllers/baseController';
import { AppService } from '../../../worker/database/services/AppService';
import { AgentStateService } from '../../../worker/database/services/AgentStateService';
import { AgentSessionService } from '../../../worker/database/services/AgentSessionService';
import * as agentSandboxBootModule from '../../../worker/services/sandbox/agentSandboxBoot';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from '../../../worker/utils/runtimeMode';
import type { RouteContext } from '../../../worker/api/types/route-context';
import type { ApiResponse } from '../../../worker/api/controllers/types';
import type { AppDetailsData } from '../../../worker/api/controllers/appView/types';
import type { EnhancedAppData } from '../../../worker/database/types';
import type { AgentStateJson, AgentSession } from '../../../worker/database/schema';
import type { AuthUser } from '../../../worker/types/auth-types';

/**
 * Unit tests for `GET /api/apps/:id` -> `AppViewController.getAppDetails`,
 * rewritten to source `agentSummary` from the agent runtime's
 * Postgres-persisted state (`agent_state`, via `AgentStateService`) and
 * `previewUrl` from the agent's sandbox (via `AgentSessionService` +
 * `getAgentPreviewUrl`), replacing the old Durable Object RPC
 * (`getAgentStubLightweight(...).getSummary()`/`getPreviewUrlCache()`) that
 * has no equivalent on this runtime. Collaborators are spied on their real
 * class prototypes / module namespace (imported here via the same
 * relative-path shape the controller itself uses) rather than `vi.mock`'d -
 * see the header comment in test/worker/api/agentBootstrap.test.ts for why
 * `vi.mock` does not work reliably under `@cloudflare/vitest-pool-workers`.
 */

const FAKE_ENV = {
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
    CUSTOM_DOMAIN: 'example.com',
} as unknown as Env;

function makeContext(appId: string | undefined): RouteContext {
    return {
        user: null,
        sessionId: null,
        config: {},
        pathParams: appId ? { id: appId } : {},
        queryParams: new URLSearchParams(),
    } as unknown as RouteContext;
}

function makeRequest(appId: string): Request {
    return new Request(`https://example.com/api/apps/${appId}`, { method: 'GET' });
}

function fakeEnhancedApp(overrides: Partial<EnhancedAppData> = {}): EnhancedAppData {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'app_1',
        title: 'Test App',
        description: null,
        iconUrl: null,
        originalPrompt: 'build a todo app',
        finalPrompt: null,
        framework: 'react',
        userId: 'owner-1',
        sessionToken: null,
        visibility: 'public',
        status: 'completed',
        deploymentId: null,
        githubRepositoryUrl: null,
        githubRepositoryVisibility: null,
        isArchived: false,
        isFeatured: false,
        version: 1,
        parentAppId: null,
        screenshotUrl: null,
        screenshotCapturedAt: null,
        createdAt: now,
        updatedAt: now,
        lastDeployedAt: null,
        userName: 'Owner Name',
        userAvatar: null,
        starCount: 2,
        userStarred: false,
        userFavorited: false,
        viewCount: 0,
        ...overrides,
    };
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

describe('GET /api/apps/:id -> AppViewController.getAppDetails', () => {
    let getOptionalUserSpy: MockInstance<typeof BaseController.getOptionalUser>;
    let getAppDetailsSpy: MockInstance<AppService['getAppDetails']>;
    let recordAppViewSpy: MockInstance<AppService['recordAppView']>;
    let getAgentStateSpy: MockInstance<AgentStateService['getAgentState']>;
    let getAgentSessionSpy: MockInstance<AgentSessionService['getAgentSession']>;
    let getAgentPreviewUrlSpy: MockInstance<typeof agentSandboxBootModule.getAgentPreviewUrl>;

    beforeEach(() => {
        getOptionalUserSpy = vi.spyOn(BaseController, 'getOptionalUser').mockResolvedValue(null);
        getAppDetailsSpy = vi.spyOn(AppService.prototype, 'getAppDetails').mockResolvedValue(null);
        recordAppViewSpy = vi.spyOn(AppService.prototype, 'recordAppView').mockResolvedValue(undefined);
        getAgentStateSpy = vi.spyOn(AgentStateService.prototype, 'getAgentState').mockResolvedValue(null);
        getAgentSessionSpy = vi.spyOn(AgentSessionService.prototype, 'getAgentSession').mockResolvedValue(null);
        getAgentPreviewUrlSpy = vi
            .spyOn(agentSandboxBootModule, 'getAgentPreviewUrl')
            .mockResolvedValue('https://preview.example');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns 400 and queries nothing when the :id path parameter is missing', async () => {
        const response = await AppViewController.getAppDetails(
            makeRequest('unused'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(undefined),
        );

        expect(response.status).toBe(400);
        expect(getAppDetailsSpy).not.toHaveBeenCalled();
    });

    it('returns 404 and fetches no agent state/session when the app does not exist', async () => {
        getAppDetailsSpy.mockResolvedValue(null);

        const response = await AppViewController.getAppDetails(
            makeRequest('app_missing'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_missing'),
        );

        expect(response.status).toBe(404);
        expect(getAgentStateSpy).not.toHaveBeenCalled();
        expect(getAgentSessionSpy).not.toHaveBeenCalled();
    });

    it('returns 404 when the app is private and the viewer is not the owner', async () => {
        getOptionalUserSpy.mockResolvedValue({ id: 'someone-else', email: 'x@e.com' } as AuthUser);
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp({ visibility: 'private', userId: 'owner-1' }));

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        expect(response.status).toBe(404);
        expect(recordAppViewSpy).not.toHaveBeenCalled();
    });

    it('builds agentSummary from agent_state when a row exists', async () => {
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp());
        const state: AgentStateJson = {
            query: 'build a todo app',
            generatedFilesMap: {
                'src/App.tsx': { filePath: 'src/App.tsx', fileContents: 'export default App;' },
            },
        };
        getAgentStateSpy.mockResolvedValue(state);

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        expect(response.status).toBe(200);
        const json = (await response.json()) as ApiResponse<AppDetailsData>;
        expect(json.success).toBe(true);
        expect(json.data?.agentSummary).toEqual({
            query: 'build a todo app',
            generatedCode: [{ filePath: 'src/App.tsx', fileContents: 'export default App;' }],
        });
        expect(getAgentStateSpy).toHaveBeenCalledWith('app_1');
    });

    it('returns agentSummary null when agent_state has no row yet', async () => {
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp());
        getAgentStateSpy.mockResolvedValue(null);

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        const json = (await response.json()) as ApiResponse<AppDetailsData>;
        expect(json.data?.agentSummary).toBeNull();
    });

    it('resolves previewUrl from the agent sandbox when the session has one', async () => {
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp({ deploymentId: null }));
        getAgentSessionSpy.mockResolvedValue(fakeAgentSession({ sessionId: 'app_1', sandboxId: 'sb_1' }));
        getAgentPreviewUrlSpy.mockResolvedValue('https://preview.example');

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        const json = (await response.json()) as ApiResponse<AppDetailsData>;
        expect(json.data?.previewUrl).toBe('https://preview.example');
        expect(getAgentPreviewUrlSpy).toHaveBeenCalledWith('sb_1', FAKE_ENV);
    });

    it('returns previewUrl and cloudflareUrl null when there is no session and no deploymentId', async () => {
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp({ deploymentId: null }));
        getAgentSessionSpy.mockResolvedValue(null);

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        const json = (await response.json()) as ApiResponse<AppDetailsData>;
        expect(json.data?.previewUrl).toBeNull();
        expect(json.data?.cloudflareUrl).toBeNull();
        expect(getAgentPreviewUrlSpy).not.toHaveBeenCalled();
    });

    it('falls back to cloudflareUrl (best-effort) when getAgentPreviewUrl throws', async () => {
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp({ deploymentId: 'deploy_1' }));
        getAgentSessionSpy.mockResolvedValue(fakeAgentSession({ sessionId: 'app_1', sandboxId: 'sb_1' }));
        getAgentPreviewUrlSpy.mockRejectedValueOnce(new Error('sandbox unavailable'));

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        expect(response.status).toBe(200);
        const json = (await response.json()) as ApiResponse<AppDetailsData>;
        expect(json.data?.cloudflareUrl).toBeTruthy();
        expect(json.data?.previewUrl).toBe(json.data?.cloudflareUrl);
    });

    it('does not call getAgentPreviewUrl when the session has no sandboxId', async () => {
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp({ deploymentId: null }));
        getAgentSessionSpy.mockResolvedValue(fakeAgentSession({ sessionId: 'app_1', sandboxId: null }));

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        const json = (await response.json()) as ApiResponse<AppDetailsData>;
        expect(json.data?.previewUrl).toBeNull();
        expect(getAgentPreviewUrlSpy).not.toHaveBeenCalled();
    });

    it('records an anonymous view when there is no authenticated user', async () => {
        getOptionalUserSpy.mockResolvedValue(null);
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp({ visibility: 'public' }));

        await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        expect(recordAppViewSpy).toHaveBeenCalledWith('app_1', expect.stringMatching(/^anonymous-/));
    });

    it('records an authenticated view when there is a user', async () => {
        getOptionalUserSpy.mockResolvedValue({ id: 'viewer-1', email: 'v@e.com' } as AuthUser);
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp({ visibility: 'public' }));

        await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        expect(recordAppViewSpy).toHaveBeenCalledWith('app_1', 'viewer-1');
    });

    it('passes real starCount/userFavorited through from AppService untouched', async () => {
        getAppDetailsSpy.mockResolvedValue(fakeEnhancedApp({ starCount: 7, userStarred: true, userFavorited: true }));

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        const json = (await response.json()) as ApiResponse<AppDetailsData>;
        expect(json.data?.starCount).toBe(7);
        expect(json.data?.userStarred).toBe(true);
        expect(json.data?.userFavorited).toBe(true);
    });

    it('returns 500 without crashing when AppService.getAppDetails throws', async () => {
        getAppDetailsSpy.mockRejectedValue(new Error('db unavailable'));

        const response = await AppViewController.getAppDetails(
            makeRequest('app_1'),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext('app_1'),
        );

        expect(response.status).toBe(500);
    });
});
