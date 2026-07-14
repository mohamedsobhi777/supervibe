import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { SkillsController } from '../../../worker/api/controllers/skills/controller';
import { SkillsService } from '../../../worker/database/services/SkillsService';
import { RUNTIME_MODE_KEY, STANDALONE_RUNTIME_MODE } from '../../../worker/utils/runtimeMode';
import type { RouteContext } from '../../../worker/api/types/route-context';
import type { AgentSkill } from '../../../worker/database/schema';
import {
    MAX_SKILL_CONTENT_LENGTH,
    MAX_COMBINED_ACTIVE_SKILLS_LENGTH,
    MAX_SKILLS_PER_USER,
} from '../../../shared/constants/skills';

/**
 * Unit tests for the skills CRUD validation rules
 * (`/api/user/skills` -> SkillsController). Collaborators are spied on the
 * real SkillsService prototype rather than `vi.mock`'d - see the header
 * comment in test/worker/api/agentBootstrap.test.ts for why `vi.mock` does
 * not work reliably under `@cloudflare/vitest-pool-workers`.
 */

const FAKE_ENV = {
    [RUNTIME_MODE_KEY]: STANDALONE_RUNTIME_MODE,
} as unknown as Env;

function makeContext(userId = 'user_1'): RouteContext {
    return {
        user: { id: userId, email: 'u@e.com' },
        sessionId: null,
        config: {},
        pathParams: {},
        queryParams: new URLSearchParams(),
    } as unknown as RouteContext;
}

