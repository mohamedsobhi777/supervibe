import {
    pgTable,
    text,
    integer,
    boolean,
    timestamp,
    uuid,
    jsonb,
    doublePrecision,
    bigint,
    bigserial,
    customType,
    index,
    uniqueIndex,
} from 'drizzle-orm/pg-core';

// Schema enum arrays derived from config types
const REASONING_EFFORT_VALUES = ['low', 'medium', 'high'] as const;
const PROVIDER_OVERRIDE_VALUES = ['cloudflare', 'direct'] as const;

/**
 * Postgres `bytea` column. `drizzle-orm/pg-core` has no built-in bytea
 * column builder, so this wraps `customType`. postgres-js maps `bytea`
 * to/from a Node `Buffer` on the wire by default.
 */
const bytea = customType<{ data: Buffer }>({
    dataType() {
        return 'bytea';
    },
});

// ========================================
// CORE USER AND IDENTITY MANAGEMENT
// ========================================

/**
 * Users table - profile extension of Supabase `auth.users`.
 * `id` mirrors the corresponding `auth.users.id`; Supabase Auth owns
 * identity/credentials (email verification, password, OAuth linking).
 * The FK to `auth.users` is enforced by the migration, not modeled here -
 * Drizzle only manages tables in the `public` schema.
 */
export const users = pgTable('users', {
    id: uuid('id').primaryKey(),
    email: text('email').notNull().unique(),
    displayName: text('display_name'),
    username: text('username').unique(),
    avatarUrl: text('avatar_url'),
    provider: text('provider'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
});

// ========================================
// CORE APP AND GENERATION SYSTEM
// ========================================

/**
 * Apps table - generated applications with core metadata.
 */
export const apps = pgTable('apps', {
    id: text('id').primaryKey(),

    // App Identity
    title: text('title').notNull(),
    description: text('description'),
    iconUrl: text('icon_url'),

    // Original Generation Data
    originalPrompt: text('original_prompt').notNull(),
    finalPrompt: text('final_prompt'),

    // Generated Content
    framework: text('framework'), // 'react', 'vue', 'svelte', etc.

    // Ownership and Context
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }), // Null for anonymous
    sessionToken: text('session_token'), // For anonymous users

    // Visibility and Sharing
    visibility: text('visibility', { enum: ['private', 'public'] }).notNull().default('private'),

    // Status and State
    status: text('status', { enum: ['generating', 'completed'] }).notNull().default('generating'),

    // Deployment Information
    deploymentId: text('deployment_id'), // Deployment ID (extracted from deployment URL)

    // GitHub Repository Integration
    githubRepositoryUrl: text('github_repository_url'),
    githubRepositoryVisibility: text('github_repository_visibility', { enum: ['public', 'private'] }),

    // App Metadata
    isArchived: boolean('is_archived').default(false),
    isFeatured: boolean('is_featured').default(false), // Featured by admins

    // Versioning
    version: integer('version').default(1),
    parentAppId: text('parent_app_id'), // If forked from another app

    // Screenshot Information
    screenshotUrl: text('screenshot_url'),
    screenshotCapturedAt: timestamp('screenshot_captured_at', { withTimezone: true }),

    // Metadata
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastDeployedAt: timestamp('last_deployed_at', { withTimezone: true }),
}, (table) => [
    index('apps_user_idx').on(table.userId),
    index('apps_status_idx').on(table.status),
    index('apps_visibility_idx').on(table.visibility),
    index('apps_framework_idx').on(table.framework),
    index('apps_created_at_idx').on(table.createdAt),
    index('apps_parent_app_idx').on(table.parentAppId),
]);

// ========================================
// USER MODEL CONFIGURATIONS
// ========================================

/**
 * User Model Configurations table - user-specific AI model settings that
 * override defaults.
 */
