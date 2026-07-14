/**
 * Custom Agent Skills Service
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq, and, asc } from 'drizzle-orm';
import { generateId } from '../../utils/idGenerator';
import { ActiveSkillSnapshot } from '../../../shared/types/skills';
import {
    MAX_COMBINED_ACTIVE_SKILLS_LENGTH,
    MAX_SKILL_CONTENT_LENGTH,
} from '../../../shared/constants/skills';

export interface CreateSkillData {
    name: string;
    description: string;
    content: string;
    isActive?: boolean;
}

export interface UpdateSkillData {
    name?: string;
    description?: string;
    content?: string;
    isActive?: boolean;
}

export class SkillsService extends BaseService {
    /**
     * Check if skill name exists for user
     */
    async skillExists(userId: string, name: string): Promise<boolean> {
        const existing = await this.database
            .select()
            .from(schema.agentSkills)
            .where(
                and(
                    eq(schema.agentSkills.userId, userId),
                    eq(schema.agentSkills.name, name)
                )
            )
            .limit(1);

        return existing.length > 0;
    }

    /**
     * Create a new skill
     */
    async createSkill(userId: string, data: CreateSkillData): Promise<schema.AgentSkill> {
        const skill = {
            id: generateId(),
            userId,
            name: data.name,
            description: data.description,
            content: data.content,
            isActive: data.isActive ?? true,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const [created] = await this.database
            .insert(schema.agentSkills)
            .values(skill)
            .returning();

        return created;
    }

    /**
     * Get all skills for a user (active and inactive), oldest first
     */
    async getUserSkills(userId: string): Promise<schema.AgentSkill[]> {
        return await this.database
            .select()
            .from(schema.agentSkills)
            .where(eq(schema.agentSkills.userId, userId))
            .orderBy(asc(schema.agentSkills.createdAt), asc(schema.agentSkills.id));
    }

    /**
     * Get a specific skill by ID
     */
    async getSkill(userId: string, skillId: string): Promise<schema.AgentSkill | null> {
        const rows = await this.database
            .select()
            .from(schema.agentSkills)
            .where(
                and(
                    eq(schema.agentSkills.id, skillId),
                    eq(schema.agentSkills.userId, userId)
                )
            )
            .limit(1);

        return rows[0] || null;
    }

    /**
     * Update a skill
     */
    async updateSkill(
        userId: string,
        skillId: string,
        data: UpdateSkillData
    ): Promise<schema.AgentSkill | null> {
        const updateData: Partial<typeof schema.agentSkills.$inferInsert> = {
            ...data,
            updatedAt: new Date()
        };

        const [updated] = await this.database
            .update(schema.agentSkills)
            .set(updateData)
            .where(
                and(
                    eq(schema.agentSkills.id, skillId),
                    eq(schema.agentSkills.userId, userId)
                )
            )
            .returning();

        return updated || null;
    }

    /**
     * Delete a skill
     */
    async deleteSkill(userId: string, skillId: string): Promise<boolean> {
        const result = await this.database
            .delete(schema.agentSkills)
            .where(
                and(
                    eq(schema.agentSkills.id, skillId),
                    eq(schema.agentSkills.userId, userId)
                )
            )
            .returning();

        return result.length > 0;
    }

    /**
     * Get skill count for user
     */
    async getSkillCount(userId: string): Promise<number> {
        const rows = await this.database
            .select({ id: schema.agentSkills.id })
            .from(schema.agentSkills)
            .where(eq(schema.agentSkills.userId, userId));

        return rows.length;
    }

    /**
     * Combined content length of the user's active skills, optionally
     * excluding one skill (used when validating an update to that skill).
     */
    async getCombinedActiveContentLength(userId: string, excludeSkillId?: string): Promise<number> {
        const rows = await this.getActiveSkills(userId);
        return rows
            .filter((skill) => skill.id !== excludeSkillId)
            .reduce((total, skill) => total + skill.content.length, 0);
    }

    /**
     * Resolve the user's active skills into the snapshot frozen into
     * agent_sessions.init_args at session creation.
     *
     * Skills are taken in deterministic order (createdAt asc, id asc) and
     * included whole while the combined content stays within the cap;
     * oversized skills are skipped (never truncated mid-content) with a
     * warning. Create/update validation normally prevents exceeding the cap,
     * so skipping only guards against races and out-of-band edits.
     */
    async resolveActiveSkillsSnapshot(userId: string): Promise<ActiveSkillSnapshot[]> {
        const activeSkills = await this.getActiveSkills(userId);

        const snapshot: ActiveSkillSnapshot[] = [];
        let combinedLength = 0;
        for (const skill of activeSkills) {
            if (
                skill.content.length > MAX_SKILL_CONTENT_LENGTH ||
                combinedLength + skill.content.length > MAX_COMBINED_ACTIVE_SKILLS_LENGTH
            ) {
                this.logger.warn('Skipping active skill exceeding size caps', {
                    userId,
                    skillId: skill.id,
                    skillName: skill.name,
                    contentLength: skill.content.length,
                    combinedLength,
                });
                continue;
            }

            combinedLength += skill.content.length;
            snapshot.push({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                content: skill.content,
            });
        }

        return snapshot;
    }

    private async getActiveSkills(userId: string): Promise<schema.AgentSkill[]> {
        return await this.database
            .select()
            .from(schema.agentSkills)
            .where(
                and(
                    eq(schema.agentSkills.userId, userId),
                    eq(schema.agentSkills.isActive, true)
                )
            )
            .orderBy(asc(schema.agentSkills.createdAt), asc(schema.agentSkills.id));
    }
}
