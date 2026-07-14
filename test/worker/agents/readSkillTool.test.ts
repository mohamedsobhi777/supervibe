import { describe, expect, it } from 'vitest';
import { createReadSkillTool } from 'worker/agents/tools/toolkit/read-skill';
import type { ICodingAgent } from 'worker/agents/services/interfaces/ICodingAgent';
import type { StructuredLogger } from 'worker/logger';
import type { ActiveSkillSnapshot } from 'shared/types/skills';

const SKILLS: ActiveSkillSnapshot[] = [
    {
        id: 'skill-1',
        name: 'Tailwind conventions',
        description: 'How utility classes should be organized',
        content: '# Tailwind\n- Prefer utility classes',
    },
    {
        id: 'skill-2',
        name: 'API errors',
        description: 'Standard error envelope',
        content: 'Always return { success, data, error }.',
    },
];

function stubAgent(skills: ActiveSkillSnapshot[]): ICodingAgent {
    return { getActiveSkills: () => skills } as unknown as ICodingAgent;
}

const stubLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
} as unknown as StructuredLogger;

describe('createReadSkillTool', () => {
    it('returns the full skill content for an exact name match', async () => {
        const tool = createReadSkillTool(stubAgent(SKILLS), stubLogger);

        const result = await tool.implementation({ name: 'Tailwind conventions' });

        expect(result).toEqual({
            name: 'Tailwind conventions',
            description: 'How utility classes should be organized',
            content: '# Tailwind\n- Prefer utility classes',
        });
    });

    it('lists the available skill names when the lookup misses', async () => {
        const tool = createReadSkillTool(stubAgent(SKILLS), stubLogger);

        const result = await tool.implementation({ name: 'Nope' });

        expect(result).toHaveProperty('error');
        const error = (result as { error: string }).error;
        expect(error).toContain('"Tailwind conventions"');
        expect(error).toContain('"API errors"');
    });

    it('reports (none) when the session has no skills', async () => {
        const tool = createReadSkillTool(stubAgent([]), stubLogger);

        const result = await tool.implementation({ name: 'Anything' });

        expect((result as { error: string }).error).toContain('(none)');
    });
});