export const userModelConfigs = pgTable('user_model_configs', {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    // Configuration Details
    agentActionName: text('agent_action_name').notNull(), // Maps to AgentActionKey from config.ts
    modelName: text('model_name'), // Override for AIModels - null means use default
    maxTokens: integer('max_tokens'), // Override max tokens - null means use default
    temperature: doublePrecision('temperature'), // Override temperature - null means use default
    reasoningEffort: text('reasoning_effort', { enum: REASONING_EFFORT_VALUES }),
    providerOverride: text('provider_override', { enum: PROVIDER_OVERRIDE_VALUES }),
    fallbackModel: text('fallback_model'),

    // Status and Metadata
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('user_model_configs_user_agent_idx').on(table.userId, table.agentActionName),
    index('user_model_configs_user_idx').on(table.userId),
]);

/**
 * User Model Providers table - custom OpenAI-compatible providers.
 *
 * `apiKeyEncrypted` replaces the old D1 `secretId` indirection (a pointer
 * into a separate secrets store): the provider's API key ciphertext is
 * stored directly on the row.
 */
export const userModelProviders = pgTable('user_model_providers', {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    // Provider Details
    name: text('name').notNull(), // User-friendly name (e.g., "My Local Ollama")
    baseUrl: text('base_url').notNull(), // OpenAI-compatible API base URL
    apiKeyEncrypted: text('api_key_encrypted'),

    // Status and Metadata
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('user_model_providers_user_name_idx').on(table.userId, table.name),
    index('user_model_providers_user_idx').on(table.userId),
]);

// ========================================
// USER SECRETS VAULT
// ========================================

/**
 * User Secrets table - encrypted BYOK vault. Ciphertext/nonces are opaque
 * `bytea`; the app-layer XChaCha20-Poly1305 crypto (client-derived keys,
 * server never sees plaintext) is unchanged by this port - only the
 * storage backend moves from a Durable-Object-owned SQLite table to
 * Postgres. See `worker/services/secrets/`.
 */
export const userSecrets = pgTable('user_secrets', {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    secretType: text('secret_type').notNull(),
    encryptedName: bytea('encrypted_name').notNull(),
    nameNonce: bytea('name_nonce').notNull(),
    encryptedValue: bytea('encrypted_value').notNull(),
    valueNonce: bytea('value_nonce').notNull(),
    metadata: jsonb('metadata'), // Plaintext metadata (provider, envVarName, ...)

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index('user_secrets_user_idx').on(table.userId),
]);

// ========================================
// RATE LIMITING
// ========================================

/**
 * Rate Limit Buckets table - Postgres replacement for the
 * Durable-Object-based sliding-window rate limiter (`DORateLimitStore`).
 * One row per `(key, bucketTimestamp)`; increments use
 * `INSERT ... ON CONFLICT (key, bucket_timestamp) DO UPDATE`.
 */
export const rateLimitBuckets = pgTable('rate_limit_buckets', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    key: text('key').notNull(),
    bucketTimestamp: bigint('bucket_timestamp', { mode: 'number' }).notNull(), // Epoch milliseconds
    count: integer('count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('rate_limit_buckets_key_bucket_idx').on(table.key, table.bucketTimestamp),
    index('rate_limit_buckets_key_bucket_desc_idx').on(table.key, table.bucketTimestamp.desc()),
    index('rate_limit_buckets_created_at_idx').on(table.createdAt),
]);

// ========================================
// SYSTEM CONFIGURATION
// ========================================

/**
 * SystemSettings table - global system configuration (replaces the KV
 * CONFIG_KEY store).
 */
export const systemSettings = pgTable('system_settings', {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    value: jsonb('value'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ========================================
// TYPE EXPORTS FOR APPLICATION USE
// ========================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;

export type UserModelConfig = typeof userModelConfigs.$inferSelect;
export type NewUserModelConfig = typeof userModelConfigs.$inferInsert;

export type UserModelProvider = typeof userModelProviders.$inferSelect;
export type NewUserModelProvider = typeof userModelProviders.$inferInsert;

export type UserSecret = typeof userSecrets.$inferSelect;
export type NewUserSecret = typeof userSecrets.$inferInsert;

export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
export type NewRateLimitBucket = typeof rateLimitBuckets.$inferInsert;

export type SystemSetting = typeof systemSettings.$inferSelect;
export type NewSystemSetting = typeof systemSettings.$inferInsert;
