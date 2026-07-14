import { tool, t } from '../types';
import { StructuredLogger } from '../../../logger';
import { ICodingAgent } from '../../services/interfaces/ICodingAgent';

export function createReadSkillTool(agent: ICodingAgent, logger: StructuredLogger) {
	return tool({
		name: 'read_skill',
		description: 'Load the full markdown instructions of one of the user\'s custom skills listed in <CUSTOM_AGENT_SKILLS>. Call this before doing work a skill plausibly covers.',
		args: {
			name: t.string().describe('Exact skill name as listed in the skill index'),
		},
		run: async ({ name }) => {
			const skills = agent.getActiveSkills();
			const skill = skills.find(s => s.name === name);

			if (!skill) {
				logger.warn('read_skill: skill not found', { name });
				return {
					error: `Skill "${name}" not found. Available skills: ${skills.map(s => `"${s.name}"`).join(', ') || '(none)'}`,
				};
			}

			logger.info('read_skill: loaded skill', { name: skill.name, contentLength: skill.content.length });
			return {
				name: skill.name,
				description: skill.description,
				content: skill.content,
			};
		},
	});
}
