/**
 * Resolves the raw `env.PLATFORM_CAPABILITIES` value into a
 * `PlatformCapabilitiesConfig`, tolerating both runtime shapes it can
 * actually arrive in.
 *
 * Cloudflare `vars` bindings are JSON-parsed by the Workers runtime, so on
 * Workers `env.PLATFORM_CAPABILITIES` genuinely is an object at runtime (see
 * the generated `worker-configuration.d.ts`). On the Vercel Node path
 * (`api/[[...route]].ts`), `env` is built from `process.env as unknown as
 * Env` with no JSON parsing - every `process.env` value is a plain string -
 * so the very same field is a raw JSON string at runtime despite sharing the
 * `Env` type. Callers must treat the input as `unknown` (not trust the
 * static `Env` type) and normalize both shapes here so the platform
 * capabilities logic never has to know which entry path it is running on.
 */
import type { PlatformCapabilitiesConfig } from '../../../agents/core/features/types';
import { createLogger } from '../../../logger';

const logger = createLogger('resolvePlatformCapabilities');

/**
 * Fallback used whenever the raw env value is missing, malformed, or does
 * not match the expected shape. Mirrors the default `PLATFORM_CAPABILITIES`
 * value shipped in wrangler.jsonc / wrangler.staging.jsonc so the safe
 * fallback matches what the platform ships with out of the box.
 */
const DEFAULT_PLATFORM_CAPABILITIES_CONFIG: PlatformCapabilitiesConfig = {
	features: {
		app: { enabled: true },
		presentation: { enabled: false },
		general: { enabled: false },
	},
	version: '1.0.0',
};

function isPlatformCapabilitiesConfig(value: unknown): value is PlatformCapabilitiesConfig {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const { features, version } = value as Record<string, unknown>;
	if (typeof version !== 'string' || typeof features !== 'object' || features === null) {
		return false;
	}

	const featureRecord = features as Record<string, unknown>;
	const featureKeys = ['app', 'presentation', 'general'] as const;
	return featureKeys.every((key) => {
		const feature = featureRecord[key];
		return (
			typeof feature === 'object' &&
			feature !== null &&
			typeof (feature as Record<string, unknown>).enabled === 'boolean'
		);
	});
}

/**
 * @param rawCapabilities `env.PLATFORM_CAPABILITIES` as read off the env -
 * accepted as `unknown` because its static `Env` type (a pre-parsed object)
 * does not hold on the Vercel Node path, where it is a JSON string.
 */
export function resolvePlatformCapabilities(rawCapabilities: unknown): PlatformCapabilitiesConfig {
	if (typeof rawCapabilities === 'string') {
		try {
			const parsed: unknown = JSON.parse(rawCapabilities);
			if (isPlatformCapabilitiesConfig(parsed)) {
				return parsed;
			}
			logger.warn('PLATFORM_CAPABILITIES string parsed but did not match the expected shape, using defaults', {
				parsed,
			});
		} catch (error) {
			logger.warn('Failed to parse PLATFORM_CAPABILITIES as JSON, using defaults', { error });
		}
		return DEFAULT_PLATFORM_CAPABILITIES_CONFIG;
	}

	if (isPlatformCapabilitiesConfig(rawCapabilities)) {
		return rawCapabilities;
	}

	logger.warn('PLATFORM_CAPABILITIES is neither a valid config object nor a JSON string, using defaults', {
		rawCapabilities,
	});
	return DEFAULT_PLATFORM_CAPABILITIES_CONFIG;
}
