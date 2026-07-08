/**
 * App Service - Database operations for apps
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq, and, or, desc, asc, sql, isNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { formatRelativeTime } from '../../utils/timeFormatter';
import type {
    EnhancedAppData,
    AppWithFavoriteStatus,
    FavoriteToggleResult,
    PaginatedResult,
    AppQueryOptions,
    PublicAppQueryOptions,
    OwnershipResult,
    AppVisibilityUpdateResult,
    PaginationParams
} from '../types';
import { ScreenshotSecurity } from 'worker/utils/screenshot-security';

/**
 * Thrown by AppService methods/branches that depend on tables dropped in
 * the lean 7-table Postgres schema rewrite (favorites, stars, app_views -
 * see worker/database/schema.ts) and not yet re-added. Mutations that have
 * no meaningful safe default throw this instead of silently no-op'ing.
 */
export class DeferredInPhase2aError extends Error {
    constructor(method: string, table: string) {
        super(`[AppService] ${method} is not implemented in phase 2a: "${table}" table not yet ported to Postgres`);
        this.name = 'DeferredInPhase2aError';
    }
}

// Type definitions
type WhereCondition = ReturnType<typeof eq> | ReturnType<typeof and> | ReturnType<typeof or> | undefined;
type RankedAppQueryResult = {
    app: typeof schema.apps.$inferSelect;
    userName: string | null;
    userAvatar: string | null;
    viewCount: number;
    starCount: number;
    forkCount: number;
};

export class AppService extends BaseService {

    // ========================================
    // APP OPERATIONS
    // ========================================

    /**
     * Create a new app
     */
    async createApp(appData: schema.NewApp): Promise<schema.App> {
        const [app] = await this.database
            .insert(schema.apps)
            .values({
                ...appData,
            })
            .returning();
        return app;
    }
    /**
     * Get public apps with pagination and sorting
     */
    async getPublicApps(options: PublicAppQueryOptions = {}): Promise<PaginatedResult<EnhancedAppData>> {
        const {
            limit = 20,
            offset = 0,
            sort = 'recent',
            order = 'desc',
            framework,
            search,
            userId
        } = options;

        try {
            const whereConditions = this.buildPublicAppConditions(framework, search);
            const whereClause = this.buildWhereConditions(whereConditions);

            const basicApps = await this.executeRankedQuery(
                this.database,
                whereClause,
                sort,
                order,
                limit,
                offset
            ).catch((error: unknown) => {
                this.logger.error('executeRankedQuery failed', {
                    errorMessage: error instanceof Error ? error.message : String(error),
                    errorName: error instanceof Error ? error.name : 'UnknownError',
                    errorCause: error instanceof Error ? error.cause : undefined,
                    errorStack: error instanceof Error ? error.stack?.split('\n').slice(0, 5).join('\n') : undefined,
                    sort,
                    limit,
                    offset
                });
                throw error;
            });

            // Get total count for pagination
            const totalCountResult = await this.database
                .select({ count: sql<number>`COUNT(*)` })
                .from(schema.apps)
                .where(whereClause)
                .catch((error: unknown) => {
                    this.logger.error('Count query failed', {
                        errorMessage: error instanceof Error ? error.message : String(error),
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                        errorCause: error instanceof Error ? error.cause : undefined
                    });
                    throw error;
                });

            const total = totalCountResult[0]?.count || 0;

            if (basicApps.length === 0) {
                return {
                    data: [],
                    pagination: {
                        limit,
                        offset,
                        total,
                        hasMore: false
                    }
                };
            }

            const appIds = basicApps.map((row: RankedAppQueryResult) => row.app.id);

            const { userStars, userFavorites } = await this.addUserSpecificAppData(appIds, userId);

            const appsWithAnalytics: EnhancedAppData[] = basicApps.map((row: RankedAppQueryResult) => {
                const isStarred = userStars.has(row.app.id);
                const isFavorited = userFavorites.has(row.app.id);

                return {
                    ...row.app,
                    userName: row.userName,
                    userAvatar: row.userAvatar,
                    viewCount: row.viewCount || 0,
                    starCount: row.starCount || 0,
                    forkCount: row.forkCount || 0,
                    likeCount: 0,
                    userStarred: isStarred,
                    userFavorited: isFavorited
                };
            });

            return {
                data: await this.enrichScreenshotUrls(appsWithAnalytics),
                pagination: {
                    limit,
                    offset,
                    total,
                    hasMore: offset + limit < total
                }
            };
        } catch (error: unknown) {
            this.logger.error('getPublicApps failed', {
                errorMessage: error instanceof Error ? error.message : String(error),
                errorName: error instanceof Error ? error.name : 'UnknownError',
                errorCause: error instanceof Error ? error.cause : undefined,
                errorType: error?.constructor?.name || 'Unknown',
                options
            });
            throw error;
        }
    }

