/**
 * Centralized API types - imports and re-exports types from worker
 * This file serves as the single source of truth for frontend-worker API communication
 */
import { AuthUser } from './api-types';
import type { UserStats, UserActivity } from 'worker/database/types';

export type { SecretTemplate } from 'worker/types/secretsTemplates';

// Base API Response Types
export type { ControllerResponse, ApiResponse } from 'worker/api/controllers/types';

// Database Types
export type {
  PaginationInfo,
  EnhancedAppData,
  AppWithFavoriteStatus,
  TimePeriod,
  AppSortOption,
  SortOrder,
  AppQueryOptions,
  PublicAppQueryOptions
} from 'worker/database/types';

// App-related API Types
export type { 
  AppsListData,
  PublicAppsData, 
  SingleAppData,
  FavoriteToggleData,
  CreateAppData,
  UpdateAppVisibilityData,
  AppDeleteData,
  AppWithUserAndStats
} from 'worker/api/controllers/apps/types';

export type {
  AppDetailsData,
  AppStarToggleData,
  GeneratedCodeFile,
  GitCloneTokenData
} from 'worker/api/controllers/appView/types';

// User-related API Types
export type {
  UserAppsData,
  ProfileUpdateData,
} from 'worker/api/controllers/user/types';

// Stats API Types
//
// Locally defined: `worker/api/controllers/stats/types.ts` was retired
// along with `StatsController`/`AnalyticsService` in phase 2a (the
// dashboard stats they served depend on tables - favorites/appViews/
// appLikes - dropped in the lean Postgres schema rewrite). `UserStats`/
// `UserActivity` themselves are unaffected (re-exported below from
// `worker/database/types`) - only the controller response wrapper types
// move here.
export type UserStatsData = UserStats;
export interface UserActivityData {
  activities: UserActivity[];
}

// Analytics API Types
export type {
  UserAnalyticsResponseData,
  AgentAnalyticsResponseData,
} from 'worker/api/controllers/analytics/types';

export type { PlatformStatusData } from 'worker/api/controllers/status/types';

export type { CapabilitiesData } from 'worker/api/controllers/capabilities/types';

export type {
  ViewMode,
  FeatureCapabilities,
  FeatureDefinition,
  ViewDefinition,
  PlatformCapabilities,
  PlatformCapabilitiesConfig,
} from 'worker/agents/core/features/types';

export {
  DEFAULT_FEATURE_DEFINITIONS,
  getBehaviorTypeForProject,
} from 'worker/agents/core/features';

// Model Config API Types
export type {
  ModelConfigsData,
  ModelConfigData,
  ModelConfigUpdateData,
  ModelConfigTestData,
  ModelConfigResetData,
  ModelConfigDefaultsData,
  ModelConfigDeleteData,
  ByokProvidersData,
  UserProviderStatus,
  ModelsByProvider
} from 'worker/api/controllers/modelConfig/types';

// Model Provider API Types
export type {
  ModelProvidersListData,
  ModelProviderData,
  ModelProviderCreateData,
  ModelProviderUpdateData,
  ModelProviderDeleteData,
  ModelProviderTestData,
  CreateProviderRequest,
  UpdateProviderRequest,
  TestProviderRequest
} from 'worker/api/controllers/modelProviders/types';

// Custom Agent Skills API Types
export type {
  SkillsListData,
  SkillData,
  SkillCreateData,
  SkillUpdateData,
  SkillDeleteData,
  CreateSkillRequest,
  UpdateSkillRequest
} from 'worker/api/controllers/skills/types';
export type { ActiveSkillSnapshot } from '../shared/types/skills';
export {
  SKILL_NAME_REGEX,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_CONTENT_LENGTH,
  MAX_COMBINED_ACTIVE_SKILLS_LENGTH,
  MAX_SKILLS_PER_USER
} from '../shared/constants/skills';

// Frontend model config update interface that matches backend schema
export interface ModelConfigUpdate {
  modelName?: string | null;
  maxTokens?: number | null;
  temperature?: number | null;
  reasoningEffort?: string | null;
  fallbackModel?: string | null;
  isUserOverride?: boolean;
}

// Secrets API Types
export type { SecretTemplatesData } from 'worker/api/controllers/secrets/types';

// Vault API Types
export type {
	VaultConfig,
	VaultConfigResponse,
	VaultStatusResponse,
	SetupVaultRequest,
	KdfAlgorithm,
	Argon2Params,
	SecretMetadata,
} from 'worker/services/secrets/vault-types';

// Agent/CodeGen API Types
export type {
  AgentBootstrapResponse,
  AgentConnectionData,
} from 'worker/api/controllers/agent/types';

// Template Types
export type {
  TemplateDetails,
} from 'worker/services/sandbox/sandboxTypes';

// WebSocket Types
export type {
  WebSocketMessage,
  WebSocketMessageData,
  CodeFixEdits,
  ModelConfigsInfoMessage,
  AgentDisplayConfig,
  ModelConfigsInfo
} from 'worker/api/websocketTypes';

