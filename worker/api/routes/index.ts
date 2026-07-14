import { setupAppRoutes } from './appRoutes';
import { setupUserRoutes } from './userRoutes';
import { setupAnalyticsRoutes } from './analyticsRoutes';
import { setupSecretsRoutes } from './secretsRoutes';
import { setupModelConfigRoutes } from './modelConfigRoutes';
import { setupModelProviderRoutes } from './modelProviderRoutes';
import { setupSkillsRoutes } from './skillsRoutes';
import { setupGitHubExporterRoutes } from './githubExporterRoutes';
import { setupCodegenRoutes } from './codegenRoutes';
import { setupScreenshotRoutes } from './imagesRoutes';
import { setupSentryRoutes } from './sentryRoutes';
import { setupCapabilitiesRoutes } from './capabilitiesRoutes';
import { setupLimitsRoutes } from './limitsRoutes';
import { Hono } from "hono";
import { AppEnv } from "../../types/appenv";
import { setupStatusRoutes } from './statusRoutes';
import { CsrfService } from '../../services/csrf/CsrfService';
import { successResponse } from '../responses';

export function setupRoutes(app: Hono<AppEnv>): void {
    // Health check route
    app.get('/api/health', (c) => {
        return c.json({ status: 'ok' });
    });

    // CSRF token endpoint (public). The SPA fetches this before any
    // state-changing request to satisfy the double-submit cookie check: the
    // token is returned in the body (the csrf-token cookie is HttpOnly, so JS
    // can't read it) and set as the cookie, so cookie==header on the follow-up
    // write. Retired with the hand-rolled auth routes in phase 2a, but the
    // api-client still depends on it; the app.ts CSRF middleware skips its own
    // auto-set for this path so it doesn't overwrite the token returned here.
    app.get('/api/auth/csrf-token', (c) => {
        const token = CsrfService.getOrGenerateToken(c.req.raw);
        const expiresIn = Math.floor(CsrfService.defaults.tokenTTL / 1000);
        const response = successResponse({ token, expiresIn });
        CsrfService.setTokenCookie(response, token, expiresIn);
        return response;
    });

    // Sentry tunnel routes (public - no auth required)
    setupSentryRoutes(app);

    // Platform status routes (public)
    setupStatusRoutes(app);

    // Platform capabilities routes (public)
    setupCapabilitiesRoutes(app);

    // Authentication is handled client-side by Supabase Auth as of phase 2a;
    // the hand-rolled register/login/OAuth/session/API-key routes that used
    // to live here were retired along with AuthService/SessionService/
    // ApiKeyService. Cloudflare "Connect" OAuth and account/gateway
    // management routes were retired with CloudflareAccountService (the
    // cloudflareAccounts/aiGateways tables are deferred).

    // Codegen routes
    setupCodegenRoutes(app);

    // User dashboard and profile routes
    setupUserRoutes(app);

    // App management routes
    setupAppRoutes(app);

    // Stats routes were retired with AnalyticsService (depends on the
    // deferred favorites/appViews/appLikes tables).

    // AI Gateway Analytics routes
    setupAnalyticsRoutes(app);

    // Secrets management routes (static templates only - legacy D1-based
    // CRUD routes were retired along with the D1 secrets store)
    setupSecretsRoutes(app);

    // Model configuration and provider keys routes
    setupModelConfigRoutes(app);

    // Model provider routes
    setupModelProviderRoutes(app);

    // Custom agent skill routes
    setupSkillsRoutes(app);

    // GitHub Exporter routes
    setupGitHubExporterRoutes(app);

    // Screenshot serving routes (public)
    setupScreenshotRoutes(app);

    // Usage limits and free tier routes
    setupLimitsRoutes(app);
}
