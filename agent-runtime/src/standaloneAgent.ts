/**
 * StandaloneAgent — implements `AgentHost` (AgentInfrastructure<AgentState> +
 * the coding-agent extras the WebSocket handler calls) over the standalone
 * runtime's own primitives: an in-memory state cache backed by Postgres
 * (`StateStore`), Supabase Realtime (`AgentTransport`), a real-fs git
 * checkout (`GitVersionControl` + `createNodeGitFs`), and `LocalSandboxService`
 * via the sandbox factory override hook.
 *
 * This class replicates `worker/agents/core/codingAgent.ts`
 * (`CodeGeneratorAgent`) minus: Workers Durable Object storage, the vault
 * secrets client, browser screenshot capture, D1-backed `AppService`/
 * `ModelConfigService` reads, and the `think` behavior. It intentionally does
 * NOT import `codingAgent.ts` — that module pulls in the `agents` SDK
 * (`Agent`, `getAgentByName`) at runtime, which assumes a Durable Object
 * host and is unavailable/unwanted in a plain Bun process.
 */

import { createObjectLogger, type StructuredLogger } from 'worker/logger';
import type { AgentInfrastructure } from 'worker/agents/core/AgentCore';
import type { AgentHost, ConnectionLike } from 'worker/agents/core/websocket';
import { handleWebSocketMessage, broadcastToConnections } from 'worker/agents/core/websocket';
import { WebSocketMessageResponses } from 'worker/agents/constants';
import type {
    AgentState,
    BaseProjectState,
    PhasicState,
    AgenticState,
} from 'worker/agents/core/state';
import { CurrentDevState, MAX_PHASES } from 'worker/agents/core/state';
import type {
    AgentInitArgs,
    BehaviorType,
    DeployOptions,
    DeployResult,
    ProjectType,
} from 'worker/agents/core/types';
import type { Blueprint } from 'worker/agents/schemas';
import type { InferenceMetadata } from 'worker/agents/inferutils/config.types';
import type { ConversationMessage, ConversationState } from 'worker/agents/inferutils/common';
import type { ImageAttachment } from 'worker/types/image-attachment';
import type { WebSocketMessageData, WebSocketMessageType } from 'worker/api/websocketTypes';
import type { TemplateDetails } from 'worker/services/sandbox/sandboxTypes';
import { setSandboxServiceFactory } from 'worker/services/sandbox/factory';

import { StateManager } from 'worker/agents/services/implementations/StateManager';
import { FileManager } from 'worker/agents/services/implementations/FileManager';
import { DeploymentManager } from 'worker/agents/services/implementations/DeploymentManager';
import { GitVersionControl } from 'worker/agents/git';

import type { BaseCodingBehavior } from 'worker/agents/core/behaviors/base';
import { PhasicCodingBehavior } from 'worker/agents/core/behaviors/phasic';
import { AgenticCodingBehavior } from 'worker/agents/core/behaviors/agentic';
import { getBehaviorTypeForProject } from 'worker/agents/core/features';
import { ProjectObjective } from 'worker/agents/core/objectives/base';
import { LocalConversationMessageLoader, type ConversationMessageLoader } from 'worker/agents/core/conversation/MessageLoader';

import { createNodeGitFs } from './nodeGitFs';
import type { AgentTransport } from './transport';
import type { StateStore } from './stateStore';
import type { ConversationStore } from './conversationStore';
import type { LocalSandboxService } from './localSandbox';

const DEFAULT_CONVERSATION_ID = 'default';

export interface StandaloneBootOptions {
    sessionId: string;
    agentId: string;
    workspaceDir: string;
    /** From `buildEnvAdapter()`. */
    env: Env;
    transport: AgentTransport;
    stateStore: StateStore;
    conversationStore: ConversationStore;
    sandbox: LocalSandboxService;
    /** `agent_sessions.init_args`, consulted only when no persisted state exists. */
    initArgs?: Record<string, unknown>;
    /** Surfaced to the client on the initial `agent_connected` broadcast. */
    selfPreviewBaseUrl?: string;
}

