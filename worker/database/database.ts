/**
 * Core Database Service
 * Provides database connection, core utilities, and base operations
 */

import * as schema from './schema';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import type { HealthStatusResult } from './types';
import { buildDrizzle } from './pgConnection';

// ========================================
// TYPE DEFINITIONS AND INTERFACES
// ========================================

export type {
    User, NewUser,
    App, NewApp,
    UserModelConfig, NewUserModelConfig,
    UserModelProvider, NewUserModelProvider,
    UserSecret, NewUserSecret,
    RateLimitBucket, NewRateLimitBucket,
    SystemSetting, NewSystemSetting,
    AgentSession, NewAgentSession,
} from './schema';


/**
 * Core Database Service - Connection and Base Operations
 * 
 * Provides database connection, shared utilities, and core operations.
 * Domain-specific operations are handled by dedicated service classes.
 */
export class DatabaseService {
    public readonly db: PostgresJsDatabase<typeof schema>;

    constructor(env: Env) {
        // Standalone agent runtime -> no-op Postgres client (never opens a
        // real connection); Workers runtime -> real postgres-js client
        // against Supabase. See `buildDrizzle` / `isStandaloneRuntime`.
        this.db = buildDrizzle(env);
    }

    /**
     * Returns the database connection.
     *
     * Retained for source compatibility with callers written against the
     * D1 read-replica API (D1 Sessions API `'fast' | 'fresh'` strategies).
     * Postgres over postgres-js has no equivalent read-replica session API,
     * so both strategies now resolve to the single pooled connection.
     */
    public getReadDb(_strategy: 'fast' | 'fresh' = 'fast'): PostgresJsDatabase<typeof schema> {
        return this.db;
    }

    // ========================================
    // UTILITY METHODS
    // ========================================

    async getHealthStatus(): Promise<HealthStatusResult> {
        try {
            await this.db.select().from(schema.systemSettings).limit(1);
            return {
                healthy: true,
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            return {
                healthy: false,
                timestamp: new Date().toISOString(),
            };
        }
    }
}

/**
 * Factory function to create database service instance
 */
export function createDatabaseService(env: Env): DatabaseService {
    return new DatabaseService(env);
}