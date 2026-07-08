import { CodingAgentController } from '../controllers/agent/controller';
import { AppEnv } from '../../types/appenv';
import { Hono } from 'hono';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';
import { adaptController } from '../honoAdapter';

/**
 * Setup and configure the application router
 */
export function setupCodegenRoutes(app: Hono<AppEnv>): void {
    // ========================================
    // CODE GENERATION ROUTES
    // ========================================

    // CRITICAL: Create new app - requires full authentication
    app.post('/api/agent', setAuthLevel(AuthConfig.authenticated), adaptController(CodingAgentController, CodingAgentController.startCodeGeneration));

    // Reconnect to an existing agent session - owner-only
    app.get('/api/agent/:agentId/connect', setAuthLevel(AuthConfig.ownerOnly), adaptController(CodingAgentController, CodingAgentController.connectToAgent));
}