/**
 * Minimal test worker entry point.
 * Only exports Durable Objects needed for testing to avoid loading
 * problematic dependencies (like MCP SDK) that don't work in workerd test env.
 */
import { env as workerGlobalEnv } from 'cloudflare:workers';
import { setRuntimeEnv } from '../worker/utils/runtimeEnv';
setRuntimeEnv(workerGlobalEnv);

export { UserSecretsStore } from '../worker/services/secrets/UserSecretsStore';

export default {
	async fetch() {
		return new Response('Test worker');
	},
};
