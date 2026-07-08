import { WebSocketMessageResponses } from '../../../agents/constants';
import { BaseController } from '../baseController';
import { generateId } from '../../../utils/idGenerator';
import { BehaviorType, ProjectType } from '../../../agents/core/types';
import { getBehaviorTypeForProject } from '../../../agents/core/features';
import { getAgentStub } from '../../../agents';
import {
    AgentBootstrapResponse,
    AgentPreviewResponse,
    CodeGenArgs,
    MAX_AGENT_QUERY_LENGTH,
} from './types';
import { SecurityError, SecurityErrorType } from 'shared/types/errors';
import { ApiResponse, ControllerResponse } from '../types';
import { RouteContext } from '../../types/route-context';
import { AppService } from '../../../database';
import { AgentSessionService } from '../../../database/services/AgentSessionService';
import { mintSessionJwt } from '../../../services/auth/sessionJwt';
import { bootAgentSandbox, getAgentPreviewUrl } from '../../../services/sandbox/agentSandboxBoot';
import { validateWebSocketOrigin } from '../../../middleware/security/websocket';
import { createLogger } from '../../../logger';
import { hasTicketParam } from '../../../middleware/auth/ticketAuth';

const resolveBehaviorType = (body: CodeGenArgs): BehaviorType => {
    if (body.behaviorType) return body.behaviorType;
    // Defer to the feature-definitions registry (DEFAULT_FEATURE_DEFINITIONS)
    // so the single source of truth for "what engine drives this project
    // type" lives alongside the rest of the feature config.
    return getBehaviorTypeForProject(body.projectType ?? 'app');
};

const resolveProjectType = (body: CodeGenArgs): ProjectType | 'auto' => {
    return body.projectType || 'auto';
};


/**
 * CodingAgentController to handle all code generation related endpoints
 */
export class CodingAgentController extends BaseController {
    static logger = createLogger('CodingAgentController');
    /**
     * Create the app + agent session rows and boot the Superserve agent
     * sandbox for this chat. Returns a bootstrap payload the browser uses
     * to join the session's Supabase Realtime channel directly.
     */
    static async startCodeGeneration(request: Request, env: Env, _: ExecutionContext, context: RouteContext): Promise<Response> {
        try {
            this.logger.info('Starting code generation process');

            // Parse the query from the request body
            let body: CodeGenArgs;
            try {
                body = await request.json() as CodeGenArgs;
            } catch (error) {
                return CodingAgentController.createErrorResponse(`Invalid JSON in request body: ${JSON.stringify(error, null, 2)}`, 400);
            }

            const query = body.query;
            if (typeof query !== 'string' || query.trim().length === 0) {
                return CodingAgentController.createErrorResponse('Missing "query" field in request body', 400);
            }
            if (query.length > MAX_AGENT_QUERY_LENGTH) {
                return CodingAgentController.createErrorResponse(
                    new SecurityError(
                        SecurityErrorType.INVALID_INPUT,
                        `Prompt too large (${query.length} characters). Maximum allowed is ${MAX_AGENT_QUERY_LENGTH} characters.`,
                        413,
                    ),
                    413,
                );
            }

            // Auth is enforced by the `setAuthLevel(AuthConfig.authenticated)` route middleware.
            const user = context.user!;

            const agentId = generateId();
            const sessionId = agentId;

            await new AppService(env).createApp({
                id: agentId,
                title: query.slice(0, 100) || 'Untitled App',
                originalPrompt: query,
                userId: user.id,
                status: 'generating',
            });

            await new AgentSessionService(env).createAgentSession({
                sessionId,
                agentId,
                userId: user.id,
                initArgs: {
                    query,
                    projectType: resolveProjectType(body),
                    behaviorType: resolveBehaviorType(body),
                },
            });

            const token = await mintSessionJwt(sessionId, env);

            // The Vercel ExecutionContext stub no-ops `waitUntil`, so the
            // sandbox boot must be awaited inline rather than deferred.
            let previewUrl: string | null = null;
            try {
                const boot = await bootAgentSandbox({ sessionId, agentId, sessionJwt: token, env });
                previewUrl = boot.previewUrl;
                await new AgentSessionService(env).updateSandboxId(sessionId, boot.sandboxId);
            } catch (error) {
                this.logger.error('Agent sandbox boot failed', error);
                // Known limitation for this thin vertical: apps.status has no
                // 'failed' value, so the app row is left in 'generating'.
                return CodingAgentController.createErrorResponse('Failed to boot agent sandbox', 502);
            }

            return CodingAgentController.createSuccessResponse<AgentBootstrapResponse>({
                agentId,
                sessionId,
                realtimeChannel: `session:${sessionId}`,
                previewUrl,
                token,
            });
        } catch (error) {
            this.logger.error('Error starting code generation', error);
            return CodingAgentController.handleError(error, 'start code generation');
        }
    }

