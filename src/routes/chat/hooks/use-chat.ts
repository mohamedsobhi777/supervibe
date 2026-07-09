import type { WebSocket } from 'partysocket';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
    RateLimitExceededError,
	MAX_AGENT_QUERY_LENGTH,
	type BlueprintType,
	type WebSocketMessage,
	type CodeFixEdits,
	type ImageAttachment,
	type ProjectType,
	type BehaviorType,
	type FileType,
	type TemplateDetails,
	getBehaviorTypeForProject,
} from '@/api-types';
import { getFileType } from '@/utils/string';
import { logger } from '@/utils/logger';
import { mergeFiles } from '@/utils/file-helpers';
import { apiClient } from '@/lib/api-client';
import { appEvents } from '@/lib/app-events';
import { supabase } from '@/lib/supabase';
import { createWebSocketMessageHandler, type HandleMessageDeps, type BackendErrorDialogState } from '../utils/handle-websocket-message';
import { isConversationalMessage, addOrUpdateMessage, createUserMessage, handleRateLimitError, createAIMessage, type ChatMessage } from '../utils/message-helpers';
import { sendWebSocketMessage } from '../utils/websocket-helpers';
import { initialStages as defaultStages, updateStage as updateStageHelper } from '../utils/project-stage-helpers';
import type { ProjectStage } from '../utils/project-stage-helpers';
import { useLimitsContext } from '@/contexts/limits-context';

export type Edit = Omit<CodeFixEdits, 'type'>;

// New interface for phase timeline tracking
export interface PhaseTimelineItem {
	id: string;
	name: string;
	description: string;
	files: {
		path: string;
		purpose: string;
		status: 'generating' | 'completed' | 'error' | 'validating' | 'cancelled';
		contents?: string;
	}[];
	status: 'generating' | 'completed' | 'error' | 'validating' | 'cancelled';
	timestamp: number;
}