    /**
     * Helper to build common app filters (framework and search)
     * Used by both user apps and public apps to avoid duplication
     */
    private buildCommonAppFilters(framework?: string, search?: string): WhereCondition[] {
        const conditions: WhereCondition[] = [];

        if (framework) {
            conditions.push(eq(schema.apps.framework, framework));
        }

        if (search) {
            const searchTerm = `%${search.toLowerCase()}%`;
            conditions.push(
                or(
                    sql`LOWER(${schema.apps.title}) LIKE ${searchTerm}`,
                    sql`LOWER(${schema.apps.description}) LIKE ${searchTerm}`
                )
            );
        }

        return conditions.filter(Boolean);
    }

    /**
     * Helper to build public app query conditions
     */
    private buildPublicAppConditions(
        framework?: string,
        search?: string
    ): WhereCondition[] {
        const whereConditions: WhereCondition[] = [
            // Only show public apps or apps from anonymous users
            or(
                eq(schema.apps.visibility, 'public'),
                isNull(schema.apps.userId)
            ),
            or(
                eq(schema.apps.status, 'completed'),
                eq(schema.apps.status, 'generating')
            ),
            // Use shared helper for common filters
            ...this.buildCommonAppFilters(framework, search),
        ];

        return whereConditions.filter(Boolean);
    }

    /**
     * Update app record in database
     */
    async updateApp(
        appId: string,
        updates: Partial<typeof schema.apps.$inferInsert>
    ): Promise<boolean> {
        if (!appId) {
            return false;
        }

        try {
            await this.database
                .update(schema.apps)
                .set({
                    ...updates,
                    updatedAt: new Date()
                })
                .where(eq(schema.apps.id, appId));
            return true;
        } catch (error) {
            this.logger.error('[AppService] Failed to update app', { appId, error });
            return false;
        }
    }

    /**
     * Update app deployment ID
     */
    async updateDeploymentId(
        appId: string,
        deploymentId: string,
    ): Promise<boolean> {
        return this.updateApp(appId, {
            deploymentId,
        });
    }

    /**
     * Update app with GitHub repository URL and visibility
     */
    async updateGitHubRepository(
        appId: string,
        repositoryUrl: string,
        repositoryVisibility: 'public' | 'private'
    ): Promise<boolean> {
        return this.updateApp(appId, {
            githubRepositoryUrl: repositoryUrl,
            githubRepositoryVisibility: repositoryVisibility
        });
    }

    /**
     * Update app with screenshot data
     */
    async updateAppScreenshot(
        appId: string,
        screenshotUrl: string
    ): Promise<boolean> {
        return this.updateApp(appId, {
            screenshotUrl,
            screenshotCapturedAt: new Date()
        });
    }

    /**
     * Get user apps with favorite status.
     *
     * Deferred in 2a: `favorites` table not yet ported to Postgres
     * (dropped in the lean 7-table schema rewrite) - `isFavorite` is
     * always false until it lands.
     */
    async getUserAppsWithFavorites(
        userId: string,
        options: PaginationParams = {}
    ): Promise<AppWithFavoriteStatus[]> {
        const { limit = 50, offset = 0 } = options;

        const apps = await this.database
            .select()
            .from(schema.apps)
            .where(eq(schema.apps.userId, userId))
            .orderBy(desc(schema.apps.updatedAt))
            .limit(limit)
            .offset(offset);

        if (apps.length === 0) {
            return [];
        }

        const result = apps.map(app => ({
            ...app,
            isFavorite: false,
            updatedAtFormatted: formatRelativeTime(app.updatedAt)
        }));
        return this.enrichScreenshotUrls(result);
    }

    /**
     * Get recent user apps with favorite status
     */
    async getRecentAppsWithFavorites(
        userId: string,
        limit: number = 10
    ): Promise<AppWithFavoriteStatus[]> {
        return this.getUserAppsWithFavorites(userId, { limit, offset: 0 });
    }