function fakeSkill(overrides: Partial<AgentSkill> = {}): AgentSkill {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
        id: 'skill_1',
        userId: 'user_1',
        name: 'Tailwind conventions',
        description: 'How utility classes should be organized',
        content: '# Tailwind rules',
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function postRequest(body: unknown, url = 'https://example.com/api/user/skills'): Request {
    return new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function putRequest(skillId: string, body: unknown): Request {
    return new Request(`https://example.com/api/user/skills/${skillId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const VALID_CREATE_BODY = {
    name: 'Tailwind conventions',
    description: 'How utility classes should be organized',
    content: '# Tailwind rules',
};

describe('POST /api/user/skills -> SkillsController.createSkill', () => {
    let getSkillCountSpy: MockInstance<SkillsService['getSkillCount']>;
    let skillExistsSpy: MockInstance<SkillsService['skillExists']>;
    let combinedLengthSpy: MockInstance<SkillsService['getCombinedActiveContentLength']>;
    let createSkillSpy: MockInstance<SkillsService['createSkill']>;

    beforeEach(() => {
        getSkillCountSpy = vi.spyOn(SkillsService.prototype, 'getSkillCount').mockResolvedValue(0);
        skillExistsSpy = vi.spyOn(SkillsService.prototype, 'skillExists').mockResolvedValue(false);
        combinedLengthSpy = vi.spyOn(SkillsService.prototype, 'getCombinedActiveContentLength').mockResolvedValue(0);
        createSkillSpy = vi.spyOn(SkillsService.prototype, 'createSkill').mockResolvedValue(fakeSkill());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('creates a valid skill', async () => {
        const response = await SkillsController.createSkill(
            postRequest(VALID_CREATE_BODY),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(200);
        expect(createSkillSpy).toHaveBeenCalledWith('user_1', expect.objectContaining({ name: 'Tailwind conventions' }));
    });

    it('rejects an invalid name with 400', async () => {
        const response = await SkillsController.createSkill(
            postRequest({ ...VALID_CREATE_BODY, name: '<script>' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(400);
        expect(createSkillSpy).not.toHaveBeenCalled();
    });

    it('rejects content over the per-skill cap with 400', async () => {
        const response = await SkillsController.createSkill(
            postRequest({ ...VALID_CREATE_BODY, content: 'a'.repeat(MAX_SKILL_CONTENT_LENGTH + 1) }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(400);
        expect(createSkillSpy).not.toHaveBeenCalled();
    });

    it('rejects a duplicate name with 409', async () => {
        skillExistsSpy.mockResolvedValue(true);

        const response = await SkillsController.createSkill(
            postRequest(VALID_CREATE_BODY),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(409);
        expect(createSkillSpy).not.toHaveBeenCalled();
    });

    it('rejects creation past the per-user skill cap with 400', async () => {
        getSkillCountSpy.mockResolvedValue(MAX_SKILLS_PER_USER);

        const response = await SkillsController.createSkill(
            postRequest(VALID_CREATE_BODY),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(400);
        expect(createSkillSpy).not.toHaveBeenCalled();
    });

    it('rejects an active skill that would overflow the combined cap with 400', async () => {
        combinedLengthSpy.mockResolvedValue(MAX_COMBINED_ACTIVE_SKILLS_LENGTH);

        const response = await SkillsController.createSkill(
            postRequest(VALID_CREATE_BODY),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(400);
        expect(createSkillSpy).not.toHaveBeenCalled();
    });

    it('skips the combined cap check when creating an inactive skill', async () => {
        combinedLengthSpy.mockResolvedValue(MAX_COMBINED_ACTIVE_SKILLS_LENGTH);
        createSkillSpy.mockResolvedValue(fakeSkill({ isActive: false }));

        const response = await SkillsController.createSkill(
            postRequest({ ...VALID_CREATE_BODY, isActive: false }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(200);
    });
});

describe('PUT /api/user/skills/:id -> SkillsController.updateSkill', () => {
    let getSkillSpy: MockInstance<SkillsService['getSkill']>;
    let skillExistsSpy: MockInstance<SkillsService['skillExists']>;
    let combinedLengthSpy: MockInstance<SkillsService['getCombinedActiveContentLength']>;
    let updateSkillSpy: MockInstance<SkillsService['updateSkill']>;

    beforeEach(() => {
        getSkillSpy = vi.spyOn(SkillsService.prototype, 'getSkill').mockResolvedValue(fakeSkill());
        skillExistsSpy = vi.spyOn(SkillsService.prototype, 'skillExists').mockResolvedValue(false);
        combinedLengthSpy = vi.spyOn(SkillsService.prototype, 'getCombinedActiveContentLength').mockResolvedValue(0);
        updateSkillSpy = vi.spyOn(SkillsService.prototype, 'updateSkill').mockResolvedValue(fakeSkill());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('updates a skill and excludes it from its own combined-cap check', async () => {
        const response = await SkillsController.updateSkill(
            putRequest('skill_1', { content: 'new content' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(200);
        expect(combinedLengthSpy).toHaveBeenCalledWith('user_1', 'skill_1');
        expect(updateSkillSpy).toHaveBeenCalledWith('user_1', 'skill_1', { content: 'new content' });
    });

    it('returns 404 for a missing skill', async () => {
        getSkillSpy.mockResolvedValue(null);

        const response = await SkillsController.updateSkill(
            putRequest('missing', { name: 'Renamed' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(404);
        expect(updateSkillSpy).not.toHaveBeenCalled();
    });

    it('rejects a rename collision with 409', async () => {
        skillExistsSpy.mockResolvedValue(true);

        const response = await SkillsController.updateSkill(
            putRequest('skill_1', { name: 'Taken name' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(409);
        expect(updateSkillSpy).not.toHaveBeenCalled();
    });

    it('rejects re-activating a skill that would overflow the combined cap with 400', async () => {
        getSkillSpy.mockResolvedValue(fakeSkill({ isActive: false, content: 'a'.repeat(1000) }));
        combinedLengthSpy.mockResolvedValue(MAX_COMBINED_ACTIVE_SKILLS_LENGTH - 500);

        const response = await SkillsController.updateSkill(
            putRequest('skill_1', { isActive: true }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(400);
        expect(updateSkillSpy).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/user/skills/:id -> SkillsController.deleteSkill', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('deletes an existing skill', async () => {
        vi.spyOn(SkillsService.prototype, 'deleteSkill').mockResolvedValue(true);

        const response = await SkillsController.deleteSkill(
            new Request('https://example.com/api/user/skills/skill_1', { method: 'DELETE' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(200);
    });

    it('returns 404 when nothing was deleted', async () => {
        vi.spyOn(SkillsService.prototype, 'deleteSkill').mockResolvedValue(false);

        const response = await SkillsController.deleteSkill(
            new Request('https://example.com/api/user/skills/missing', { method: 'DELETE' }),
            FAKE_ENV,
            {} as ExecutionContext,
            makeContext(),
        );

        expect(response.status).toBe(404);
    });
});