export function useChat({
	chatId: urlChatId,
	query: userQuery,
	images: userImages,
	projectType = 'app',
	behaviorType: explicitBehaviorType,
	autoStart = true,
	onDebugMessage,
	onTerminalMessage,
	onVaultUnlockRequired,
}: {
	chatId?: string;
	query: string | null;
	images?: ImageAttachment[];
	projectType?: ProjectType;
	behaviorType?: BehaviorType;
	/**
	 * Whether a brand-new session may be created automatically on mount.
	 * In-app navigation (e.g. the home prompt box) sets this true. Sessions
	 * opened from an external/pasted link leave it false so the query — which
	 * is interpolated into the LLM system prompt — requires an explicit user
	 * gesture before it runs, preventing zero-click prompt injection.
	 */
	autoStart?: boolean;
	onDebugMessage?: (type: 'error' | 'warning' | 'info' | 'websocket', message: string, details?: string, source?: string, messageType?: string, rawMessage?: unknown) => void;
	onTerminalMessage?: (log: { id: string; content: string; type: 'command' | 'stdout' | 'stderr' | 'info' | 'error' | 'warn' | 'debug'; timestamp: number; source?: string }) => void;
	onVaultUnlockRequired?: (reason: string) => void;
}) {
	// Derive initial behavior type from explicit override or project type using feature system
	const getInitialBehaviorType = (): BehaviorType => {
		return explicitBehaviorType ?? getBehaviorTypeForProject(projectType);
	};

	const connectionStatus = useRef<'idle' | 'connecting' | 'connected' | 'failed' | 'retrying'>('idle');
	// Track whether component is mounted and should still react to realtime
	// channel status events (SUBSCRIBED/CHANNEL_ERROR/etc.)
	const shouldReconnectRef = useRef(true);
	// Track deployment timeout for cleanup
	const deploymentTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	// The session's Supabase Realtime channel, and whether it is currently
	// subscribed. Backs the WebSocket-shim's `readyState`.
	const channelRef = useRef<RealtimeChannel | null>(null);
	const subscribedRef = useRef(false);
	const [chatId, setChatId] = useState<string>();
	// Phasic/agentic flows show a placeholder "Thinking..." message until
	// the backend streams the first phase. The think behavior streams the user's
	// prompt and the assistant reply directly, so the placeholder would
	// linger forever; start with an empty thread for that behavior.
	const [messages, setMessages] = useState<ChatMessage[]>(
		getInitialBehaviorType() === 'think'
			? []
			: [createAIMessage('main', 'Thinking...', true)],
	);

	const [bootstrapFiles, setBootstrapFiles] = useState<FileType[]>([]);
	const [blueprint, setBlueprint] = useState<BlueprintType>();
	const [previewUrl, setPreviewUrl] = useState<string>();
	const [query, setQuery] = useState<string>();
	const [behaviorType, setBehaviorType] = useState<BehaviorType>(getInitialBehaviorType());
	const [internalProjectType, setInternalProjectType] = useState<ProjectType>(projectType);
	const [templateDetails, setTemplateDetails] = useState<TemplateDetails | null>(null);
	// Gate for externally-sourced new sessions: true while awaiting the user's
	// explicit confirmation before the query is sent to the agent.
	const [awaitingStartConfirmation, setAwaitingStartConfirmation] = useState(false);
	const startConfirmedRef = useRef(false);
	const [startTrigger, setStartTrigger] = useState(0);

	const confirmStart = useCallback(() => {
		startConfirmedRef.current = true;
		setAwaitingStartConfirmation(false);
		setStartTrigger((n) => n + 1);
	}, []);

	const [websocket, setWebsocket] = useState<WebSocket>();

	// Blueprint generation is no longer a distinct tracked phase: blueprint
	// content now arrives via channel messages (`blueprint_chunk`,
	// `agent_connected`) handled directly by the WebSocket message
	// dispatcher, so `isBootstrapping` alone covers the loading gate.
	const isGeneratingBlueprint = false;
	const [isBootstrapping, setIsBootstrapping] = useState(true);

	const [projectStages, setProjectStages] = useState<ProjectStage[]>(defaultStages);

	// Get refetch function from limits context for usage updates
	const { refetch: refetchLimits } = useLimitsContext();

	// New state for phase timeline tracking
	const [phaseTimeline, setPhaseTimeline] = useState<PhaseTimelineItem[]>([]);

	const [files, setFiles] = useState<FileType[]>([]);

	const [totalFiles, setTotalFiles] = useState<number>();

	const [edit, setEdit] = useState<Omit<CodeFixEdits, 'type'>>();

	// Deployment and generation control state
	const [isDeploying, setIsDeploying] = useState(false);
	const [cloudflareDeploymentUrl, setCloudflareDeploymentUrl] = useState<string>('');
	const [deploymentError, setDeploymentError] = useState<string>();
	
	// Issue tracking and debugging state
	const [runtimeErrorCount, setRuntimeErrorCount] = useState(0);
	const [staticIssueCount, setStaticIssueCount] = useState(0);
	const [isDebugging, setIsDebugging] = useState(false);
	
	// Preview deployment state
	const [isPreviewDeploying, setIsPreviewDeploying] = useState(false);
	
	// Redeployment state - tracks when redeploy button should be enabled
	const [isRedeployReady, setIsRedeployReady] = useState(false);
	// const [lastDeploymentPhaseCount, setLastDeploymentPhaseCount] = useState(0);
	const [isGenerationPaused, setIsGenerationPaused] = useState(false);
	const [isGenerating, setIsGenerating] = useState(false);

	// Phase progress visual indicator (used to apply subtle throb on chat)
	const [isPhaseProgressActive, setIsPhaseProgressActive] = useState(false);

	const [isThinking, setIsThinking] = useState(false);
	
	// Preview refresh state - triggers preview reload after deployment
	const [shouldRefreshPreview, setShouldRefreshPreview] = useState(false);
	
	// Backend error dialog state - for showing limit errors with CTAs
	const [backendErrorDialog, setBackendErrorDialog] = useState<BackendErrorDialogState>({
		isOpen: false
	});
	
	// Track whether we've completed initial state restoration to avoid disrupting active sessions
	const [isInitialStateRestored, setIsInitialStateRestored] = useState(false);

	const updateStage = useCallback(
		(stageId: ProjectStage['id'], data: Partial<Omit<ProjectStage, 'id'>>) => {
			logger.debug('updateStage', { stageId, ...data });
			setProjectStages(prev => updateStageHelper(prev, stageId, data));
		},
		[],
	);

	const onCompleteBootstrap = useCallback(() => {
		updateStage('bootstrap', { status: 'completed' });
	}, [updateStage]);

	const clearEdit = useCallback(() => {
		setEdit(undefined);
	}, []);

	// Callback to clear deployment timeout (used by websocket handler)
	const clearDeploymentTimeout = useCallback(() => {
		if (deploymentTimeoutRef.current) {
			clearTimeout(deploymentTimeoutRef.current);
			deploymentTimeoutRef.current = null;
		}
	}, []);


	const sendMessage = useCallback((message: ChatMessage) => {
		// Only add conversational messages to the chat UI
		if (!isConversationalMessage(message.conversationId)) return;
		setMessages((prev: ChatMessage[]) => addOrUpdateMessage(prev, message));
	}, []);

	const sendUserMessage = useCallback((message: string) => {
		setMessages(prev => [...prev, createUserMessage(message)]);
	}, []);

	const loadBootstrapFiles = useCallback((files: FileType[]) => {
		setBootstrapFiles((prev) => [
			...prev,
			...files.map((file) => ({
				...file,
				language: getFileType(file.filePath),
			})),
		]);
	}, []);

	// Create the WebSocket message handler
	const handleWebSocketMessage = useMemo(
		() =>
			createWebSocketMessageHandler({
			// State setters
			setFiles,
			setPhaseTimeline,
			setProjectStages,
			setMessages,
			setBlueprint,
			setQuery,
			setPreviewUrl,
			setTotalFiles,
			setIsRedeployReady,
			setIsPreviewDeploying,
			setIsThinking,
			setIsInitialStateRestored,
			setShouldRefreshPreview,
			setIsDeploying,
			setCloudflareDeploymentUrl,
			setDeploymentError,
			setIsGenerationPaused,
			setIsGenerating,
			setIsPhaseProgressActive,
			setRuntimeErrorCount,
			setStaticIssueCount,
			setIsDebugging,
			setBehaviorType,
			setInternalProjectType,
			setTemplateDetails,
			setBackendErrorDialog,
			// Current state
			isInitialStateRestored,
			blueprint,
			query,
			bootstrapFiles,
			files,
			phaseTimeline,
			previewUrl,
			projectStages,
			isGenerating,
			urlChatId,
			behaviorType,
			// Functions
			updateStage,
			sendMessage,
			loadBootstrapFiles,
			refetchLimits,
			onDebugMessage,
			onTerminalMessage,
			onVaultUnlockRequired,
			clearDeploymentTimeout,
			onPresentationFileEvent: (evt) => {
				if (!evt.path.includes('/slides/')) return;
				window.dispatchEvent(new CustomEvent('presentation-file-event', { detail: evt }));
			},
		} as HandleMessageDeps),
		[
			isInitialStateRestored,
			blueprint,
			query,
			bootstrapFiles,
			files,
			phaseTimeline,
			previewUrl,
			projectStages,
			isGenerating,
			urlChatId,
			behaviorType,
			updateStage,
			sendMessage,
			loadBootstrapFiles,
			refetchLimits,
			onDebugMessage,
			onTerminalMessage,
			onVaultUnlockRequired,
			clearDeploymentTimeout,
		],
	);

	// Surface a hard Realtime channel failure. Supabase's client retries
	// transient drops internally, so reaching this path means the channel
	// could not be (re)established.
	const handleChannelFailure = useCallback(
		(reason: string) => {
			connectionStatus.current = 'failed';
			logger.error('❌ Realtime channel connection failed:', reason);

			// `websocket_failed` is not in isConversationalMessage's allowlist, so
			// the chat-thread message below never renders; surface a toast so the
			// failure is never silently swallowed.
			toast.error('Connection to the agent was lost. Please refresh the page to try again.');
			sendMessage(createAIMessage('websocket_failed', `🚨 Connection to the agent was lost.\n\n❌ Reason: ${reason}\n\n🔄 Please refresh the page to try again.`));

			onDebugMessage?.('error',
				'Realtime Channel Connection Failed',
				reason,
				'Realtime Connection'
			);
		},
		[sendMessage, onDebugMessage],
	);

	// Join the session's Supabase Realtime channel and wire it up as the
	// transport for the (unchanged) WebSocket message dispatcher, via a thin
	// shim exposing only the `.send`/`.readyState` subset that dispatcher and
	// the preview iframe rely on.
	const connectChannel = useCallback(
		async (
			realtimeChannel: string,
			token: string,
			opts?: { disableGenerate?: boolean },
		) => {
			logger.debug('🔌 Joining realtime channel:', realtimeChannel);

			connectionStatus.current = 'connecting';
			subscribedRef.current = false;

			// Consumers (chat.tsx, useGitHubExport) treat this shim as a
			// WebSocket and register 'message'/'open' handlers via
			// addEventListener, so the shim must implement the listener API in
			// addition to send/readyState — otherwise `.addEventListener is not
			// a function` throws and crashes the chat view.
			const messageListeners = new Set<(event: MessageEvent) => void>();
			const openListeners = new Set<() => void>();

			const shim = {
				send: (data: string) => {
					channelRef.current?.send({
						type: 'broadcast',
						event: 'client',
						payload: { raw: data },
					});
				},
				get readyState() {
					return subscribedRef.current ? 1 : 0;
				},
				addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
					if (type === 'message') messageListeners.add(listener);
					else if (type === 'open') openListeners.add(listener as unknown as () => void);
				},
				removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
					if (type === 'message') messageListeners.delete(listener);
					else if (type === 'open') openListeners.delete(listener as unknown as () => void);
				},
			};

			await supabase.realtime.setAuth(token);
			const channel = supabase.channel(realtimeChannel, {
				config: { broadcast: { self: false }, private: true },
			});
			channelRef.current = channel;

			channel.on('broadcast', { event: 'message' }, ({ payload }) => {
				handleWebSocketMessage(shim as unknown as WebSocket, payload as WebSocketMessage);
				// Also notify addEventListener('message') consumers (e.g. model
				// config info in chat.tsx), which expect a MessageEvent whose
				// `.data` is the raw JSON string.
				if (messageListeners.size > 0) {
					const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
					const messageEvent = { data: raw } as MessageEvent;
					messageListeners.forEach((listener) => listener(messageEvent));
				}
			});

			channel.subscribe((status) => {
				if (!shouldReconnectRef.current) return;

				if (status === 'SUBSCRIBED') {
					logger.info('✅ Realtime channel subscribed successfully!');
					connectionStatus.current = 'connected';
					subscribedRef.current = true;
					setWebsocket(shim as unknown as WebSocket);
					openListeners.forEach((listener) => listener());

					// Always request conversation state explicitly (running/full history)
					sendWebSocketMessage(shim as unknown as WebSocket, 'get_conversation_state');

					// Request file generation for new chats only
					if (!opts?.disableGenerate) {
						logger.debug('🔄 Starting code generation for new chat');
						setIsGenerating(true);
						sendWebSocketMessage(shim as unknown as WebSocket, 'generate_all');
					}
				} else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
					subscribedRef.current = false;
					handleChannelFailure(`Realtime channel ${status}`);
				}
			});
		},
		[handleWebSocketMessage, handleChannelFailure],
	);

	useEffect(() => {
		async function init() {
			if (!urlChatId || connectionStatus.current !== 'idle') return;

			try {
				if (urlChatId === 'new') {
					if (!userQuery) {
						const errorMsg = 'Please enter a description of what you want to build';
						logger.error('Query is required for new code generation');
						toast.error(errorMsg);
						return;
					}

					if (userQuery.length > MAX_AGENT_QUERY_LENGTH) {
						const errorMsg = `Prompt too large (${userQuery.length} characters). Maximum allowed is ${MAX_AGENT_QUERY_LENGTH} characters.`;
						toast.error(errorMsg);
						setMessages(() => [createAIMessage('main', errorMsg)]);
						return;
					}

					// Gate externally-sourced sessions: the query feeds the agent's
					// system prompt, so require an explicit user gesture before it
					// runs when the session was not started from in-app navigation.
					if (!autoStart && !startConfirmedRef.current) {
						setAwaitingStartConfirmation(true);
						return;
					}

					// Prevent duplicate session creation on rerenders while streaming
					connectionStatus.current = 'connecting';

					const initialBehaviorType = getBehaviorTypeForProject(projectType);
					if (initialBehaviorType === 'phasic') {
						sendMessage(
							createAIMessage('main', "Sure, let's get started. Bootstrapping the project first...", true),
						);
					}

					// Start new code generation using API client. The bootstrap
					// payload only carries the Realtime channel + token; blueprint,
					// template files, and phases arrive as channel messages handled
					// by the (unchanged) WebSocket message dispatcher.
					const bootstrap = await apiClient.createAgentSession({
						query: userQuery,
						projectType,
						behaviorType: explicitBehaviorType,
						images: userImages, // Pass images from URL params for multi-modal blueprint
					});

					setIsBootstrapping(false);
					setChatId(bootstrap.agentId);
					if (bootstrap.previewUrl) {
						setPreviewUrl(bootstrap.previewUrl);
					}

					logger.debug('connecting to realtime channel for new session');
					await connectChannel(bootstrap.realtimeChannel, bootstrap.token);

					// Emit app-created event for sidebar updates
					appEvents.emitAppCreated(bootstrap.agentId, {
						title: userQuery || 'New App',
						description: userQuery,
					});
				} else if (connectionStatus.current === 'idle') {
					// Prevent duplicate connect calls on rerenders
					connectionStatus.current = 'connecting';

					setIsBootstrapping(false);
					// Show a thinking placeholder while we fetch the agent
					// summary. The think behavior rehydrates from the ThinkAgent DO via
					// `GET_CONVERSATION_STATE`, which produces the real
					// thread directly — no placeholder is needed there.
					if (getBehaviorTypeForProject(projectType) !== 'think') {
						setMessages(() => [
							createAIMessage('fetching-chat', 'Starting from where you left off...', true),
						]);
					}

					// Fetch existing agent connection details
					const response = await apiClient.connectToAgent(urlChatId);
					if (!response.success || !response.data) {
						logger.error('Failed to fetch existing chat:', { chatId: urlChatId, error: response.error });
						throw new Error(response.error?.message || 'Failed to connect to agent');
					}

					logger.debug('Existing agent bootstrap API result', response.data);
					// Set the chatId for existing chat - this enables the chat input
					setChatId(urlChatId);

					if (response.data.previewUrl) {
						setPreviewUrl(response.data.previewUrl);
					}

					logger.debug('connecting from init for existing chatId');
					await connectChannel(response.data.realtimeChannel, response.data.token, {
						disableGenerate: true, // We'll handle generation resume once state is restored
					});
				}
			} catch (error) {
				// Allow retry on failure
				connectionStatus.current = 'idle';
				logger.error('Error initializing code generation:', error);
				if (error instanceof RateLimitExceededError) {
					const rateLimitMessage = handleRateLimitError(error.details, onDebugMessage);
					setMessages(prev => [...prev, rateLimitMessage]);
				}
			}
		}
		init();
	}, [
		projectType,
		explicitBehaviorType,
		connectChannel,
		onDebugMessage,
		sendMessage,
		urlChatId,
		userImages,
		userQuery,
		autoStart,
		startTrigger,
	]);

    // Mount/unmount: enable/disable reaction to realtime channel status
    // events, and tear down the channel + any pending deployment timeout.
    useEffect(() => {
        shouldReconnectRef.current = true;
        return () => {
            shouldReconnectRef.current = false;
            channelRef.current?.unsubscribe();
            channelRef.current = null;
            // Clear deployment timeout on unmount
            if (deploymentTimeoutRef.current) {
                clearTimeout(deploymentTimeoutRef.current);
                deploymentTimeoutRef.current = null;
            }
        };
    }, []);

	useEffect(() => {
		if (edit) {
			// When edit is cleared, write the edit changes
			return () => {
				setFiles((prev) =>
					prev.map((file) => {
						if (file.filePath === edit.filePath) {
							file.fileContents = file.fileContents.replace(
								edit.search,
								edit.replacement,
							);
						}
						return file;
					}),
				);
			};
		}
	}, [edit]);

	// Track debugging state based on deep_debug tool events in messages
	useEffect(() => {
		const hasActiveDebug = messages.some(msg => 
			msg.role === 'assistant' && 
			msg.ui?.toolEvents?.some(event => 
				event.name === 'deep_debug' && event.status === 'start'
			)
		);
		setIsDebugging(hasActiveDebug);
	}, [messages]);

	// Control functions for deployment and generation
	const handleStopGeneration = useCallback(() => {
		sendWebSocketMessage(websocket, 'stop_generation');
	}, [websocket]);

	const handleResumeGeneration = useCallback(() => {
		sendWebSocketMessage(websocket, 'resume_generation');
	}, [websocket]);

	const handleDeployToCloudflare = useCallback(async (instanceId: string) => {
		try {
			// Send deployment command via WebSocket instead of HTTP request
			if (sendWebSocketMessage(websocket, 'deploy', { instanceId })) {
				logger.debug('🚀 Deployment WebSocket message sent:', instanceId);

				// Clear any existing deployment timeout
				if (deploymentTimeoutRef.current) {
					clearTimeout(deploymentTimeoutRef.current);
					deploymentTimeoutRef.current = null;
				}
				
				// Set 1-minute timeout for deployment
				deploymentTimeoutRef.current = setTimeout(() => {
					if (isDeploying) {
						logger.warn('Deployment timeout after 1 minute');

						// Reset deployment state
						setIsDeploying(false);
						setCloudflareDeploymentUrl('');
						setIsRedeployReady(false);

						// Show timeout message
						sendMessage(createAIMessage('deployment_timeout', `Deployment timed out after 1 minute.\n\nPlease try deploying again. The server may be busy.`));

						// Debug logging for timeout
						onDebugMessage?.('warning',
							'Deployment Timeout',
							`Deployment for ${instanceId} timed out after 60 seconds`,
							'Deployment Timeout Management'
						);
					}
					deploymentTimeoutRef.current = null;
				}, 60000); // 1 minute = 60,000ms

			} else {
				throw new Error('WebSocket connection not available');
			}
		} catch (error) {
			logger.error('Error sending deployment WebSocket message:', error);

			// Set deployment state immediately for UI feedback
			setIsDeploying(true);
			// Clear any previous deployment error
			setDeploymentError('');
			setCloudflareDeploymentUrl('');
			setIsRedeployReady(false);

			sendMessage(createAIMessage('deployment_error', `Failed to initiate deployment: ${error instanceof Error ? error.message : 'Unknown error'}\n\nYou can try again.`));
		}
	}, [websocket, sendMessage, isDeploying, onDebugMessage]);

	const allFiles = useMemo(() => mergeFiles(bootstrapFiles, files), [bootstrapFiles, files]);

	return {
		messages,
		edit,
		bootstrapFiles,
		chatId,
		query,
		files,
		blueprint,
		previewUrl,
		isGeneratingBlueprint,
		isBootstrapping,
		totalFiles,
		websocket,
		sendUserMessage,
		sendAiMessage: sendMessage,
		clearEdit,
		projectStages,
		phaseTimeline,
		isThinking,
		onCompleteBootstrap,
		// Deployment and generation control
		isDeploying,
		cloudflareDeploymentUrl,
		deploymentError,
		isRedeployReady,
		isGenerationPaused,
		isGenerating,
		handleStopGeneration,
		handleResumeGeneration,
		handleDeployToCloudflare,
		// Preview refresh control
		shouldRefreshPreview,
		// Preview deployment state
		isPreviewDeploying,
		// Phase progress visual indicator
		isPhaseProgressActive,
		// Issue tracking and debugging state
		runtimeErrorCount,
		staticIssueCount,
		isDebugging,
		// Behavior type from backend
		behaviorType,
		projectType: internalProjectType,
		templateDetails,
		allFiles,
		// Backend error dialog state
		backendErrorDialog,
		setBackendErrorDialog,
		// Externally-sourced session start gate
		awaitingStartConfirmation,
		confirmStart,
	};
}
