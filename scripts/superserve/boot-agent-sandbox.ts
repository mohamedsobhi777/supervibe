#!/usr/bin/env node
/**
 * Boots a SuperServe sandbox from the `bun-agent-runtime` template (built by
 * build-agent-template.ts) and starts the standalone agent process
 * (agent-runtime/src/main.ts) inside it, detached, for one chat session.
 *
 * Requires a HOSTED Supabase project: the agent connects out to
 * SUPABASE_URL over the public internet (PostgREST + Realtime) to load
 * session state and stream to the client. A cloud sandbox cannot reach a
 * laptop's local Supabase instance (127.0.0.1 / localhost is not routable
 * from the sandbox's network namespace) — SUPABASE_URL must point at a
 * real hosted project (e.g. https://<ref>.supabase.co) before running
 * this script.
 *
 * Required env:
 *   SUPERSERVE_API_KEY     - SuperServe control-plane API key
 *   SESSION_ID              - chat session id (agent_sessions.session_id)
 *   AGENT_ID                - agent identifier passed to StandaloneAgent.boot
 *   SUPABASE_URL             - hosted Supabase project URL
 *   SUPABASE_ANON_KEY        - Supabase project anon key
 *   SUPABASE_SESSION_JWT     - short-lived session-scoped JWT (RLS-gated)
 *   TEMPLATES_BASE_URL       - HTTP base URL the agent fetches templates from
 * Optional env:
 *   SUPERSERVE_AGENT_TEMPLATE - template name (default: bun-agent-runtime)
 *   SUPERSERVE_BASE_URL        - SuperServe API base URL override
 *   CLOUDFLARE_AI_GATEWAY_URL   - AI Gateway URL, if routing LLM calls through it
 *   CLOUDFLARE_AI_GATEWAY_TOKEN - AI Gateway auth token
 *
 * This is a manual/staging tool: it creates a real SuperServe sandbox and
 * starts a real process inside it against the live control plane. It is
 * never run in tests or CI, and is verified by type-checking only (see
 * task-12-brief.md, Step 2).
 *
 * Example invocation:
 *   SUPERSERVE_API_KEY=ss_live_... \
 *   SESSION_ID=11111111-1111-1111-1111-111111111111 \
 *   AGENT_ID=agent-1 \
 *   SUPABASE_URL=https://xyzcompany.supabase.co \
 *   SUPABASE_ANON_KEY=eyJ... \
 *   SUPABASE_SESSION_JWT=eyJ... \
 *   TEMPLATES_BASE_URL=https://templates.example.com \
 *   bun run scripts/superserve/boot-agent-sandbox.ts
 */

import { Sandbox } from '@superserve/sdk';

const AGENT_PORT = 8080;
const START_TIMEOUT_MS = 15_000;
const LOG_TAIL_TIMEOUT_MS = 10_000;

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

interface RequiredBootEnv {
	sessionId: string;
	agentId: string;
	supabaseUrl: string;
	supabaseAnonKey: string;
	supabaseSessionJwt: string;
	templatesBaseUrl: string;
}

function readRequiredEnv(source: Record<string, string | undefined>): RequiredBootEnv {
	const required = [
		'SESSION_ID',
		'AGENT_ID',
		'SUPABASE_URL',
		'SUPABASE_ANON_KEY',
		'SUPABASE_SESSION_JWT',
		'TEMPLATES_BASE_URL',
	] as const;

	const missing = required.filter((key) => !source[key]);
	if (missing.length > 0) {
		throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
	}

	return {
		sessionId: source.SESSION_ID!,
		agentId: source.AGENT_ID!,
		supabaseUrl: source.SUPABASE_URL!,
		supabaseAnonKey: source.SUPABASE_ANON_KEY!,
		supabaseSessionJwt: source.SUPABASE_SESSION_JWT!,
		templatesBaseUrl: source.TEMPLATES_BASE_URL!,
	};
}

