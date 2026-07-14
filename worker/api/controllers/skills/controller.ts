/**
 * Custom Agent Skills Controller
 */

import { BaseController } from '../baseController';
import { RouteContext } from '../../types/route-context';
import { ApiResponse, ControllerResponse } from '../types';
import { SkillsService } from '../../../database/services/SkillsService';
import { z } from 'zod';
import {
    SkillsListData,
    SkillCreateData,
    SkillUpdateData,
    SkillDeleteData,
    CreateSkillRequest,
    UpdateSkillRequest
} from './types';
import {
    SKILL_NAME_REGEX,
    MAX_SKILL_DESCRIPTION_LENGTH,
    MAX_SKILL_CONTENT_LENGTH,
    MAX_COMBINED_ACTIVE_SKILLS_LENGTH,
    MAX_SKILLS_PER_USER
} from '../../../../shared/constants/skills';
import { createLogger } from '../../../logger';

// Validation schemas
const skillNameSchema = z.string().regex(
    SKILL_NAME_REGEX,
    'Name must be 1-64 characters: letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit'
);

const createSkillSchema = z.object({
    name: skillNameSchema,
    description: z.string().min(1).max(MAX_SKILL_DESCRIPTION_LENGTH),
    content: z.string().min(1).max(MAX_SKILL_CONTENT_LENGTH),
    isActive: z.boolean().optional()
});

const updateSkillSchema = z.object({
    name: skillNameSchema.optional(),
    description: z.string().min(1).max(MAX_SKILL_DESCRIPTION_LENGTH).optional(),
    content: z.string().min(1).max(MAX_SKILL_CONTENT_LENGTH).optional(),
    isActive: z.boolean().optional()
});

export class SkillsController extends BaseController {
    static logger = createLogger('SkillsController');

