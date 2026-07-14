/**
 * Custom Agent Skills
 * Shared between frontend, worker API, and the standalone agent runtime
 */

/**
 * Snapshot of one active skill, frozen into agent_sessions.init_args at
 * session creation. Running sessions never re-read the skills table, so
 * later edits or deletions cannot affect them.
 */
export interface ActiveSkillSnapshot {
	id: string;
	name: string;
	description: string;
	/** Full markdown instructions */
	content: string;
}
