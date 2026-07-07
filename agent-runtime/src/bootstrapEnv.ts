/**
 * Environment contract for the standalone agent process.
 * Validates and returns all required and optional environment variables.
 */

export interface BootstrapEnv {
	sessionId: string;
	agentId: string;
	supabaseUrl: string;
	supabaseSessionJwt: string;
	templatesBaseUrl: string;
	workspaceDir: string;
	selfPreviewBaseUrl?: string;
	cloudflareAiGatewayUrl?: string;
	cloudflareAiGatewayToken?: string;
}

/**
 * Parses and validates environment variables for the standalone agent runtime.
 * Collects all missing required vars and throws a single error listing them all.
 *
 * @param source - Source object to read environment variables from (typically process.env)
 * @returns BootstrapEnv object with validated and mapped variables
 * @throws Error if any required environment variables are missing
 */
export function parseBootstrapEnv(source: Record<string, string | undefined>): BootstrapEnv {
	const required = [
		'SESSION_ID',
		'AGENT_ID',
		'SUPABASE_URL',
		'SUPABASE_SESSION_JWT',
		'TEMPLATES_BASE_URL',
	] as const;

	const missing: string[] = [];
	for (const key of required) {
		if (!source[key]) {
			missing.push(key);
		}
	}

	if (missing.length > 0) {
		throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
	}

	return {
		sessionId: source.SESSION_ID!,
		agentId: source.AGENT_ID!,
		supabaseUrl: source.SUPABASE_URL!,
		supabaseSessionJwt: source.SUPABASE_SESSION_JWT!,
		templatesBaseUrl: source.TEMPLATES_BASE_URL!,
		workspaceDir: source.WORKSPACE_DIR || '/workspace',
		selfPreviewBaseUrl: source.SELF_PREVIEW_BASE_URL,
		cloudflareAiGatewayUrl: source.CLOUDFLARE_AI_GATEWAY_URL,
		cloudflareAiGatewayToken: source.CLOUDFLARE_AI_GATEWAY_TOKEN,
	};
}
