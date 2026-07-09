/**
 * App Service - Database operations for apps
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq, and, or, desc, asc, sql, isNull, inArray } from 'drizzle-orm';
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
 * Thrown by AppService methods/branches that depend on Postgres tables
 * not yet ported from the pre-2a schema. `favorites`/`stars` were ported
 * in supabase/migrations/20260709000001_favorites_stars.sql; `app_views`
 * remains deferred (see `recordAppView`, a no-op rather than a throw).
 * Mutations with no meaningful safe default throw this instead of
 * silently no-op'ing.
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

        const appIds = apps.map(app => app.id);
        const userFavorites = await this.getUserFavoriteAppIds(userId, appIds);

        const result = apps.map(app => ({
            ...app,
            isFavorite: userFavorites.has(app.id),
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
     * Get only favorited apps for a user, most-recently-favorited first.
     */
    async getFavoriteAppsOnly(
        userId: string,
        options: PaginationParams = {}
    ): Promise<AppWithFavoriteStatus[]> {
        const { limit = 50, offset = 0 } = options;

        const rows = await this.database
            .select({ app: schema.apps })
            .from(schema.favorites)
            .innerJoin(schema.apps, eq(schema.favorites.appId, schema.apps.id))
            .where(eq(schema.favorites.userId, userId))
            .orderBy(desc(schema.favorites.createdAt))
            .limit(limit)
            .offset(offset);

        if (rows.length === 0) {
            return [];
        }

        const result = rows.map(({ app }) => ({
            ...app,
            isFavorite: true,
            updatedAtFormatted: formatRelativeTime(app.updatedAt)
        }));
        return this.enrichScreenshotUrls(result);
    }

    /**
     * Toggle favorite status for an app: inserts a `favorites` row if
     * none exists for (userId, appId), otherwise deletes it.
     */
    async toggleAppFavorite(userId: string, appId: string): Promise<FavoriteToggleResult> {
        const existing = await this.database
            .select({ userId: schema.favorites.userId })
            .from(schema.favorites)
            .where(and(eq(schema.favorites.userId, userId), eq(schema.favorites.appId, appId)))
            .limit(1);

        if (existing.length > 0) {
            await this.database
                .delete(schema.favorites)
                .where(and(eq(schema.favorites.userId, userId), eq(schema.favorites.appId, appId)));
            return { isFavorite: false };
        }

        await this.database
            .insert(schema.favorites)
            .values({ userId, appId })
            .onConflictDoNothing();
        return { isFavorite: true };
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
     * Get single app with favorite status for user. Real `isFavorite`,
     * sourced from the `favorites` table via `getUserFavoriteAppIds` (the
     * same helper the list queries use).
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

        const userFavorites = await this.getUserFavoriteAppIds(userId, [appId]);

        const result = {
            ...app,
            isFavorite: userFavorites.has(appId),
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
     * `starCount` is real (via `getStarCountSubquery`, a correlated
     * per-row subquery - same pattern `executeRankedQuery` uses).
     * `userStarred`/`userFavorited` are real for an authenticated viewer
     * (via `addUserSpecificAppData`, the same helper the list queries
     * use); an anonymous viewer (no `userId`) gets `false` for both,
     * matching that helper's short-circuit. `viewCount` stays stubbed to
     * zero - it depends on the still-deferred `appViews` table (see
     * `recordAppView`).
     */
    async getAppDetails(appId: string, userId?: string): Promise<EnhancedAppData | null> {
        const appRows = await this.database
            .select({
                app: schema.apps,
                userName: schema.users.displayName,
                userAvatar: schema.users.avatarUrl,
                starCount: this.getStarCountSubquery(),
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
        const { userStars, userFavorites } = await this.addUserSpecificAppData([appId], userId);

        const result = {
            ...app,
            userName: appResult.userName,
            userAvatar: appResult.userAvatar,
            starCount: appResult.starCount || 0,
            userStarred: userStars.has(appId),
            userFavorited: userFavorites.has(appId),
            viewCount: 0
        };
        const [enriched] = await this.enrichScreenshotUrls([result]);
        return enriched;
    }

    /**
     * Toggle star status for an app: inserts a `stars` row if none exists
     * for (userId, appId), otherwise deletes it. Returns the app's total
     * star count after the toggle.
     */
    async toggleAppStar(userId: string, appId: string): Promise<{ isStarred: boolean; starCount: number }> {
        const existing = await this.database
            .select({ userId: schema.stars.userId })
            .from(schema.stars)
            .where(and(eq(schema.stars.userId, userId), eq(schema.stars.appId, appId)))
            .limit(1);

        const isStarred = existing.length === 0;
        if (isStarred) {
            await this.database
                .insert(schema.stars)
                .values({ userId, appId })
                .onConflictDoNothing();
        } else {
            await this.database
                .delete(schema.stars)
                .where(and(eq(schema.stars.userId, userId), eq(schema.stars.appId, appId)));
        }

        const countResult = await this.database
            .select({ count: sql<number>`COUNT(*)` })
            .from(schema.stars)
            .where(eq(schema.stars.appId, appId));
        const starCount = countResult[0]?.count || 0;

        return { isStarred, starCount };
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
     * View counts stay stubbed to zero (appViews table still deferred -
     * see executeRankedQuery); star counts are real, including for
     * sort="starred".
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
     * Get total count of user apps with filters (for pagination). Count
     * is sort-independent, including for sort="starred".
     */
    async getUserAppsCount(userId: string, options: Partial<AppQueryOptions> = {}): Promise<number> {
        const { status, visibility, framework, search } = options;

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
     * Deferred in 2a: appViews table not yet ported, so trending/popular
     * ranking (which should weight recent view velocity) degrades to
     * recency ordering, and viewCount stays stubbed to zero. starCount is
     * real (see `getStarCountSubquery`) in every branch, including a
     * dedicated "starred" branch that orders by it. forkCount is real
     * (self-join on `apps.parent_app_id`, no deferred table).
     */
    private async executeRankedQuery(
        db: PostgresJsDatabase<typeof schema>,
        whereClause: ReturnType<typeof this.buildWhereConditions>,
        sort: string,
        order: string,
        limit: number,
        offset: number
    ): Promise<RankedAppQueryResult[]> {
        const direction = order === 'asc' ? asc : desc;

        if (sort === 'starred') {
            const starCountSubquery = this.getStarCountSubquery();

            return db
                .select({
                    app: schema.apps,
                    userName: schema.users.displayName,
                    userAvatar: schema.users.avatarUrl,
                    viewCount: sql<number>`0`,
                    starCount: starCountSubquery,
                    forkCount: this.getForkCountSubquery(),
                })
                .from(schema.apps)
                .leftJoin(schema.users, eq(schema.apps.userId, schema.users.id))
                .where(whereClause)
                .orderBy(direction(starCountSubquery), desc(schema.apps.updatedAt))
                .limit(limit)
                .offset(offset);
        }

        if (sort === 'trending' || sort === 'popular') {
            return db
                .select({
                    app: schema.apps,
                    userName: schema.users.displayName,
                    userAvatar: schema.users.avatarUrl,
                    viewCount: sql<number>`0`,
                    starCount: this.getStarCountSubquery(),
                    forkCount: this.getForkCountSubquery(),
                })
                .from(schema.apps)
                .leftJoin(schema.users, eq(schema.apps.userId, schema.users.id))
                .where(whereClause)
                .orderBy(desc(schema.apps.updatedAt))
                .limit(limit)
                .offset(offset);
        }

        // Simple query for recent sort (default).
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

    /**
     * Correlated per-row scalar subquery counting `stars` rows for an
     * app. Same pattern as `getForkCountSubquery`.
     */
    private getStarCountSubquery() {
        return sql<number>`(SELECT COUNT(*) FROM ${schema.stars} WHERE ${schema.stars.appId} = ${schema.apps.id})`;
    }

    /**
     * Correlated per-row scalar subquery counting apps forked from this
     * app (self-join on `apps.parent_app_id`, no deferred table).
     */
    private getForkCountSubquery() {
        return sql<number>`(SELECT COUNT(*) FROM ${schema.apps} AS forks WHERE forks.parent_app_id = ${schema.apps.id})`;
    }

    private getCountSubqueries() {
        return {
            // Deferred in 2a: appViews table not yet ported.
            viewCount: sql<number>`0`,
            starCount: this.getStarCountSubquery(),
            forkCount: this.getForkCountSubquery(),
        };
    }

    /**
     * Real per-user star/favorite membership for a set of app ids, used
     * to populate `userStarred`/`userFavorited` on listing rows.
     */
    private async addUserSpecificAppData(
        appIds: string[],
        userId?: string
    ): Promise<{ userStars: Set<string>; userFavorites: Set<string> }> {
        if (!userId || appIds.length === 0) {
            return { userStars: new Set(), userFavorites: new Set() };
        }

        const [userStars, userFavorites] = await Promise.all([
            this.getUserStarredAppIds(userId, appIds),
            this.getUserFavoriteAppIds(userId, appIds),
        ]);

        return { userStars, userFavorites };
    }

    /**
     * App ids (from `appIds`) that `userId` has favorited.
     */
    private async getUserFavoriteAppIds(userId: string, appIds: string[]): Promise<Set<string>> {
        if (appIds.length === 0) {
            return new Set();
        }

        const rows = await this.database
            .select({ appId: schema.favorites.appId })
            .from(schema.favorites)
            .where(and(eq(schema.favorites.userId, userId), inArray(schema.favorites.appId, appIds)));

        return new Set(rows.map(row => row.appId));
    }

    /**
     * App ids (from `appIds`) that `userId` has starred.
     */
    private async getUserStarredAppIds(userId: string, appIds: string[]): Promise<Set<string>> {
        if (appIds.length === 0) {
            return new Set();
        }

        const rows = await this.database
            .select({ appId: schema.stars.appId })
            .from(schema.stars)
            .where(and(eq(schema.stars.userId, userId), inArray(schema.stars.appId, appIds)));

        return new Set(rows.map(row => row.appId));
    }

    /**
     * Delete an app with ownership verification and cascade delete related records.
     *
     * favorites/stars rows for this app are removed automatically by
     * their `ON DELETE CASCADE` foreign keys to apps.id (see schema.ts) -
     * no explicit cleanup needed here. appViews cascade-delete is still
     * deferred - that table doesn't exist yet in Postgres.
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