    /**
     * Get only favorited apps for a user.
     *
     * Deferred in 2a: `favorites` table not yet ported to Postgres.
     */
    async getFavoriteAppsOnly(
        _userId: string
    ): Promise<AppWithFavoriteStatus[]> {
        throw new DeferredInPhase2aError('getFavoriteAppsOnly', 'favorites');
    }

    /**
     * Toggle favorite status for an app.
     *
     * Deferred in 2a: `favorites` table not yet ported to Postgres.
     */
    async toggleAppFavorite(_userId: string, _appId: string): Promise<FavoriteToggleResult> {
        throw new DeferredInPhase2aError('toggleAppFavorite', 'favorites');
    }

    /**
     * Check if user owns an app and get visibility
     */
    async checkAppOwnership(appId: string, userId: string): Promise<OwnershipResult> {
        const rows = await this.database
            .select({
                id: schema.apps.id,
                userId: schema.apps.userId,
                visibility: schema.apps.visibility
            })
            .from(schema.apps)
            .where(eq(schema.apps.id, appId))
            .limit(1);
        const app = rows[0];

        if (!app) {
            return { exists: false, isOwner: false };
        }

        return {
            exists: true,
            isOwner: app.userId === userId,
            visibility: app.visibility as 'private' | 'public' | null
        };
    }

    /**
     * Get single app with favorite status for user.
     *
     * Deferred in 2a: `favorites` table not yet ported to Postgres -
     * `isFavorite` is always false until it lands.
     */
    async getSingleAppWithFavoriteStatus(
        appId: string,
        userId: string
    ): Promise<AppWithFavoriteStatus | null> {
        const appRows = await this.database
            .select()
            .from(schema.apps)
            .where(eq(schema.apps.id, appId))
            .limit(1);
        const app = appRows[0];

        if (!app) {
            return null;
        }

        this.logger.debug('getSingleAppWithFavoriteStatus: favorites deferred in 2a', { appId, userId });

        const result = {
            ...app,
            isFavorite: false,
            updatedAtFormatted: formatRelativeTime(app.updatedAt)
        };
        const [enriched] = await this.enrichScreenshotUrls([result]);
        return enriched;
    }

    /**
     * Update app visibility with ownership check
     */
    async updateAppVisibility(
        appId: string,
        userId: string,
        visibility: 'private' | 'public'
    ): Promise<AppVisibilityUpdateResult> {
        // Check if app exists and user owns it
        const existingApp = await this.database
            .select({
                id: schema.apps.id,
                title: schema.apps.title,
                userId: schema.apps.userId,
                visibility: schema.apps.visibility
            })
            .from(schema.apps)
            .where(eq(schema.apps.id, appId))
            .limit(1);

        if (existingApp.length === 0) {
            return { success: false, error: 'App not found' };
        }

        if (existingApp[0].userId !== userId) {
            return { success: false, error: 'You can only change visibility of your own apps' };
        }

        // Update the app visibility
        const updatedApps = await this.database
            .update(schema.apps)
            .set({
                visibility,
                updatedAt: new Date()
            })
            .where(eq(schema.apps.id, appId))
            .returning({
                id: schema.apps.id,
                title: schema.apps.title,
                visibility: schema.apps.visibility,
                updatedAt: schema.apps.updatedAt
            });

        if (updatedApps.length === 0) {
            return { success: false, error: 'Failed to update app visibility' };
        }

        return { success: true, app: updatedApps[0] };
    }

    // ========================================
    // APP VIEW CONTROLLER OPERATIONS
    // ========================================

    /**
     * Get app details with stats.
     *
     * Deferred in 2a: viewCount/starCount/userStarred/userFavorited depend
     * on the appViews/stars/favorites tables (dropped in the lean 7-table
     * schema rewrite) - stubbed to zero/false until those tables land.
     */
    async getAppDetails(appId: string, userId?: string): Promise<EnhancedAppData | null> {
        const appRows = await this.database
            .select({
                app: schema.apps,
                userName: schema.users.displayName,
                userAvatar: schema.users.avatarUrl,
            })
            .from(schema.apps)
            .leftJoin(schema.users, eq(schema.apps.userId, schema.users.id))
            .where(eq(schema.apps.id, appId))
            .limit(1);
        const appResult = appRows[0];

        if (!appResult) {
            return null;
        }

        const app = appResult.app;

        this.logger.debug('getAppDetails: social stats deferred in 2a', { appId, userId });

        const result = {
            ...app,
            userName: appResult.userName,
            userAvatar: appResult.userAvatar,
            starCount: 0,
            userStarred: false,
            userFavorited: false,
            viewCount: 0
        };
        const [enriched] = await this.enrichScreenshotUrls([result]);
        return enriched;
    }

