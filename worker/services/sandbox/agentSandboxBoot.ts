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
import { unzipSync } from 'fflate';

const AGENT_PORT = 8080;
const START_TIMEOUT_MS = 15_000;

/**
 * Default sandbox inactivity timeout: generous enough that an in-progress
 * generation or an open preview tab survives normal idle gaps, but bounded
 * so an abandoned chat session's sandbox does not run (and bill) forever -
 * `Sandbox.create` had no `timeoutSeconds` set at all before this, so
 * nothing ever reclaimed a forgotten sandbox. This ties into the
 * option-(c) "preview is sandbox-scoped" limitation: once this timeout
 * elapses, `getAgentPreviewUrl`'s `Sandbox.connect` auto-resumes a paused
 * sandbox, but a fully reclaimed one is gone for good.
 */
const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 60 * 60 * 4;

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

/**
 * Resolves the sandbox inactivity timeout from an optional
 * `SUPERSERVE_SANDBOX_TIMEOUT_SECONDS` override, falling back to
 * `DEFAULT_SANDBOX_TIMEOUT_SECONDS` when it is unset or not a valid
 * positive number.
 */
function resolveSandboxTimeoutSeconds(source: Record<string, string | undefined>): number {
    const raw = source.SUPERSERVE_SANDBOX_TIMEOUT_SECONDS;
    if (!raw) return DEFAULT_SANDBOX_TIMEOUT_SECONDS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SANDBOX_TIMEOUT_SECONDS;
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
        timeoutSeconds: resolveSandboxTimeoutSeconds(source),
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

/**
 * Extracts the generated project's `.git` directory from a Superserve
 * sandbox as `{ path, data }` byte pairs, matching the path contract
 * `SqliteFS.exportGitObjects()` (worker/agents/git/fs-adapter.ts) produced
 * from the retired Durable Object SQLite git filesystem: every path is
 * relative and `.git`-prefixed (`.git/HEAD`, `.git/objects/ab/cdef...`,
 * `.git/refs/heads/main`, `.git/packed-refs`, ...), with directory entries
 * excluded. Callers that used to destructure `hasCommits` off the DO RPC's
 * result can derive it as `gitObjects.length > 0`, exactly as
 * codingAgent.ts's `exportGitObjects()` did.
 *
 * `sandbox.files.downloadDir` returns a ZIP whose entries are prefixed with
 * the downloaded directory's own base name - for `/workspace/.git` that
 * base name is `.git`, so the zip's entry paths already line up with the
 * retired DO export's paths with no rewriting needed. Directory entries
 * (fflate represents these as a trailing-slash key with no bytes) are
 * dropped, mirroring `exportGitObjects()`'s `is_dir = 0` filter.
 *
 * Propagates failures as-is (sandbox unreachable, `.git` missing, etc.) -
 * exactly as the retired `agentStub.exportGitObjects()` RPC could throw -
 * so callers keep handling failure the same way they already did.
 */
export async function extractSandboxGitObjects(
    sandboxId: string,
    env: Env,
    api?: Pick<typeof Sandbox, 'connect'>,
): Promise<Array<{ path: string; data: Uint8Array }>> {
    const source = env as unknown as Record<string, string | undefined>;
    const apiKey = source.SUPERSERVE_API_KEY;
    if (!apiKey) {
        throw new Error('Missing required environment variable: SUPERSERVE_API_KEY');
    }
    const baseUrl = source.SUPERSERVE_BASE_URL || undefined;

    const sandbox = await (api ?? Sandbox).connect(sandboxId, { apiKey, baseUrl });
    const zipBytes = await sandbox.files.downloadDir('/workspace/.git');
    const unzipped = unzipSync(zipBytes);

    return Object.entries(unzipped)
        .filter(([path]) => !path.endsWith('/'))
        .map(([path, data]) => ({ path, data }));
}
