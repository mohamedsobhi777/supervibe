import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { handleGitProtocolRequest } from '../../../worker/api/handlers/git-protocol';
import { AppService } from '../../../worker/database/services/AppService';
import { AgentSessionService } from '../../../worker/database/services/AgentSessionService';
import { AgentStateService } from '../../../worker/database/services/AgentStateService';
import * as agentSandboxBootModule from '../../../worker/services/sandbox/agentSandboxBoot';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from '../../../worker/utils/runtimeMode';
import type { AgentSession } from '../../../worker/database/schema';
import type { EnhancedAppData } from '../../../worker/database/types';

/**
 * Unit tests for the git smart-HTTP `info/refs` endpoint
 * (`handleGitProtocolRequest` -> `handleInfoRefs`,
 * worker/api/handlers/git-protocol.ts), rewritten to source `gitObjects`
 * from the agent's Superserve sandbox (via `extractSandboxGitObjects` +
 * `AgentSessionService`) and `query` from the agent runtime's
 * Postgres-persisted state (`AgentStateService`), replacing the retired
 * Durable Object RPC (`agentStub.exportGitObjects()` /
 * `agentStub.isInitialized()`) that has no equivalent on this runtime.
 *
 * This is the "controller test" for the exportGitObjects rewiring rather
 * than `GitHubExporterController` (worker/api/controllers/githubExporter) -
 * that controller statically imports `GitHubService`, whose `@octokit/rest`
 * dependency chain hits the same pre-existing, already-documented
 * `content-type` named-export interop failure this pool cannot resolve
 * (see vitest.config.ts's `capabilities.test.ts` exclude comment: "The
 * requested module 'content-type' does not provide an export named
 * 'parse'", independent of anything under test - verified directly by
 * importing GitHubExporterController alone here). `handleGitProtocolRequest`
 * exercises the identical rewiring (extractSandboxGitObjects +
 * AgentSessionService + AgentStateService, no-session -> error path) without
 * that dependency, so it stays in the standard vitest-pool-workers project
 * with the same `vi.spyOn` conventions as the rest of this directory.
 *
 * Collaborators are spied on their real class prototypes / module namespace
 * (imported here via the same relative-path shape git-protocol.ts itself
 * uses) rather than `vi.mock`'d - see the header comment in
 * test/worker/api/agentBootstrap.test.ts for why `vi.mock` does not work
 * reliably under `@cloudflare/vitest-pool-workers`.
 */