/**
 * Builds `initialState` exactly as `CodeGeneratorAgent.initialState` does
 * (codingAgent.ts:73-97), parameterized by the identity fields boot() knows
 * ahead of behavior selection.
 */
function buildInitialState(sessionId: string, agentId: string, userId: string): AgentState {
    return {
        behaviorType: 'unknown' as BehaviorType,
        projectType: 'unknown' as ProjectType,
        projectName: '',
        query: '',
        sessionId,
        hostname: '',
        blueprint: {} as unknown as Blueprint,
        templateName: '',
        generatedFilesMap: {},
        conversationMessages: [],
        metadata: { agentId, userId } as InferenceMetadata,
        shouldBeGenerating: false,
        sandboxInstanceId: undefined,
        commandsHistory: [],
        lastPackageJson: '',
        pendingUserInputs: [],
        projectUpdatesAccumulator: [],
        lastDeepDebugTranscript: null,
        mvpGenerated: false,
        reviewingInitiated: false,
        generatedPhases: [],
        currentDevState: CurrentDevState.IDLE,
        phasesCounter: MAX_PHASES,
    } as unknown as AgentState;
}

/** Mirrors `codingAgent.ts`'s private `deduplicateMessages` (codingAgent.ts:498-508). */
function deduplicateMessages(messages: ConversationMessage[]): ConversationMessage[] {
    const seen = new Set<string>();
    return messages.filter((msg) => {
        const key = `${msg.conversationId}-${msg.role}-${msg.tool_call_id || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Narrow shape read out of `StandaloneBootOptions.initArgs` for behavior/project selection. */
interface StandaloneInitArgs {
    behaviorType?: BehaviorType;
    projectType?: ProjectType;
    query?: string;
    userId?: string;
}

export class StandaloneAgent implements AgentHost {
    private _state!: AgentState;
    private _logger: StructuredLogger | undefined;
    private behavior!: BaseCodingBehavior<AgentState>;
    private objective!: ProjectObjective<BaseProjectState>;
    /** Hydrated once at boot; kept in sync on every mutation (crib note: sync interface over an async store). */
    private conversationCache!: ConversationState;

    readonly fileManager: FileManager;
    readonly deploymentManager: DeploymentManager;
    readonly git: GitVersionControl;
    readonly env: Env;

    private constructor(
        private readonly sessionId: string,
        private readonly agentId: string,
        env: Env,
        private readonly transport: AgentTransport,
        private readonly stateStore: StateStore,
        private readonly conversationStore: ConversationStore,
        private readonly sandbox: LocalSandboxService,
        workspaceDir: string,
        initialState: AgentState,
    ) {
        this.env = env;
        // Assigned before any service construction below: DeploymentManager's
        // constructor reads state eagerly (it seeds a sessionId into state if
        // absent), so `this._state` must already be valid the moment it runs
        // — matching how the Workers `Agent` SDK base class seeds `state`
        // before `CodeGeneratorAgent`'s own constructor body executes.
        this._state = initialState;

        const stateManager = new StateManager<AgentState>(
            () => this.state,
            (s) => this.setState(s),
        );

        this.git = new GitVersionControl(null as never, { fs: createNodeGitFs(workspaceDir) });
        this.fileManager = new FileManager(
            stateManager as unknown as StateManager<BaseProjectState>,
            () => this.behavior?.getTemplateDetails?.() || null,
            this.git,
        );
        this.deploymentManager = new DeploymentManager(
            {
                stateManager: stateManager as unknown as StateManager<BaseProjectState>,
                fileManager: this.fileManager,
                getLogger: () => this.logger(),
                env: this.env,
            },
            10,
        );
    }

    // ==========================================
    // Boot
    // ==========================================

    static async boot(options: StandaloneBootOptions): Promise<StandaloneAgent> {
        const initArgs = (options.initArgs ?? {}) as StandaloneInitArgs;

        const persisted = await options.stateStore.load();
        const initialState: AgentState = persisted
            ? (persisted as unknown as AgentState)
            : buildInitialState(options.sessionId, options.agentId, initArgs.userId ?? '');

        const agent = new StandaloneAgent(
            options.sessionId,
            options.agentId,
            options.env,
            options.transport,
            options.stateStore,
            options.conversationStore,
            options.sandbox,
            options.workspaceDir,
            initialState,
        );

        // Route worker/services/sandbox/factory's getSandboxService() to the
        // injected LocalSandboxService for the lifetime of this process.
        setSandboxServiceFactory(() => options.sandbox);

        // Hydrate the conversation cache synchronously so getConversationState()
        // (a sync member of AgentInfrastructure) can be served from memory.
        await agent.hydrateConversationCache();

        await agent.selectBehavior(initArgs);

        // getTemplateDetails() synchronously throws when nothing is cached
        // yet, but ALSO fires an un-awaited `ensureTemplateDetails()` call as
        // a side effect (worker/agents/core/behaviors/base.ts:218) whose
        // rejection cannot be caught here (the promise is never returned) —
        // on a bare boot with no templateName there is nothing to fetch, so
        // avoid invoking it at all rather than triggering an unhandled
        // rejection for a lookup that would fail regardless.
        let templateDetails: TemplateDetails | undefined;
        if (agent.state.templateName) {
            try {
                templateDetails = agent.behavior.getTemplateDetails();
            } catch {
                templateDetails = undefined;
            }
        }

        agent.broadcast('agent_connected', {
            state: agent.state,
            // templateDetails may be undefined on bare boot; the AgentConnectedMessage type requires it.
            templateDetails: templateDetails as TemplateDetails,
            previewUrl: options.selfPreviewBaseUrl ?? '',
        });

        options.stateStore.persist(agent.state);

        return agent;
    }

    /**
     * Replicates codingAgent.ts's onStart behavior-selection (lines 178-241)
     * minus the `think` branch (rejected outright) and the D1
     * ModelConfigService read (stubbed with an empty user-config record so
     * AGENT_CONFIG defaults apply).
     *
     * Deviation from the literal reference formula, documented here because
     * it affects which requests reject: `getBehaviorTypeForProject('app')`
     * currently resolves to `'think'` (worker/agents/core/features/types.ts),
     * so a bare boot with no persisted state and no initArgs — which the
     * reference's own onStart would happily hand to a ThinkCodingBehavior on
     * Workers — would otherwise reject here even though nobody asked for
     * `think`. Only an EXPLICIT request for `think` (via initArgs.behaviorType,
     * or a previously-persisted session whose state.behaviorType is already
     * `'think'`) rejects; a `think` resolution reached purely through the
     * projectType→behaviorType default falls back to `'agentic'` instead,
     * since phase 1 supports phasic/agentic and this default was never an
     * explicit request for the unsupported behavior.
     */
    private async selectBehavior(initArgs: StandaloneInitArgs): Promise<void> {
        const persistedProjectType = this.state.projectType;
        const projectType: ProjectType =
            initArgs.projectType ??
            (persistedProjectType && persistedProjectType !== ('unknown' as unknown as ProjectType)
                ? persistedProjectType
                : 'app');

        const persistedBehavior = this.state.behaviorType;
        const isValidPersisted =
            persistedBehavior === 'phasic' || persistedBehavior === 'agentic' || persistedBehavior === 'think';
        let behaviorType: BehaviorType =
            initArgs.behaviorType ?? (isValidPersisted ? persistedBehavior : getBehaviorTypeForProject(projectType));

        // The standalone runtime has no dedicated 'think' behavior yet; map it to
        // the agentic loop, which is its phase-1 equivalent (the frontend labels
        // 'think' the "adaptive agentic coding loop"). Applies whether think was
        // requested explicitly — the frontend's default "Agent" mode sends
        // behaviorType=think — or resolved by default. Previously an explicit
        // think request threw here and crashed the agent on boot.
        if (behaviorType === 'think') {
            behaviorType = 'agentic';
        }

        if (behaviorType === 'phasic') {
            this.behavior = new PhasicCodingBehavior(this as AgentInfrastructure<PhasicState>, projectType);
        } else {
            this.behavior = new AgenticCodingBehavior(this as AgentInfrastructure<AgenticState>, projectType);
        }

        this.objective = new ProjectObjective(this as AgentInfrastructure<BaseProjectState>, projectType);

        await this.behavior.onStart({ behaviorType, projectType });

        // Phase-1 stub: skip the ModelConfigService D1 read entirely. Passing
        // `undefined` (rather than an empty object, which cannot structurally
        // satisfy the full per-action Record<AgentActionKey, ModelConfig> the
        // real D1-backed service always returns) leaves userModelConfigs
        // unset, so downstream inference calls fall back to AGENT_CONFIG
        // defaults for every action — the same effective behavior the crib
        // describes as "empty record; AGENT_CONFIG defaults apply".
        this.behavior.setUserModelConfigs(undefined);

        if (!this.state.query) {
            // Not initialized yet (bare boot / fresh session) — skip the
            // gitInit + ensureTemplateDetails work codingAgent.ts only runs
            // once a query is present.
            return;
        }

        this.behavior.migrateStateIfNeeded();
        void this.gitInit();
        void this.behavior.ensureTemplateDetails();
    }

    private async gitInit(): Promise<void> {
        try {
            await this.git.init();
            const head = await this.git.getHead();
            if (!head) {
                const generatedFiles = this.fileManager.getGeneratedFiles();
                if (generatedFiles.length === 0) return;
                await this.git.commit(generatedFiles, 'Initial commit');
            }
        } catch (error) {
            this.logger().error('Error during git init:', error);
        }
    }

    // ==========================================
    // AgentInfrastructure<AgentState>
    // ==========================================

    get state(): AgentState {
        return this._state;
    }

    setState(state: AgentState): void {
        this._state = state;
        this.stateStore.persist(state);
    }

    getWebSockets(): WebSocket[] {
        return [this.transport.connection as unknown as WebSocket];
    }

    broadcast<T extends WebSocketMessageType>(type: T, data?: WebSocketMessageData<T>): void {
        broadcastToConnections(this, type, data ?? ({} as WebSocketMessageData<T>));
    }

    getAgentId(): string {
        return this.agentId;
    }

    logger(): StructuredLogger {
        if (!this._logger) {
            this._logger = createObjectLogger(this, 'StandaloneAgent');
            this._logger.setObjectId(this.agentId);
            this._logger.setField('sessionId', this.sessionId);
        }
        return this._logger;
    }

    exportGitObjects(): Promise<{
        gitObjects: Array<{ path: string; data: Uint8Array }>;
        query: string;
        hasCommits: boolean;
        templateDetails: TemplateDetails | null;
    }> {
        throw new Error('git object export is unsupported in the standalone agent runtime (phase 1)');
    }

    // ==========================================
    // Conversation management (cache-at-boot, write-through)
    // ==========================================

    private async hydrateConversationCache(): Promise<void> {
        const [fullRaw, compactRaw] = await Promise.all([
            this.conversationStore.loadAll('full'),
            this.conversationStore.loadAll('compact'),
        ]);
        let fullHistory = fullRaw as ConversationMessage[];
        let runningHistory = compactRaw as ConversationMessage[];
        if (runningHistory.length === 0) {
            runningHistory = fullHistory;
        }
        this.conversationCache = {
            id: DEFAULT_CONVERSATION_ID,
            runningHistory: deduplicateMessages(runningHistory),
            fullHistory: deduplicateMessages(fullHistory),
        };
    }

    getConversationState(): ConversationState {
        return this.conversationCache;
    }

    setConversationState(state: ConversationState): void {
        this.conversationCache = state;
        void this.conversationStore.replaceAll('full', state.fullHistory).catch((error) => {
            this.logger().error('Failed to persist full conversation history', error);
        });
        void this.conversationStore.replaceAll('compact', state.runningHistory).catch((error) => {
            this.logger().error('Failed to persist compact conversation history', error);
        });
    }

    addConversationMessage(message: ConversationMessage): void {
        const conversationState = this.getConversationState();
        const upsert = (history: ConversationMessage[]): ConversationMessage[] => {
            if (!history.find((msg) => msg.conversationId === message.conversationId)) {
                return [...history, message];
            }
            return history.map((msg) => (msg.conversationId === message.conversationId ? message : msg));
        };
        this.setConversationState({
            id: conversationState.id,
            runningHistory: upsert(conversationState.runningHistory),
            fullHistory: upsert(conversationState.fullHistory),
        });
    }

    clearConversation(): void {
        const clearedMessageCount = this.conversationCache.fullHistory.length;
        this.conversationCache = { id: DEFAULT_CONVERSATION_ID, runningHistory: [], fullHistory: [] };
        void this.conversationStore.clear().catch((error) => {
            this.logger().error('Failed to clear conversation store', error);
        });
        this.broadcast(WebSocketMessageResponses.CONVERSATION_CLEARED as 'conversation_cleared', {
            message: 'Conversation history cleared',
            clearedMessageCount,
        });
    }

    getConversationMessageLoader(): ConversationMessageLoader {
        return new LocalConversationMessageLoader(this);
    }

    // ==========================================
    // AgentHost extras
    // ==========================================

    getBehavior(): BaseCodingBehavior<AgentState> {
        return this.behavior;
    }

    async handleUserInput(userMessage: string, images?: ImageAttachment[]): Promise<void> {
        try {
            await this.behavior.handleUserInput(userMessage, images);
            if (!this.behavior.isCodeGenerating()) {
                this.behavior.generateAllFiles().catch((error) => {
                    this.logger().error('Error starting generation from user input:', error);
                });
            }
        } catch (error) {
            this.logger().error('Error processing user input', error);
            this.broadcast('error', {
                error: `Error processing user input: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }

    /**
     * Resolves "deploy" to the current sandbox preview URL instead of a
     * Cloudflare Workers-for-Platforms dispatch. The standalone runtime has
     * no publish/deploy primitive beyond the sandbox that already backs the
     * live preview — `LocalSandboxService.deployToCloudflareWorkers()` is an
     * always-failing stub (phase 1). This intentionally bypasses
     * `ProjectObjective.deploy()`, which is shared with the Workers
     * `CodeGeneratorAgent` (where `SandboxSdkClient.deployToCloudflareWorkers()`
     * is a real implementation that must keep working unchanged), instead of
     * routing through it. It reuses the existing `cloudflare_deployment_*`
     * broadcast types the frontend already listens for — only the resolved
     * URL and copy are honest now.
     */
    async deployProject(options?: DeployOptions): Promise<DeployResult> {
        const target = options?.target ?? 'platform';
        const instanceId = this.state.sandboxInstanceId ?? '';

        this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_STARTED, {
            message: 'Preparing your live preview...',
            instanceId,
        });

        try {
            const preview = await this.behavior.deployToSandbox();
            if (!preview?.previewURL) {
                const error = 'Sandbox preview is not available';
                this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_ERROR, {
                    message: `Deployment failed: ${error}`,
                    instanceId,
                    error,
                });
                return { success: false, target, error };
            }

            this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_COMPLETED, {
                message: 'Your app is live',
                instanceId: preview.runId ?? instanceId,
                deploymentUrl: preview.previewURL,
            });

            return {
                success: true,
                target,
                url: preview.previewURL,
                metadata: { sandboxInstanceId: preview.runId },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown deployment error';
            this.logger().error('Deployment failed', error);
            this.broadcast(WebSocketMessageResponses.CLOUDFLARE_DEPLOYMENT_ERROR, {
                message: 'Deployment failed',
                instanceId,
                error: message,
            });
            return { success: false, target, error: message };
        }
    }

    handleVaultUnlocked(): void {
        // No-op: the standalone runtime has no secrets vault client.
    }

    handleVaultLocked(): void {
        // No-op: the standalone runtime has no secrets vault client.
    }

    // ==========================================
    // WebSocket bridge
    // ==========================================

    handleClientMessage(raw: string): Promise<void> {
        return handleWebSocketMessage(this, this.transport.connection as ConnectionLike, raw);
    }

    // ==========================================
    // Lifecycle
    // ==========================================

    async shutdown(): Promise<void> {
        await this.stateStore.flush();
        await this.sandbox.shutdownInstance(`i-${this.sessionId}`).catch(() => {
            // Best-effort: shutdown must not fail the process teardown.
        });
        await this.transport.close();
    }
}
