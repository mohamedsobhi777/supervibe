import { describe, expect, it } from 'bun:test';
import { parseBootstrapEnv } from '../src/bootstrapEnv';

describe('parseBootstrapEnv', () => {
	it('throws with all missing required vars when source is empty', () => {
		expect(() => {
			parseBootstrapEnv({});
		}).toThrow(/Missing required environment variables:/);

		expect(() => {
			parseBootstrapEnv({});
		}).toThrow(/SESSION_ID/);

		expect(() => {
			parseBootstrapEnv({});
		}).toThrow(/AGENT_ID/);

		expect(() => {
			parseBootstrapEnv({});
		}).toThrow(/SUPABASE_URL/);

		expect(() => {
			parseBootstrapEnv({});
		}).toThrow(/SUPABASE_ANON_KEY/);

		expect(() => {
			parseBootstrapEnv({});
		}).toThrow(/SUPABASE_SESSION_JWT/);

		expect(() => {
			parseBootstrapEnv({});
		}).toThrow(/TEMPLATES_BASE_URL/);
	});

	it('throws with only missing required vars, excluding present ones', () => {
		expect(() => {
			parseBootstrapEnv({
				SESSION_ID: 's-123',
				AGENT_ID: 'a-123',
				SUPABASE_URL: 'https://supabase.example.com',
				SUPABASE_ANON_KEY: 'anon-key-here',
			});
		}).toThrow(/SUPABASE_SESSION_JWT/);

		expect(() => {
			parseBootstrapEnv({
				SESSION_ID: 's-123',
				AGENT_ID: 'a-123',
				SUPABASE_URL: 'https://supabase.example.com',
				SUPABASE_ANON_KEY: 'anon-key-here',
			});
		}).toThrow(/TEMPLATES_BASE_URL/);
	});

	it('returns parsed object with all required vars and defaults for optional', () => {
		const result = parseBootstrapEnv({
			SESSION_ID: 's-123',
			AGENT_ID: 'a-456',
			SUPABASE_URL: 'https://supabase.example.com',
			SUPABASE_ANON_KEY: 'anon-key-here',
			SUPABASE_SESSION_JWT: 'jwt-token-here',
			TEMPLATES_BASE_URL: 'https://templates.example.com',
		});

		expect(result).toEqual({
			sessionId: 's-123',
			agentId: 'a-456',
			supabaseUrl: 'https://supabase.example.com',
			supabaseAnonKey: 'anon-key-here',
			supabaseSessionJwt: 'jwt-token-here',
			templatesBaseUrl: 'https://templates.example.com',
			workspaceDir: '/workspace',
			selfPreviewBaseUrl: undefined,
			cloudflareAiGatewayUrl: undefined,
			cloudflareAiGatewayToken: undefined,
		});
	});

	it('uses provided WORKSPACE_DIR when present', () => {
		const result = parseBootstrapEnv({
			SESSION_ID: 's-123',
			AGENT_ID: 'a-456',
			SUPABASE_URL: 'https://supabase.example.com',
			SUPABASE_ANON_KEY: 'anon-key-here',
			SUPABASE_SESSION_JWT: 'jwt-token-here',
			TEMPLATES_BASE_URL: 'https://templates.example.com',
			WORKSPACE_DIR: '/custom/workspace',
		});

		expect(result.workspaceDir).toBe('/custom/workspace');
	});

	it('includes optional vars when present', () => {
		const result = parseBootstrapEnv({
			SESSION_ID: 's-123',
			AGENT_ID: 'a-456',
			SUPABASE_URL: 'https://supabase.example.com',
			SUPABASE_ANON_KEY: 'anon-key-here',
			SUPABASE_SESSION_JWT: 'jwt-token-here',
			TEMPLATES_BASE_URL: 'https://templates.example.com',
			SELF_PREVIEW_BASE_URL: 'https://preview.example.com',
			CLOUDFLARE_AI_GATEWAY_URL: 'https://ai-gw.example.com',
			CLOUDFLARE_AI_GATEWAY_TOKEN: 'cf-token',
		});

		expect(result.selfPreviewBaseUrl).toBe('https://preview.example.com');
		expect(result.cloudflareAiGatewayUrl).toBe('https://ai-gw.example.com');
		expect(result.cloudflareAiGatewayToken).toBe('cf-token');
	});

	it('sets optional vars to undefined when absent', () => {
		const result = parseBootstrapEnv({
			SESSION_ID: 's-123',
			AGENT_ID: 'a-456',
			SUPABASE_URL: 'https://supabase.example.com',
			SUPABASE_ANON_KEY: 'anon-key-here',
			SUPABASE_SESSION_JWT: 'jwt-token-here',
			TEMPLATES_BASE_URL: 'https://templates.example.com',
		});

		expect(result.selfPreviewBaseUrl).toBeUndefined();
		expect(result.cloudflareAiGatewayUrl).toBeUndefined();
		expect(result.cloudflareAiGatewayToken).toBeUndefined();
	});

	describe('identifier charset guard', () => {
		it('rejects a SESSION_ID containing path traversal characters', () => {
			expect(() => {
				parseBootstrapEnv({
					SESSION_ID: '../../etc',
					AGENT_ID: 'a-456',
					SUPABASE_URL: 'https://supabase.example.com',
					SUPABASE_ANON_KEY: 'anon-key-here',
					SUPABASE_SESSION_JWT: 'jwt-token-here',
					TEMPLATES_BASE_URL: 'https://templates.example.com',
				});
			}).toThrow(/SESSION_ID/);
		});

		it('rejects an AGENT_ID containing a path separator', () => {
			expect(() => {
				parseBootstrapEnv({
					SESSION_ID: 's-123',
					AGENT_ID: 'a/456',
					SUPABASE_URL: 'https://supabase.example.com',
					SUPABASE_ANON_KEY: 'anon-key-here',
					SUPABASE_SESSION_JWT: 'jwt-token-here',
					TEMPLATES_BASE_URL: 'https://templates.example.com',
				});
			}).toThrow(/AGENT_ID/);
		});

		it('accepts SESSION_ID and AGENT_ID containing only letters, digits, underscores, and hyphens', () => {
			const result = parseBootstrapEnv({
				SESSION_ID: 'session_ABC-123',
				AGENT_ID: 'agent_XYZ-789',
				SUPABASE_URL: 'https://supabase.example.com',
				SUPABASE_ANON_KEY: 'anon-key-here',
				SUPABASE_SESSION_JWT: 'jwt-token-here',
				TEMPLATES_BASE_URL: 'https://templates.example.com',
			});

			expect(result.sessionId).toBe('session_ABC-123');
			expect(result.agentId).toBe('agent_XYZ-789');
		});
	});
});