// RUNTIME_MODE_KEY routes AppService's Postgres client (worker/database/pgConnection.ts)
// to the no-op stand-in instead of a real Supabase connection - the same
// pattern test/worker/api/appDetails.test.ts uses for the same reason.
const FAKE_ENV = {
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

const FAKE_EXECUTION_CONTEXT: ExecutionContext = {
    waitUntil(): void {},
    passThroughOnException(): void {},
    props: undefined,
};

const EMPTY_ADVERTISEMENT = '001e# service=git-upload-pack\n0000';

function makeInfoRefsRequest(appId: string): Request {
    return new Request(`https://example.com/apps/${appId}.git/info/refs?service=git-upload-pack`, {
        method: 'GET',
    });
}

function makeUploadPackRequest(appId: string): Request {
    return new Request(`https://example.com/apps/${appId}.git/git-upload-pack`, {
        method: 'POST',
    });
}

function fakePublicApp(overrides: Partial<EnhancedAppData> = {}): EnhancedAppData {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'a1b2c3d4',
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
        starCount: 0,
        userStarred: false,
        userFavorited: false,
        viewCount: 0,
        ...overrides,
    } as EnhancedAppData;
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

describe('GET /apps/:id.git/info/refs -> handleGitProtocolRequest', () => {
    let getAppDetailsSpy: MockInstance<AppService['getAppDetails']>;
    let getAgentSessionSpy: MockInstance<AgentSessionService['getAgentSession']>;
    let getAgentStateSpy: MockInstance<AgentStateService['getAgentState']>;
    let extractSandboxGitObjectsSpy: MockInstance<typeof agentSandboxBootModule.extractSandboxGitObjects>;

    beforeEach(() => {
        getAppDetailsSpy = vi.spyOn(AppService.prototype, 'getAppDetails').mockResolvedValue(fakePublicApp());
        getAgentSessionSpy = vi.spyOn(AgentSessionService.prototype, 'getAgentSession').mockResolvedValue(null);
        getAgentStateSpy = vi.spyOn(AgentStateService.prototype, 'getAgentState').mockResolvedValue(null);
        extractSandboxGitObjectsSpy = vi
            .spyOn(agentSandboxBootModule, 'extractSandboxGitObjects')
            .mockResolvedValue([]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('extracts git objects from the sandbox and returns the empty advertisement when the sandbox has no commits', async () => {
        getAgentSessionSpy.mockResolvedValue(fakeAgentSession({ sessionId: 'a1b2c3d4', sandboxId: 'sb_1' }));
        getAgentStateSpy.mockResolvedValue({ query: 'build a todo app' });
        extractSandboxGitObjectsSpy.mockResolvedValue([]);

        const response = await handleGitProtocolRequest(
            makeInfoRefsRequest('a1b2c3d4'),
            FAKE_ENV,
            FAKE_EXECUTION_CONTEXT,
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(EMPTY_ADVERTISEMENT);

        expect(getAgentSessionSpy).toHaveBeenCalledWith('a1b2c3d4');
        expect(extractSandboxGitObjectsSpy).toHaveBeenCalledWith('sb_1', FAKE_ENV);
        expect(getAgentStateSpy).toHaveBeenCalledWith('a1b2c3d4');
    });

    it('returns 404 and never extracts git objects when the agent session has no sandbox yet', async () => {
        getAgentSessionSpy.mockResolvedValue(fakeAgentSession({ sessionId: 'a1b2c3d4', sandboxId: null }));

        const response = await handleGitProtocolRequest(
            makeInfoRefsRequest('a1b2c3d4'),
            FAKE_ENV,
            FAKE_EXECUTION_CONTEXT,
        );

        expect(response.status).toBe(404);
        expect(extractSandboxGitObjectsSpy).not.toHaveBeenCalled();
    });

    it('returns 404 and never extracts git objects when there is no agent session at all', async () => {
        getAgentSessionSpy.mockResolvedValue(null);

        const response = await handleGitProtocolRequest(
            makeInfoRefsRequest('a1b2c3d4'),
            FAKE_ENV,
            FAKE_EXECUTION_CONTEXT,
        );

        expect(response.status).toBe(404);
        expect(extractSandboxGitObjectsSpy).not.toHaveBeenCalled();
    });

    it('returns 401 and never resolves a session when the app does not exist', async () => {
        getAppDetailsSpy.mockResolvedValue(null);

        const response = await handleGitProtocolRequest(
            makeInfoRefsRequest('a1b2c3d4'),
            FAKE_ENV,
            FAKE_EXECUTION_CONTEXT,
        );

        expect(response.status).toBe(401);
        expect(getAgentSessionSpy).not.toHaveBeenCalled();
    });

    it('returns 500 without crashing when extractSandboxGitObjects throws', async () => {
        getAgentSessionSpy.mockResolvedValue(fakeAgentSession({ sessionId: 'a1b2c3d4', sandboxId: 'sb_1' }));
        extractSandboxGitObjectsSpy.mockRejectedValue(new Error('sandbox unreachable'));

        const response = await handleGitProtocolRequest(
            makeInfoRefsRequest('a1b2c3d4'),
            FAKE_ENV,
            FAKE_EXECUTION_CONTEXT,
        );

        expect(response.status).toBe(500);
    });
});

describe('POST /apps/:id.git/git-upload-pack -> handleGitProtocolRequest', () => {
    let getAgentSessionSpy: MockInstance<AgentSessionService['getAgentSession']>;
    let extractSandboxGitObjectsSpy: MockInstance<typeof agentSandboxBootModule.extractSandboxGitObjects>;

    beforeEach(() => {
        vi.spyOn(AppService.prototype, 'getAppDetails').mockResolvedValue(fakePublicApp());
        getAgentSessionSpy = vi.spyOn(AgentSessionService.prototype, 'getAgentSession').mockResolvedValue(null);
        vi.spyOn(AgentStateService.prototype, 'getAgentState').mockResolvedValue(null);
        extractSandboxGitObjectsSpy = vi
            .spyOn(agentSandboxBootModule, 'extractSandboxGitObjects')
            .mockResolvedValue([]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('extracts git objects from the sandbox and returns 404 (no commits to pack) when the sandbox has no commits', async () => {
        getAgentSessionSpy.mockResolvedValue(fakeAgentSession({ sessionId: 'a1b2c3d4', sandboxId: 'sb_2' }));
        extractSandboxGitObjectsSpy.mockResolvedValue([]);

        const response = await handleGitProtocolRequest(
            makeUploadPackRequest('a1b2c3d4'),
            FAKE_ENV,
            FAKE_EXECUTION_CONTEXT,
        );

        expect(response.status).toBe(404);
        expect(extractSandboxGitObjectsSpy).toHaveBeenCalledWith('sb_2', FAKE_ENV);
    });

    it('returns 404 and never extracts git objects when the agent session has no sandbox yet', async () => {
        getAgentSessionSpy.mockResolvedValue(fakeAgentSession({ sessionId: 'a1b2c3d4', sandboxId: null }));

        const response = await handleGitProtocolRequest(
            makeUploadPackRequest('a1b2c3d4'),
            FAKE_ENV,
            FAKE_EXECUTION_CONTEXT,
        );

        expect(response.status).toBe(404);
        expect(extractSandboxGitObjectsSpy).not.toHaveBeenCalled();
    });
});