    /**
     * Toggle star status for an app (star/unstar).
     *
     * Deferred in 2a: `stars` table not yet ported to Postgres.
     */
    async toggleAppStar(_userId: string, _appId: string): Promise<{ isStarred: boolean; starCount: number }> {
        throw new DeferredInPhase2aError('toggleAppStar', 'stars');
    }

    /**
     * Record app view with duplicate prevention.
     *
     * Deferred in 2a: `app_views` table not yet ported to Postgres. This
     * is a fail-safe no-op rather than a throw, because `getAppDetails`
     * calls it unconditionally on every read - matching the original's
     * swallow-all-errors contract for view tracking.
     */
    async recordAppView(appId: string, userId: string): Promise<void> {
        this.logger.debug('recordAppView: deferred in 2a, appViews table not ported', { appId, userId });
    }

    /**
     * Get user apps with analytics data.
     *
     * Deferred in 2a: sort "starred" depends on `favorites` (dropped in
     * the lean 7-table schema rewrite) and throws; other sorts work, with
     * view/star counts stubbed to zero (see executeRankedQuery).
     */
    async getUserAppsWithAnalytics(userId: string, options: Partial<AppQueryOptions> = {}): Promise<EnhancedAppData[]> {
        const {
            limit = 50,
            offset = 0,
            status,
            visibility,
            framework,
            search,
            sort = 'recent',
            order = 'desc'
        } = options;

        if (sort === 'starred') {
            throw new DeferredInPhase2aError('getUserAppsWithAnalytics(sort=starred)', 'favorites');
        }

        const whereConditions: WhereCondition[] = [
            eq(schema.apps.userId, userId),
            status ? eq(schema.apps.status, status) : undefined,
            visibility ? eq(schema.apps.visibility, visibility) : undefined,
            ...this.buildCommonAppFilters(framework, search),
        ];

        const whereClause = this.buildWhereConditions(whereConditions);

        const basicApps = await this.executeRankedQuery(
            this.database,
            whereClause,
            sort,
            order,
            limit,
            offset
        );

        if (basicApps.length === 0) {
            return [];
        }

        const appIds = basicApps.map((row: RankedAppQueryResult) => row.app.id);
        const { userStars, userFavorites } = await this.addUserSpecificAppData(appIds, userId);

        const normalApps = basicApps.map((row: RankedAppQueryResult) => ({
            ...row.app,
            userName: row.userName,
            userAvatar: row.userAvatar,
            viewCount: row.viewCount || 0,
            starCount: row.starCount || 0,
            forkCount: row.forkCount || 0,
            likeCount: 0,
            userStarred: userStars.has(row.app.id),
            userFavorited: userFavorites.has(row.app.id)
        }));
        return this.enrichScreenshotUrls(normalApps);
    }

    /**
     * Get total count of user apps with filters (for pagination).
     *
     * Deferred in 2a: sort "starred" depends on `favorites` and throws.
     */
    async getUserAppsCount(userId: string, options: Partial<AppQueryOptions> = {}): Promise<number> {
        const { status, visibility, framework, search, sort = 'recent' } = options;

        if (sort === 'starred') {
            throw new DeferredInPhase2aError('getUserAppsCount(sort=starred)', 'favorites');
        }

        const whereConditions: WhereCondition[] = [
            eq(schema.apps.userId, userId),
            status ? eq(schema.apps.status, status) : undefined,
            visibility ? eq(schema.apps.visibility, visibility) : undefined,
            ...this.buildCommonAppFilters(framework, search),
        ];

        const whereClause = this.buildWhereConditions(whereConditions);

        const countResult = await this.database
            .select({ count: sql<number>`COUNT(*)` })
            .from(schema.apps)
            .where(whereClause);
        return countResult[0]?.count || 0;
    }

