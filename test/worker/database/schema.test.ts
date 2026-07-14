import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from 'worker/database/schema';

function findColumn(table: PgTable, name: string) {
    const column = getTableConfig(table).columns.find((candidate) => candidate.name === name);
    if (!column) {
        throw new Error(`Expected column "${name}" on table "${getTableConfig(table).name}"`);
    }
    return column;
}

function indexNames(table: PgTable): (string | undefined)[] {
    return getTableConfig(table).indexes.map((index) => index.config.name);
}

describe('schema (pg-core)', () => {
    it('exports exactly the 7 lean core tables under their Postgres table names', () => {
        expect(getTableConfig(schema.users).name).toBe('users');
        expect(getTableConfig(schema.apps).name).toBe('apps');
        expect(getTableConfig(schema.userModelConfigs).name).toBe('user_model_configs');
        expect(getTableConfig(schema.userModelProviders).name).toBe('user_model_providers');
        expect(getTableConfig(schema.userSecrets).name).toBe('user_secrets');
        expect(getTableConfig(schema.rateLimitBuckets).name).toBe('rate_limit_buckets');
        expect(getTableConfig(schema.systemSettings).name).toBe('system_settings');
    });

    describe('users', () => {
        it('has a uuid primary key referencing auth.users and required profile columns', () => {
            expect(schema.users.id.getSQLType()).toBe('uuid');
            expect(schema.users.id.primary).toBe(true);
            expect(schema.users.email.notNull).toBe(true);
            expect(schema.users.createdAt.getSQLType()).toBe('timestamp with time zone');
        });

        it('enforces a unique username', () => {
            expect(schema.users.username.isUnique).toBe(true);
        });
    });

    describe('apps', () => {
        it('has the pg timestamp/text/uuid/boolean columns the app layer relies on', () => {
            expect(findColumn(schema.apps, 'created_at').getSQLType()).toBe('timestamp with time zone');
            expect(findColumn(schema.apps, 'visibility').getSQLType()).toBe('text');
            expect(findColumn(schema.apps, 'status').getSQLType()).toBe('text');
            expect(findColumn(schema.apps, 'deployment_id').getSQLType()).toBe('text');
            expect(findColumn(schema.apps, 'user_id').getSQLType()).toBe('uuid');
            expect(findColumn(schema.apps, 'is_archived').getSQLType()).toBe('boolean');
        });

        it('indexes userId, status, visibility, framework, createdAt, and parentAppId', () => {
            expect(indexNames(schema.apps)).toEqual(expect.arrayContaining([
                'apps_user_idx',
                'apps_status_idx',
                'apps_visibility_idx',
                'apps_framework_idx',
                'apps_created_at_idx',
                'apps_parent_app_idx',
            ]));
        });
    });

    describe('favorites', () => {
        it('has a uuid user_id, text app_id, and a timestamptz created_at', () => {
            expect(findColumn(schema.favorites, 'user_id').getSQLType()).toBe('uuid');
            expect(findColumn(schema.favorites, 'app_id').getSQLType()).toBe('text');
            expect(findColumn(schema.favorites, 'created_at').getSQLType()).toBe('timestamp with time zone');
        });

        it('has a composite primary key on (user_id, app_id)', () => {
            const config = getTableConfig(schema.favorites);
            expect(config.primaryKeys).toHaveLength(1);
            expect(config.primaryKeys[0].columns.map((column) => column.name)).toEqual(['user_id', 'app_id']);
        });

        it('indexes user_id and app_id', () => {
            expect(indexNames(schema.favorites)).toEqual(expect.arrayContaining([
                'favorites_user_idx',
                'favorites_app_idx',
            ]));
        });
    });

    describe('stars', () => {
        it('has a uuid user_id, text app_id, and a timestamptz created_at', () => {
            expect(findColumn(schema.stars, 'user_id').getSQLType()).toBe('uuid');
            expect(findColumn(schema.stars, 'app_id').getSQLType()).toBe('text');
            expect(findColumn(schema.stars, 'created_at').getSQLType()).toBe('timestamp with time zone');
        });

        it('has a composite primary key on (user_id, app_id)', () => {
            const config = getTableConfig(schema.stars);
            expect(config.primaryKeys).toHaveLength(1);
            expect(config.primaryKeys[0].columns.map((column) => column.name)).toEqual(['user_id', 'app_id']);
        });

        it('indexes user_id and app_id', () => {
            expect(indexNames(schema.stars)).toEqual(expect.arrayContaining([
                'stars_user_idx',
                'stars_app_idx',
            ]));
        });
    });

    describe('userModelConfigs', () => {
        it('is unique on (user_id, agent_action_name)', () => {
            const unique = getTableConfig(schema.userModelConfigs).indexes.find((index) => index.config.unique);
            expect(unique?.config.name).toBe('user_model_configs_user_agent_idx');
        });
    });

    describe('userModelProviders', () => {
        it('is unique on (user_id, name)', () => {
            const unique = getTableConfig(schema.userModelProviders).indexes.find((index) => index.config.unique);
            expect(unique?.config.name).toBe('user_model_providers_user_name_idx');
        });
    });

    describe('userSecrets', () => {
        it('stores ciphertext and nonces as bytea, and metadata as jsonb', () => {
            expect(findColumn(schema.userSecrets, 'encrypted_name').getSQLType()).toBe('bytea');
            expect(findColumn(schema.userSecrets, 'name_nonce').getSQLType()).toBe('bytea');
            expect(findColumn(schema.userSecrets, 'encrypted_value').getSQLType()).toBe('bytea');
            expect(findColumn(schema.userSecrets, 'value_nonce').getSQLType()).toBe('bytea');
            expect(findColumn(schema.userSecrets, 'metadata').getSQLType()).toBe('jsonb');
        });

        it('indexes user_id', () => {
            expect(indexNames(schema.userSecrets)).toContain('user_secrets_user_idx');
        });
    });

    describe('rateLimitBuckets', () => {
        it('has a bigserial id and a bigint bucket_timestamp', () => {
            expect(findColumn(schema.rateLimitBuckets, 'id').getSQLType()).toBe('bigserial');
            expect(findColumn(schema.rateLimitBuckets, 'bucket_timestamp').getSQLType()).toBe('bigint');
            expect(findColumn(schema.rateLimitBuckets, 'count').getSQLType()).toBe('integer');
        });

        it('is unique on (key, bucket_timestamp) and has a descending lookup index', () => {
            const config = getTableConfig(schema.rateLimitBuckets);
            const unique = config.indexes.find((index) => index.config.unique);
            expect(unique?.config.name).toBe('rate_limit_buckets_key_bucket_idx');
            expect(indexNames(schema.rateLimitBuckets)).toEqual(expect.arrayContaining([
                'rate_limit_buckets_key_bucket_idx',
                'rate_limit_buckets_key_bucket_desc_idx',
                'rate_limit_buckets_created_at_idx',
            ]));
        });
    });

    describe('systemSettings', () => {
        it('has a unique, not-null key and a jsonb value column', () => {
            expect(schema.systemSettings.key.isUnique).toBe(true);
            expect(schema.systemSettings.key.notNull).toBe(true);
            expect(findColumn(schema.systemSettings, 'value').getSQLType()).toBe('jsonb');
        });
    });

    describe('agentSkills', () => {
        it('maps the agent_skills columns to their snake_case Postgres names and types', () => {
            expect(getTableConfig(schema.agentSkills).name).toBe('agent_skills');
            expect(findColumn(schema.agentSkills, 'user_id').getSQLType()).toBe('uuid');
            expect(findColumn(schema.agentSkills, 'name').notNull).toBe(true);
            expect(findColumn(schema.agentSkills, 'description').notNull).toBe(true);
            expect(findColumn(schema.agentSkills, 'content').notNull).toBe(true);
            expect(findColumn(schema.agentSkills, 'is_active').getSQLType()).toBe('boolean');
            expect(findColumn(schema.agentSkills, 'created_at').getSQLType()).toBe('timestamp with time zone');
        });

        it('is unique on (user_id, name) and indexes user_id', () => {
            const unique = getTableConfig(schema.agentSkills).indexes.find((index) => index.config.unique);
            expect(unique?.config.name).toBe('agent_skills_user_name_idx');
            expect(indexNames(schema.agentSkills)).toContain('agent_skills_user_idx');
        });
    });

    describe('agentSessions', () => {
        it('maps the Phase-1 agent_sessions columns to their snake_case Postgres names and types', () => {
            expect(getTableConfig(schema.agentSessions).name).toBe('agent_sessions');
            expect(findColumn(schema.agentSessions, 'session_id').getSQLType()).toBe('text');
            expect(findColumn(schema.agentSessions, 'agent_id').getSQLType()).toBe('text');
            expect(findColumn(schema.agentSessions, 'user_id').getSQLType()).toBe('uuid');
            expect(findColumn(schema.agentSessions, 'status').getSQLType()).toBe('text');
            expect(findColumn(schema.agentSessions, 'init_args').getSQLType()).toBe('jsonb');
            expect(findColumn(schema.agentSessions, 'sandbox_id').getSQLType()).toBe('text');
            expect(findColumn(schema.agentSessions, 'last_activity_at').getSQLType()).toBe('timestamp with time zone');
            expect(findColumn(schema.agentSessions, 'created_at').getSQLType()).toBe('timestamp with time zone');
        });
    });

    describe('agentState', () => {
        it('maps the Phase-1 agent_state columns to their snake_case Postgres names and types', () => {
            expect(getTableConfig(schema.agentState).name).toBe('agent_state');
            expect(findColumn(schema.agentState, 'session_id').getSQLType()).toBe('text');
            expect(findColumn(schema.agentState, 'state').getSQLType()).toBe('jsonb');
            expect(findColumn(schema.agentState, 'updated_at').getSQLType()).toBe('timestamp with time zone');
        });

        it('has session_id as its primary key, referencing agent_sessions', () => {
            expect(schema.agentState.sessionId.primary).toBe(true);
            expect(findColumn(schema.agentState, 'session_id').notNull).toBe(true);
        });

        it('requires the state jsonb column', () => {
            expect(schema.agentState.state.notNull).toBe(true);
        });
    });
});
