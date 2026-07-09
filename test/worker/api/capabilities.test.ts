import { describe, expect, it } from 'bun:test';
import { createApp } from 'worker/app';
import type { PlatformCapabilities, FeatureDefinition } from 'worker/agents/core/features/types';

/**
 * Proves GET /api/capabilities tolerates `PLATFORM_CAPABILITIES` being a JSON
 * string, not just an object. `worker-configuration.d.ts` types
 * `env.PLATFORM_CAPABILITIES` as a pre-parsed object (Cloudflare `vars`
 * bindings arrive JSON-parsed by the runtime), but on the Vercel Node path
 * (`api/[[...route]].ts`) `env` is built from `process.env as unknown as Env`
 * with no JSON parsing, so the same field is a raw string at runtime -
 * dereferencing it as an object (`config.features.app.enabled`) throws and
 * the route 500s. Runs via `bun test` (see vercelHandler.test.ts for why
 * this suite uses the `bun:test` import) to exercise the exact fake-env
 * shape the Vercel path actually produces.
 */
const baseFakeEnv = {
	ENVIRONMENT: 'test',
	CUSTOM_DOMAIN: 'localhost',
};

/**
 * Hono's `c.env` / `c.executionCtx` for a given request come from whatever is
 * passed to `.request()`/`.fetch()` at call time, not from the `env` closed
 * over by `createApp()`. `adaptController` (worker/api/honoAdapter.ts)
 * unconditionally reads `c.executionCtx`, so - exactly like the real Vercel
 * entrypoint (`api/[[...route]].ts`) - a fake ExecutionContext must be
 * supplied or every controller-backed route throws "This context has no
 * ExecutionContext" before it ever reaches the capabilities logic.
 */
const fakeExecutionContext: ExecutionContext = {
	waitUntil(): void {},
	passThroughOnException(): void {},
	props: undefined,
};

interface CapabilitiesResponseBody {
	success: boolean;
	data: PlatformCapabilities;
}

function findFeature(body: CapabilitiesResponseBody, id: string): FeatureDefinition {
	const feature = body.data.features.find((f) => f.id === id);
	if (!feature) {
		throw new Error(`Expected feature "${id}" in response, got: ${JSON.stringify(body.data.features)}`);
	}
	return feature;
}

describe('GET /api/capabilities with a string-typed PLATFORM_CAPABILITIES env (Vercel/Node)', () => {
	it('parses a JSON-string PLATFORM_CAPABILITIES and returns 200', async () => {
		const fakeEnv = {
			...baseFakeEnv,
			PLATFORM_CAPABILITIES: JSON.stringify({
				features: {
					app: { enabled: true },
					presentation: { enabled: true },
					general: { enabled: false },
				},
				version: '2.0.0',
			}),
		} as unknown as Env;

		const res = await createApp(fakeEnv).request('/api/capabilities', undefined, fakeEnv, fakeExecutionContext);

		expect(res.status).toBe(200);
		const body = (await res.json()) as CapabilitiesResponseBody;
		expect(body.success).toBe(true);
		expect(body.data.version).toBe('2.0.0');
		expect(findFeature(body, 'app').enabled).toBe(true);
		expect(findFeature(body, 'presentation').enabled).toBe(true);
		expect(findFeature(body, 'general').enabled).toBe(false);
	});

	it('still returns 200 when PLATFORM_CAPABILITIES is already an object (Workers shape unchanged)', async () => {
		const fakeEnv = {
			...baseFakeEnv,
			PLATFORM_CAPABILITIES: {
				features: {
					app: { enabled: true },
					presentation: { enabled: false },
					general: { enabled: false },
				},
				version: '1.0.0',
			},
		} as unknown as Env;

		const res = await createApp(fakeEnv).request('/api/capabilities', undefined, fakeEnv, fakeExecutionContext);

		expect(res.status).toBe(200);
		const body = (await res.json()) as CapabilitiesResponseBody;
		expect(body.data.version).toBe('1.0.0');
		expect(findFeature(body, 'app').enabled).toBe(true);
		expect(findFeature(body, 'presentation').enabled).toBe(false);
	});

	it('falls back to default capabilities on a malformed PLATFORM_CAPABILITIES string instead of throwing', async () => {
		const fakeEnv = {
			...baseFakeEnv,
			PLATFORM_CAPABILITIES: '{not valid json',
		} as unknown as Env;

		const res = await createApp(fakeEnv).request('/api/capabilities', undefined, fakeEnv, fakeExecutionContext);

		expect(res.status).toBe(200);
		const body = (await res.json()) as CapabilitiesResponseBody;
		expect(body.success).toBe(true);
		expect(Array.isArray(body.data.features)).toBe(true);
		expect(typeof body.data.version).toBe('string');
	});
});
