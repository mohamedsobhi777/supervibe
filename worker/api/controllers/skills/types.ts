/**
 * Custom Agent Skills API Types
 * Types for skill CRUD operations
 */

import type { AgentSkill } from '../../../database/schema';
import type { ApiResponse } from '../types';

// Response data types
export interface SkillsListData {
    skills: AgentSkill[];
}

export interface SkillData {
    skill: AgentSkill;
}

export interface SkillCreateData {
    skill: AgentSkill;
}

export interface SkillUpdateData {
    skill: AgentSkill;
}

export interface SkillDeleteData {
    success: boolean;
    skillId: string;
}

// Request input types
export interface CreateSkillRequest {
    name: string;
    description: string;
    content: string;
    isActive?: boolean;
}

export interface UpdateSkillRequest {
    name?: string;
    description?: string;
    content?: string;
    isActive?: boolean;
}

// API response types
export type SkillsListResponse = ApiResponse<SkillsListData>;
export type SkillResponse = ApiResponse<SkillData>;
export type SkillCreateResponse = ApiResponse<SkillCreateData>;
export type SkillUpdateResponse = ApiResponse<SkillUpdateData>;
export type SkillDeleteResponse = ApiResponse<SkillDeleteData>;