    /**
     * Execute ranked query for app listings.
     *
     * Deferred in 2a: trending/popular ranking depends on appViews/stars
     * (dropped in the lean 7-table schema rewrite) - both degrade to
     * recency ordering with view/star counts stubbed to zero. forkCount
     * stays real (self-join on `apps.parent_app_id`, no deferred table).
     */
    private async executeRankedQuery(
        db: PostgresJsDatabase<typeof schema>,
        whereClause: ReturnType<typeof this.buildWhereConditions>,
        sort: string,
        order: string,
        limit: number,
        offset: number
    ): Promise<RankedAppQueryResult[]> {
        if (sort === 'trending' || sort === 'popular') {
            const forkCountSubquery = sql<number>`(SELECT COUNT(*) FROM ${schema.apps} AS forks WHERE forks.parent_app_id = ${schema.apps.id})`;

            return db
                .select({
                    app: schema.apps,
                    userName: schema.users.displayName,
                    userAvatar: schema.users.avatarUrl,
                    viewCount: sql<number>`0`,
                    starCount: sql<number>`0`,
                    forkCount: forkCountSubquery,
                })
                .from(schema.apps)
                .leftJoin(schema.users, eq(schema.apps.userId, schema.users.id))
                .where(whereClause)
                .orderBy(desc(schema.apps.updatedAt))
                .limit(limit)
                .offset(offset);
        } else {
            // Simple query for recent sort ("starred" public-listing order
            // also depends on the deferred `stars` table; falls back to
            // recency, same as the default).
            const direction = order === 'asc' ? asc : desc;

            return db
                .select({
                    app: schema.apps,
                    userName: schema.users.displayName,
                    userAvatar: schema.users.avatarUrl,
                    ...this.getCountSubqueries(),
                })
                .from(schema.apps)
                .leftJoin(schema.users, eq(schema.apps.userId, schema.users.id))
                .where(whereClause)
                .orderBy(direction(schema.apps.updatedAt))
                .limit(limit)
                .offset(offset);
        }
    }

    private getCountSubqueries() {
        return {
            // Deferred in 2a: appViews/stars tables not yet ported.
            viewCount: sql<number>`0`,
            starCount: sql<number>`0`,
            forkCount: sql<number>`(SELECT COUNT(*) FROM ${schema.apps} AS forks WHERE forks.parent_app_id = ${schema.apps.id})`
        };
    }

    /**
     * Deferred in 2a: `stars`/`favorites` tables not yet ported to
     * Postgres. Always returns empty sets, consistent with this helper's
     * pre-existing error-fallback behavior.
     */
    private async addUserSpecificAppData(
        _appIds: string[],
        _userId?: string
    ): Promise<{ userStars: Set<string>; userFavorites: Set<string> }> {
        return { userStars: new Set(), userFavorites: new Set() };
    }

    /**
     * Delete an app with ownership verification and cascade delete related records.
     *
     * Deferred in 2a: favorites/stars/appViews cascade-deletes are skipped
     * - those tables don't exist yet in Postgres (dropped in the lean
     * 7-table schema rewrite), so there is nothing to clean up there.
     */
    async deleteApp(appId: string, userId: string): Promise<{ success: boolean; error?: string }> {
        try {
            // First check if app exists and user owns it
            const ownershipResult = await this.checkAppOwnership(appId, userId);

            if (!ownershipResult.exists) {
                return { success: false, error: 'App not found' };
            }

            if (!ownershipResult.isOwner) {
                return { success: false, error: 'You can only delete your own apps' };
            }

            // Handle fork relationships: make forks independent (don't delete them!)
            await this.database
                .update(schema.apps)
                .set({ parentAppId: null })
                .where(eq(schema.apps.parentAppId, appId));

            // Finally delete the app itself
            const deleteResult = await this.database
                .delete(schema.apps)
                .where(and(
                    eq(schema.apps.id, appId),
                    eq(schema.apps.userId, userId)
                ))
                .returning({ id: schema.apps.id });

            if (deleteResult.length === 0) {
                return { success: false, error: 'Failed to delete app - app may have been already deleted' };
            }

            return { success: true };
        } catch (error) {
            this.logger?.error('Error deleting app:', error);
            return { success: false, error: 'An error occurred while deleting the app' };
        }
    }

    // ========================================
    // SCREENSHOT URL SIGNING
    // ========================================

    private async enrichScreenshotUrls<T extends { id: string; screenshotUrl?: string | null }>(apps: T[]): Promise<T[]> {
        return new ScreenshotSecurity(this.env).enrichUrls(apps);
    }
}
