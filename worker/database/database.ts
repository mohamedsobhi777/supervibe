/**
 * Core Database Service
 * Provides database connection, core utilities, and base operations∂ƒ
 */

import { drizzle } from 'drizzle-orm/d1';
import * as Sentry from '@sentry/cloudflare';
import * as schema from './schema';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import type { HealthStatusResult } from './types';
import { isStandaloneRuntime } from '../utils/runtimeMode';
import { createNoopD1Database } from './noopD1';

// ========================================
// TYPE DEFINITIONS AND INTERFACES
// ========================================

export type {
    User, NewUser, Session, NewSession,
    App, NewApp,
    AppLike, NewAppLike, AppComment, NewAppComment,
    AppView, NewAppView, OAuthState, NewOAuthState,
    SystemSetting, NewSystemSetting,
    UserModelConfig, NewUserModelConfig,
} from './schema';


/**
 * Core Database Service - Connection and Base Operations
 * 
 * Provides database connection, shared utilities, and core operations.
 * Domain-specific operations are handled by dedicated service classes.
 */
export class DatabaseService {
    public readonly db: DrizzleD1Database<typeof schema>;
    private readonly d1: D1Database;
    private readonly enableReplicas: boolean;

    constructor(env: Env) {
        // Standalone agent runtime has no D1 binding: env.DB is a poisoned
        // proxy (agent-runtime/src/envAdapter.ts) that throws on ANY property
        // access, including Sentry's instrumentation reading `db.prepare` to
        // wrap it. Substitute a genuine no-op D1Database instead of touching
        // the poisoned binding at all — writes no-op successfully, reads
        // return empty results. Workers env never carries this sentinel, so
        // this branch never runs there and instrumentation is unchanged.
        const instrumented = isStandaloneRuntime(env)
            ? createNoopD1Database()
            : Sentry.instrumentD1WithSentry(env.DB);
        this.d1 = instrumented;
        this.db = drizzle(instrumented, { schema });
        this.enableReplicas = env.ENABLE_READ_REPLICAS === 'true';
    }

    /**
     * Get a read-optimized database connection using D1 Sessions API
     * This routes queries to read replicas for lower global latency
     * 
     * @param strategy - Session strategy:
     *   - 'fast' (default): Routes to any replica for lowest latency
     *   - 'fresh': Routes first query to primary for latest data
     * @returns Drizzle database instance configured for read operations
     */
    public getReadDb(strategy: 'fast' | 'fresh' = 'fast'): DrizzleD1Database<typeof schema> {
        // Return regular db if replicas are disabled
        if (!this.enableReplicas) {
            return this.db;
        }

        const sessionType = strategy === 'fresh' ? 'first-primary' : 'first-unconstrained';
        const session = this.d1.withSession(sessionType);
        // D1DatabaseSession is compatible with D1Database for Drizzle operations
        return drizzle(session as unknown as D1Database, { schema });
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