// Database/Schema Types commonly used in frontend
export type {
  App,
  User,
  UserModelConfig,
  UserModelProvider,
  AgentSkill
} from 'worker/database/schema';

export type {
  FavoriteToggleResult,
  UserStats,
  UserActivity,
  UserModelConfigWithMetadata,
  ModelTestResult
} from 'worker/database/types';

// Agent/Generator Types
export type {
  Blueprint as BlueprintType,
  PhasicBlueprint,
  CodeReviewOutputType,
  FileConceptType,
  FileOutputType as GeneratedFile,
} from 'worker/agents/schemas';

export type {
  AgentState,
  PhasicState
} from 'worker/agents/core/state';

export type {
  BehaviorType,
  ProjectType
} from 'worker/agents/core/types';
export { isAgenticLikeBehavior } from 'worker/agents/core/types';

export type {
  ConversationMessage,
} from 'worker/agents/inferutils/common';

export type { 
  RuntimeError,
  StaticAnalysisResponse 
} from 'worker/services/sandbox/sandboxTypes';

// Config/Inference Types
export type { 
  AgentActionKey,
  AgentConfig,
  ModelConfig,
  ReasoningEffortType as ReasoningEffort,
  ProviderOverrideType as ProviderOverride
} from 'worker/agents/inferutils/config.types';

export type { RateLimitError } from "worker/services/rate-limit/errors";
export type { AgentPreviewResponse, CodeGenArgs } from 'worker/api/controllers/agent/types';
export { MAX_AGENT_QUERY_LENGTH } from 'worker/api/controllers/agent/types';

// App Database (DB tab) types
export type {
  AppDatabaseColumn,
  AppDatabaseTable,
  AppDatabaseReadResult,
  ListAppTablesResponse,
  QueryAppTableResponse,
  WipeAppDatabaseResponse,
} from 'worker/api/controllers/appDatabase/types';
export type { RateLimitErrorResponse } from 'worker/api/responses';
export { RateLimitExceededError, SecurityError, SecurityErrorType } from '../shared/types/errors.js';

export type { AIModels, AIModelConfig } from 'worker/agents/inferutils/config.types';
export { AI_MODEL_CONFIG } from 'worker/agents/inferutils/config.types';
// Model selection types
export type ModelSelectionMode = 'platform' | 'byok' | 'custom';

// Match chat FileType interface
export interface FileType {
	filePath: string;
	fileContents: string;
	explanation?: string;
	isGenerating?: boolean;
	needsFixing?: boolean;
	hasErrors?: boolean;
	language?: string;
}

// Streaming response wrapper types for agent session creation
export interface StreamingResponse {
  success: boolean;
  stream: Response;
}

export type AgentStreamingResponse = StreamingResponse;

export {
	type ImageAttachment, 
	isSupportedImageType, 
	MAX_IMAGE_SIZE_BYTES,
	MAX_IMAGES_PER_MESSAGE,
	SUPPORTED_IMAGE_MIME_TYPES
} from 'worker/types/image-attachment';

// Auth types imported from worker
export type {
  AuthUser,
  OAuthProvider
} from 'worker/types/auth-types';

/**
 * Session information for active authentication.
 *
 * Locally defined as of phase 2a: the hand-rolled session stack this used
 * to mirror (`worker/types/auth-types.ts`'s old `AuthSession`,
 * `worker/utils/authUtils.ts`'s old `SessionResponse`) was retired in favor
 * of Supabase Auth sessions (see `worker/services/auth/supabaseAuth.ts`).
 * Kept here, with the same shape, for the existing frontend auth context
 * contract pending the phase 2b frontend auth migration.
 */
export interface AuthSession {
  userId: string;
  email: string;
  sessionId: string;
  expiresAt: Date | null;
}

export interface SessionResponse {
  user: AuthUser;
  sessionId: string;
  expiresAt: Date | null;
}

// Auth API Response Types (using existing worker types)
export type LoginResponseData = SessionResponse;

export type RegisterResponseData = SessionResponse & {
  requiresVerification?: boolean;
};

export type ProfileResponseData = {
  user: AuthUser;
  sessionId: string;
};

export interface AuthProvidersResponseData {
  providers: {
    google: boolean;
    github: boolean;
    email: boolean;
  };
  hasOAuth: boolean;
  requiresEmailAuth: boolean;
  csrfToken?: string;
  csrfExpiresIn?: number;
}

export interface CsrfTokenResponseData {
  token: string;
  headerName: string;
  expiresIn?: number;
}

// Active Sessions Response - matches getUserSessions + isCurrent from controller
export interface ActiveSessionsData {
  sessions: Array<{
    id: string;
    userAgent: string | null;
    ipAddress: string | null;
    lastActivity: Date;
    createdAt: Date;
    isCurrent: boolean;
  }>;
}

// API Keys Response - matches controller response format
export interface ApiKeysData {
  keys: Array<{
    id: string;
    name: string;
    keyPreview: string;
    createdAt: Date | null;
    lastUsed: Date | null;
    isActive: boolean;
  }>;
}

export type {
    GitHubExportOptions,
    GitHubExportResult,
} from 'worker/services/github/types';