/** Derives the Supabase project host from SUPABASE_URL so PostgREST/Realtime egress is allowed. */
function supabaseHostFrom(supabaseUrl: string): string {
	return new URL(supabaseUrl).hostname;
}

function buildEgressAllowlist(supabaseUrl: string): string[] {
	return [...new Set([...DEFAULT_EGRESS_ALLOW, supabaseHostFrom(supabaseUrl)])];
}

async function main(): Promise<void> {
	const apiKey = process.env.SUPERSERVE_API_KEY;
	if (!apiKey) {
		console.error('SUPERSERVE_API_KEY is required to boot a SuperServe agent sandbox');
		process.exit(1);
		return;
	}

	const bootEnv = readRequiredEnv(process.env);
	const templateName = process.env.SUPERSERVE_AGENT_TEMPLATE ?? 'bun-agent-runtime';
	const baseUrl = process.env.SUPERSERVE_BASE_URL || undefined;

	const envVars: Record<string, string> = {
		SESSION_ID: bootEnv.sessionId,
		AGENT_ID: bootEnv.agentId,
		WORKSPACE_DIR: '/workspace',
		SUPABASE_URL: bootEnv.supabaseUrl,
		SUPABASE_ANON_KEY: bootEnv.supabaseAnonKey,
		SUPABASE_SESSION_JWT: bootEnv.supabaseSessionJwt,
		TEMPLATES_BASE_URL: bootEnv.templatesBaseUrl,
	};
	if (process.env.CLOUDFLARE_AI_GATEWAY_URL) {
		envVars.CLOUDFLARE_AI_GATEWAY_URL = process.env.CLOUDFLARE_AI_GATEWAY_URL;
	}
	if (process.env.CLOUDFLARE_AI_GATEWAY_TOKEN) {
		envVars.CLOUDFLARE_AI_GATEWAY_TOKEN = process.env.CLOUDFLARE_AI_GATEWAY_TOKEN;
	}

	console.log(`Creating sandbox "agent-${bootEnv.sessionId}" from template "${templateName}"`);
	const sandbox = await Sandbox.create({
		apiKey,
		baseUrl,
		name: `agent-${bootEnv.sessionId}`,
		fromTemplate: templateName,
		envVars,
		network: { allowOut: buildEgressAllowlist(bootEnv.supabaseUrl) },
		metadata: {
			vibesdk_kind: 'agent',
			vibesdk_session: bootEnv.sessionId,
		},
	});

	console.log(`Sandbox created: ${sandbox.id}`);

	// setsid/nohup detaches the agent process from this exec's process
	// group: boxd SIGKILLs the exec's process group on timeout, and the
	// agent must outlive this short-lived start command.
	const startResult = await sandbox.commands.run(
		'cd /opt/vibesdk && setsid nohup bun agent-runtime/src/main.ts > /workspace/agent.log 2>&1 < /dev/null & echo $!',
		{ timeoutMs: START_TIMEOUT_MS },
	);
	console.log(`Agent start command exited ${startResult.exitCode}; pid: ${startResult.stdout.trim()}`);

	const previewUrl = sandbox.getPreviewUrl(AGENT_PORT);
	console.log(`Sandbox id: ${sandbox.id}`);
	console.log(`Preview URL (port ${AGENT_PORT}): ${previewUrl}`);
	console.log('Following agent.log (last 50 lines):');

	const tailResult = await sandbox.commands.run('tail -n 50 /workspace/agent.log', {
		timeoutMs: LOG_TAIL_TIMEOUT_MS,
	});
	console.log(tailResult.stdout);
	if (tailResult.stderr) {
		console.error(tailResult.stderr);
	}
	console.log(
		`To keep following logs: superserve sandbox exec ${sandbox.id} -- tail -f /workspace/agent.log`,
	);
}

main().catch((error: unknown) => {
	console.error('Agent sandbox boot failed:', error);
	process.exit(1);
});
