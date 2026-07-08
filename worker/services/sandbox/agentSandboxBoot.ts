/**
 * Boots a SuperServe sandbox from the `vibesdk-agent` template and starts
 * the standalone agent process (agent-runtime/src/main.ts) inside it,
 * detached, for one chat session.
 *
 * Importable counterpart of scripts/superserve/boot-agent-sandbox.ts: same
 * behavior, but config comes from `opts.env` instead of `process.env`, and
 * there is no console output, process exit, or agent.log tailing — callers
 * observe failure via the thrown Error and success via the returned
 * { sandboxId, previewUrl }.
 *
 * Requires a HOSTED Supabase project: the agent connects out to
 * SUPABASE_URL over the public internet (PostgREST + Realtime) to load
 * session state and stream to the client.
 */

import { Sandbox } from '@superserve/sdk';

const AGENT_PORT = 8080;
const START_TIMEOUT_MS = 15_000;

/** Hostnames the agent process legitimately needs: package registries, source hosts, AI providers, and the Supabase project itself. */
const DEFAULT_EGRESS_ALLOW = [
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'bun.sh',
    'github.com',
    'codeload.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'api.anthropic.com',
    'api.openai.com',
    'generativelanguage.googleapis.com',
    'openrouter.ai',
    'api.cerebras.ai',
    'api.groq.com',
    'gateway.ai.cloudflare.com',
];

/** Derives the Supabase project host from SUPABASE_URL so PostgREST/Realtime egress is allowed. */
function supabaseHostFrom(supabaseUrl: string): string {
    return new URL(supabaseUrl).hostname;
}

function buildEgressAllowlist(supabaseUrl: string): string[] {
    return [...new Set([...DEFAULT_EGRESS_ALLOW, supabaseHostFrom(supabaseUrl)])];
}

interface RequiredBootEnv {
    apiKey: string;
    supabaseUrl: string;
    supabaseAnonKey: string;
    templatesBaseUrl: string;
}

/** Collects all missing required vars and throws a single error listing them. */
function readRequiredEnv(source: Record<string, string | undefined>): RequiredBootEnv {
    const required = [
        'SUPERSERVE_API_KEY',
        'SUPABASE_URL',
        'SUPABASE_ANON_KEY',
        'TEMPLATES_BASE_URL',
    ] as const;

    const missing = required.filter((key) => !source[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    return {
        apiKey: source.SUPERSERVE_API_KEY!,
        supabaseUrl: source.SUPABASE_URL!,
        supabaseAnonKey: source.SUPABASE_ANON_KEY!,
        templatesBaseUrl: source.TEMPLATES_BASE_URL!,
    };
}

/**
 * Injectable Sandbox factory, reusing the SDK's own `create` signature so
 * the real `@superserve/sdk` Sandbox is provably assignable as the default.
 */
type SandboxFactory = Pick<typeof Sandbox, 'create'>;

/**
 * Boots a SuperServe sandbox for one chat session and starts the standalone
 * agent process inside it, detached.
 */
export async function bootAgentSandbox(opts: {
    sessionId: string;
    agentId: string;
    sessionJwt: string;
    env: Env;
    api?: SandboxFactory;
}): Promise<{ sandboxId: string; previewUrl: string }> {
    const api = opts.api ?? Sandbox;
    const source = opts.env as unknown as Record<string, string | undefined>;
    const bootEnv = readRequiredEnv(source);
    const templateName = source.SUPERSERVE_AGENT_TEMPLATE ?? 'vibesdk-agent';
    const baseUrl = source.SUPERSERVE_BASE_URL || undefined;

    const envVars: Record<string, string> = {
        SESSION_ID: opts.sessionId,
        AGENT_ID: opts.agentId,
        WORKSPACE_DIR: '/workspace',
        SUPABASE_URL: bootEnv.supabaseUrl,
        SUPABASE_ANON_KEY: bootEnv.supabaseAnonKey,
        SUPABASE_SESSION_JWT: opts.sessionJwt,
        TEMPLATES_BASE_URL: bootEnv.templatesBaseUrl,
    };
    if (source.CLOUDFLARE_AI_GATEWAY_URL) {
        envVars.CLOUDFLARE_AI_GATEWAY_URL = source.CLOUDFLARE_AI_GATEWAY_URL;
    }
    if (source.CLOUDFLARE_AI_GATEWAY_TOKEN) {
        envVars.CLOUDFLARE_AI_GATEWAY_TOKEN = source.CLOUDFLARE_AI_GATEWAY_TOKEN;
    }

    const sandbox = await api.create({
        apiKey: bootEnv.apiKey,
        baseUrl,
        name: `agent-${opts.sessionId}`,
        fromTemplate: templateName,
        envVars,
        network: { allowOut: buildEgressAllowlist(bootEnv.supabaseUrl) },
        metadata: {
            vibesdk_kind: 'agent',
            vibesdk_session: opts.sessionId,
        },
    });

    // setsid/nohup detaches the agent process from this exec's process
    // group: boxd SIGKILLs the exec's process group on timeout, and the
    // agent must outlive this short-lived start command.
    await sandbox.commands.run(
        'cd /opt/vibesdk && setsid nohup bun agent-runtime/src/main.ts > /workspace/agent.log 2>&1 < /dev/null & echo $!',
        { timeoutMs: START_TIMEOUT_MS },
    );

    const previewUrl = sandbox.getPreviewUrl(AGENT_PORT);

    return { sandboxId: sandbox.id, previewUrl };
}

/**
 * Resolves the live preview URL for an already-booted agent sandbox by
 * reconnecting to it via its sandbox ID. Used by the agent-connect endpoint
 * to hand the browser a fresh preview URL without re-provisioning anything.
 */
export async function getAgentPreviewUrl(
    sandboxId: string,
    env: Env,
    api?: Pick<typeof Sandbox, 'connect'>,
): Promise<string> {
    const source = env as unknown as Record<string, string | undefined>;
    const apiKey = source.SUPERSERVE_API_KEY;
    if (!apiKey) {
        throw new Error('Missing required environment variable: SUPERSERVE_API_KEY');
    }
    const baseUrl = source.SUPERSERVE_BASE_URL || undefined;

    const sandbox = await (api ?? Sandbox).connect(sandboxId, { apiKey, baseUrl });
    return sandbox.getPreviewUrl(AGENT_PORT);
}