    /**
     * Handle WebSocket connections for code generation
     * This routes the WebSocket connection directly to the Agent
     * 
     * Supports two authentication methods:
     * 1. Ticket-based auth (SDK): ?ticket=tk_xxx in URL
     * 2. JWT-based auth (Browser): Cookie/Header with origin validation
     */
    static async handleWebSocketConnection(
        request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<Response> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse('Missing agent ID parameter', 400);
            }

            // Ensure the request is a WebSocket upgrade request
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket upgrade', { status: 426 });
            }

            // User already authenticated via ticket OR JWT by middleware
            const user = context.user;
            if (!user) {
                return CodingAgentController.createErrorResponse('Authentication required', 401);
            }

            // Origin validation only for non-ticket auth (ticket auth is origin-agnostic)
            const isTicketAuth = hasTicketParam(request);
            if (!isTicketAuth && !validateWebSocketOrigin(request, env)) {
                return new Response('Forbidden: Invalid origin', { status: 403 });
            }

            this.logger.info('WebSocket connection authorized', {
                agentId,
                userId: user.id,
                authMethod: isTicketAuth ? 'ticket' : 'jwt',
            });

            try {
                // Get the agent instance to handle the WebSocket connection
                const agentInstance = await getAgentStub(env, agentId);

                // Let the agent handle the WebSocket connection directly
                return agentInstance.fetch(request);
            } catch (error) {
                this.logger.error(`Failed to get agent instance with ID ${agentId}:`, error);
                // Return an appropriate WebSocket error response
                const { 0: client, 1: server } = new WebSocketPair();

                server.accept();
                server.send(JSON.stringify({
                    type: WebSocketMessageResponses.ERROR,
                    error: `Failed to get agent instance: ${error instanceof Error ? error.message : String(error)}`
                }));

                server.close(1011, 'Agent instance not found');

                return new Response(null, {
                    status: 101,
                    webSocket: client
                });
            }
        } catch (error) {
            this.logger.error('Error handling WebSocket connection', error);
            return CodingAgentController.handleError(error, 'handle WebSocket connection');
        }
    }

    /**
     * Reconnect to an existing agent session. Mints a fresh session JWT and
     * resolves the session's Realtime channel + current preview URL so the
     * browser can rejoin an in-progress or completed generation.
     */
    static async connectToAgent(request: Request, env: Env, _: ExecutionContext, context: RouteContext): Promise<Response> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse('Missing agent ID parameter', 400);
            }

            // 1:1 mapping between agent and session for this vertical.
            const sessionId = agentId;
            const session = await new AgentSessionService(env).getAgentSession(sessionId);
            if (!session) {
                return CodingAgentController.createErrorResponse('Agent session not found', 404);
            }

            const token = await mintSessionJwt(sessionId, env);

            let previewUrl: string | null = null;
            if (session.sandboxId) {
                try {
                    previewUrl = await getAgentPreviewUrl(session.sandboxId, env);
                } catch (error) {
                    this.logger.warn('Failed to resolve agent preview url', { sessionId, error });
                }
            }

            return CodingAgentController.createSuccessResponse<AgentBootstrapResponse>({
                agentId,
                sessionId,
                realtimeChannel: `session:${sessionId}`,
                previewUrl,
                token,
            });
        } catch (error) {
            this.logger.error('Error connecting to agent', error);
            return CodingAgentController.handleError(error, 'connect to agent');
        }
    }

    static async deployPreview(
        _request: Request,
        env: Env,
        _: ExecutionContext,
        context: RouteContext
    ): Promise<ControllerResponse<ApiResponse<AgentPreviewResponse>>> {
        try {
            const agentId = context.pathParams.agentId;
            if (!agentId) {
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Missing agent ID parameter', 400);
            }

            const appService = new AppService(env);
            const appResult = await appService.getAppDetails(agentId);

            if (!appResult) {
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('App not found', 404);
            }

            // Check if app is public
            if(appResult.visibility !== 'public') {
                // If user is logged in and is the owner, allow preview deployment
                const user = context.user;
                if (!user || user.id !== appResult.userId) {
                    return CodingAgentController.createErrorResponse<AgentPreviewResponse>('App is not public. Preview deployment is only available for public apps.', 403);
                }
            }
            this.logger.info(`Deploying preview for agent: ${agentId}`);

            try {
                // Get the agent instance
                const agentInstance = await getAgentStub(env, agentId);
                
                // Deploy the preview
                const preview = await agentInstance.deployToSandbox();
                if (!preview) {
                    return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Failed to deploy preview', 500);
                }
                this.logger.info('Preview deployed successfully', {
                    agentId,
                    previewUrl: preview.previewURL
                });

                return CodingAgentController.createSuccessResponse(preview);
            } catch (error) {
                this.logger.error('Failed to deploy preview', { agentId, error });
                return CodingAgentController.createErrorResponse<AgentPreviewResponse>('Failed to deploy preview', 500);
            }
        } catch (error) {
            this.logger.error('Error deploying preview', error);
            const appError = CodingAgentController.handleError(error, 'deploy preview') as ControllerResponse<ApiResponse<AgentPreviewResponse>>;
            return appError;
        }
    }
}