    /**
     * Get all skills (active and inactive) for the authenticated user
     */
    static async getSkills(_request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<ControllerResponse<ApiResponse<SkillsListData>>> {
        try {
            const user = context.user!;
            const skillsService = new SkillsService(env);
            const skills = await skillsService.getUserSkills(user.id);

            return SkillsController.createSuccessResponse({ skills });
        } catch (error) {
            this.logger.error('Error getting skills:', error);
            return SkillsController.createErrorResponse<SkillsListData>('Failed to get skills', 500);
        }
    }

    /**
     * Create a new skill
     */
    static async createSkill(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<ControllerResponse<ApiResponse<SkillCreateData>>> {
        try {
            const user = context.user!;

            const bodyResult = await SkillsController.parseJsonBody<CreateSkillRequest>(request);
            if (!bodyResult.success) {
                return bodyResult.response as ControllerResponse<ApiResponse<SkillCreateData>>;
            }

            const validation = createSkillSchema.safeParse(bodyResult.data);
            if (!validation.success) {
                return SkillsController.createErrorResponse<SkillCreateData>(
                    `Validation error: ${validation.error.issues.map(e => e.message).join(', ')}`,
                    400
                );
            }
            const data = validation.data;

            const skillsService = new SkillsService(env);

            const skillCount = await skillsService.getSkillCount(user.id);
            if (skillCount >= MAX_SKILLS_PER_USER) {
                return SkillsController.createErrorResponse<SkillCreateData>(
                    `Skill limit reached (${MAX_SKILLS_PER_USER}). Delete a skill before creating a new one.`,
                    400
                );
            }

            if (await skillsService.skillExists(user.id, data.name)) {
                return SkillsController.createErrorResponse<SkillCreateData>(
                    `A skill named "${data.name}" already exists`,
                    409
                );
            }

            const willBeActive = data.isActive ?? true;
            if (willBeActive) {
                const combinedLength = await skillsService.getCombinedActiveContentLength(user.id);
                if (combinedLength + data.content.length > MAX_COMBINED_ACTIVE_SKILLS_LENGTH) {
                    return SkillsController.createErrorResponse<SkillCreateData>(
                        `Combined active skill content would exceed ${MAX_COMBINED_ACTIVE_SKILLS_LENGTH} characters. Deactivate or shorten other skills first.`,
                        400
                    );
                }
            }

            const skill = await skillsService.createSkill(user.id, data);
            return SkillsController.createSuccessResponse({ skill });
        } catch (error) {
            this.logger.error('Error creating skill:', error);
            return SkillsController.createErrorResponse<SkillCreateData>('Failed to create skill', 500);
        }
    }

    /**
     * Update an existing skill
     */
    static async updateSkill(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<ControllerResponse<ApiResponse<SkillUpdateData>>> {
        try {
            const user = context.user!;

            const url = new URL(request.url);
            const skillId = url.pathname.split('/').pop();
            if (!skillId) {
                return SkillsController.createErrorResponse<SkillUpdateData>('Skill ID is required', 400);
            }

            const bodyResult = await SkillsController.parseJsonBody<UpdateSkillRequest>(request);
            if (!bodyResult.success) {
                return bodyResult.response as ControllerResponse<ApiResponse<SkillUpdateData>>;
            }

            const validation = updateSkillSchema.safeParse(bodyResult.data);
            if (!validation.success) {
                return SkillsController.createErrorResponse<SkillUpdateData>(
                    `Validation error: ${validation.error.issues.map(e => e.message).join(', ')}`,
                    400
                );
            }
            const data = validation.data;

            const skillsService = new SkillsService(env);
            const existing = await skillsService.getSkill(user.id, skillId);
            if (!existing) {
                return SkillsController.createErrorResponse<SkillUpdateData>('Skill not found', 404);
            }

            if (data.name !== undefined && data.name !== existing.name && await skillsService.skillExists(user.id, data.name)) {
                return SkillsController.createErrorResponse<SkillUpdateData>(
                    `A skill named "${data.name}" already exists`,
                    409
                );
            }

            const willBeActive = data.isActive ?? existing.isActive ?? true;
            if (willBeActive) {
                const resultingContentLength = (data.content ?? existing.content).length;
                const otherActiveLength = await skillsService.getCombinedActiveContentLength(user.id, skillId);
                if (otherActiveLength + resultingContentLength > MAX_COMBINED_ACTIVE_SKILLS_LENGTH) {
                    return SkillsController.createErrorResponse<SkillUpdateData>(
                        `Combined active skill content would exceed ${MAX_COMBINED_ACTIVE_SKILLS_LENGTH} characters. Deactivate or shorten other skills first.`,
                        400
                    );
                }
            }

            const skill = await skillsService.updateSkill(user.id, skillId, data);
            if (!skill) {
                return SkillsController.createErrorResponse<SkillUpdateData>('Skill not found', 404);
            }

            return SkillsController.createSuccessResponse({ skill });
        } catch (error) {
            this.logger.error('Error updating skill:', error);
            return SkillsController.createErrorResponse<SkillUpdateData>('Failed to update skill', 500);
        }
    }

    /**
     * Delete a skill
     */
    static async deleteSkill(request: Request, env: Env, _ctx: ExecutionContext, context: RouteContext): Promise<ControllerResponse<ApiResponse<SkillDeleteData>>> {
        try {
            const user = context.user!;

            const url = new URL(request.url);
            const skillId = url.pathname.split('/').pop();
            if (!skillId) {
                return SkillsController.createErrorResponse<SkillDeleteData>('Skill ID is required', 400);
            }

            const skillsService = new SkillsService(env);
            const deleted = await skillsService.deleteSkill(user.id, skillId);
            if (!deleted) {
                return SkillsController.createErrorResponse<SkillDeleteData>('Skill not found', 404);
            }

            return SkillsController.createSuccessResponse({ success: true, skillId });
        } catch (error) {
            this.logger.error('Error deleting skill:', error);
            return SkillsController.createErrorResponse<SkillDeleteData>('Failed to delete skill', 500);
        }
    }
}
