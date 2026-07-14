/**
 * Custom Agent Skills Limits
 * Shared between frontend and backend
 */

export const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Names appear inside prompt block headers (<SKILL name="...">), so they are
 * restricted to characters that cannot break out of an attribute position.
 */
export const SKILL_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/;

export const MAX_SKILL_DESCRIPTION_LENGTH = 256;

/** Per-skill markdown content cap (characters) */
export const MAX_SKILL_CONTENT_LENGTH = 16_000;

/** Combined content cap across all active skills applied to one session (characters) */
export const MAX_COMBINED_ACTIVE_SKILLS_LENGTH = 48_000;

export const MAX_SKILLS_PER_USER = 50;
