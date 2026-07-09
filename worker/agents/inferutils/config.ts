import {
    AgentActionKey,
    AgentConfig,
    AgentConstraintConfig,
    AIModels,
    AllModels,
    LiteModels,
    RegularModels,
} from "./config.types";
import { getRuntimeEnv } from 'worker/utils/runtimeEnv';

// Common configs - these are good defaults
const COMMON_AGENT_CONFIGS = {
    screenshotAnalysis: {
        name: AIModels.DISABLED,
        reasoning_effort: 'medium' as const,
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: AIModels.GEMINI_2_5_FLASH,
    },
    realtimeCodeFixer: {
        name: AIModels.GROK_4_1_FAST_NON_REASONING,
        reasoning_effort: 'low' as const,
        max_tokens: 32000,
        temperature: 0.2,
        fallbackModel: AIModels.GEMINI_2_5_FLASH,
    },
    fastCodeFixer: {
        name: AIModels.DISABLED,
        reasoning_effort: undefined,
        max_tokens: 64000,
        temperature: 0.0,
        fallbackModel: AIModels.GEMINI_2_5_PRO,
    },
    templateSelection: {
        name: AIModels.GEMINI_2_5_FLASH_LITE,
        max_tokens: 2000,
        fallbackModel: AIModels.GROK_4_1_FAST_NON_REASONING,
        temperature: 1,
    },
} as const;

const SHARED_IMPLEMENTATION_CONFIG = {
    reasoning_effort: 'low' as const,
    max_tokens: 48000,
    temperature: 1,
    fallbackModel: AIModels.GEMINI_2_5_PRO,
};

//======================================================================================
// ATTENTION! Platform config requires specific API keys and Cloudflare AI Gateway setup.
//======================================================================================
/* 
These are the configs used at build.cloudflare.dev 
You may need to provide API keys for these models in your environment or use 
Cloudflare AI Gateway unified billing for seamless model access without managing multiple keys.
*/
const PLATFORM_AGENT_CONFIG: AgentConfig = {
    ...COMMON_AGENT_CONFIGS,
    blueprint: {
        name: AIModels.GEMINI_3_PRO_PREVIEW,
        reasoning_effort: 'high',
        max_tokens: 20000,
        fallbackModel: AIModels.GEMINI_2_5_FLASH,
        temperature: 1.0,
    },
    projectSetup: {
        name: AIModels.GROK_4_1_FAST,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: AIModels.GEMINI_2_5_PRO,
    },
    phaseGeneration: {
        name: AIModels.GEMINI_3_FLASH_PREVIEW,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: AIModels.OPENAI_5_MINI,
    },
    firstPhaseImplementation: {
        name: AIModels.GEMINI_3_FLASH_PREVIEW,
        ...SHARED_IMPLEMENTATION_CONFIG,
    },
    phaseImplementation: {
        name: AIModels.GEMINI_3_FLASH_PREVIEW,
        ...SHARED_IMPLEMENTATION_CONFIG,
    },
    conversationalResponse: {
        name: AIModels.GROK_4_1_FAST,
        reasoning_effort: 'low',
        max_tokens: 4000,
        temperature: 1,
        fallbackModel: AIModels.GEMINI_2_5_FLASH,
    },
    deepDebugger: {
        name: AIModels.GROK_4_1_FAST,
        reasoning_effort: 'high',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: AIModels.GEMINI_2_5_PRO,
    },
    fileRegeneration: {
        name: AIModels.GROK_4_1_FAST_NON_REASONING,
        reasoning_effort: 'low',
        max_tokens: 16000,
        temperature: 0.0,
        fallbackModel: AIModels.GROK_CODE_FAST_1,
    },
    agenticProjectBuilder: {
        name: AIModels.GEMINI_3_FLASH_PREVIEW,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: AIModels.GEMINI_2_5_PRO,
    },
};

//======================================================================================
// Default OpenAI-only config (used when PLATFORM_MODEL_PROVIDERS is not set)
//======================================================================================
/*
 * Out-of-the-box config for a single OpenAI API key: gpt-5 for the heavy
 * reasoning/codegen roles, gpt-5-mini for the lighter/faster ones, with the
 * other GPT-5 tier as the fallback so a single OPENAI_API_KEY covers every call.
 * `temperature: 1` is OpenAI's default and the only value gpt-5 reasoning models
 * accept over chat completions (core.ts also drops non-default temperature for
 * OpenAI reasoning models, so tuning it here is safe for other providers too).
 * To use a different provider, point these at that provider's models (and set
 * its API key) — the direct-routing in core.ts handles google-ai-studio,
 * anthropic, openai, grok, and openrouter without a gateway.
 */
const SHARED_OPENAI_IMPLEMENTATION_CONFIG = {
    reasoning_effort: 'medium' as const,
    max_tokens: 48000,
    temperature: 1,
    fallbackModel: AIModels.OPENAI_5_MINI,
};

const DEFAULT_AGENT_CONFIG: AgentConfig = {
    ...COMMON_AGENT_CONFIGS,
    // COMMON_AGENT_CONFIGS.templateSelection points at Gemini/Grok; override to
    // OpenAI so an OpenAI-only key works end to end.
    templateSelection: {
        name: AIModels.OPENAI_5_MINI,
        max_tokens: 2000,
        temperature: 1,
        fallbackModel: AIModels.OPENAI_5,
    },
    blueprint: {
        name: AIModels.OPENAI_5,
        reasoning_effort: 'high',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: AIModels.OPENAI_5_MINI,
    },
    projectSetup: {
        name: AIModels.OPENAI_5_MINI,
        ...SHARED_OPENAI_IMPLEMENTATION_CONFIG,
    },
    phaseGeneration: {
        name: AIModels.OPENAI_5,
        ...SHARED_OPENAI_IMPLEMENTATION_CONFIG,
    },
    firstPhaseImplementation: {
        name: AIModels.OPENAI_5,
        ...SHARED_OPENAI_IMPLEMENTATION_CONFIG,
    },
    phaseImplementation: {
        name: AIModels.OPENAI_5,
        ...SHARED_OPENAI_IMPLEMENTATION_CONFIG,
    },
    conversationalResponse: {
        name: AIModels.OPENAI_5_MINI,
        reasoning_effort: 'low',
        max_tokens: 4000,
        temperature: 1,
        fallbackModel: AIModels.OPENAI_5,
    },
    deepDebugger: {
        name: AIModels.OPENAI_5,
        reasoning_effort: 'high',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: AIModels.OPENAI_5_MINI,
    },
    fileRegeneration: {
        name: AIModels.OPENAI_5_MINI,
        reasoning_effort: 'low',
        max_tokens: 32000,
        temperature: 1,
        fallbackModel: AIModels.OPENAI_5,
    },
    agenticProjectBuilder: {
        name: AIModels.OPENAI_5,
        reasoning_effort: 'medium',
        max_tokens: 8000,
        temperature: 1,
        fallbackModel: AIModels.OPENAI_5_MINI,
    },
};

// Lazily resolved so the env read happens on first access rather than at
// module-evaluation time — module-scope evaluation runs before
// `setRuntimeEnv()` is called at process bootstrap (see worker/utils/runtimeEnv.ts).
// The Proxy preserves plain-object semantics (property access, `in`,
// `Object.keys`/`Object.entries`) for the many existing call sites that treat
// AGENT_CONFIG as a static object.
function resolveAgentConfig(): AgentConfig {
    return getRuntimeEnv().PLATFORM_MODEL_PROVIDERS
        ? PLATFORM_AGENT_CONFIG
        : DEFAULT_AGENT_CONFIG;
}

export const AGENT_CONFIG: AgentConfig = new Proxy({} as AgentConfig, {
    get(_target, prop, receiver) {
        return Reflect.get(resolveAgentConfig(), prop, receiver);
    },
    has(_target, prop) {
        return Reflect.has(resolveAgentConfig(), prop);
    },
    ownKeys(_target) {
        return Reflect.ownKeys(resolveAgentConfig());
    },
    getOwnPropertyDescriptor(_target, prop) {
        return Reflect.getOwnPropertyDescriptor(resolveAgentConfig(), prop);
    },
});


export const AGENT_CONSTRAINTS: Map<AgentActionKey, AgentConstraintConfig> = new Map([
	['fastCodeFixer', {
		allowedModels: new Set([AIModels.DISABLED]),
		enabled: true,
	}],
	['realtimeCodeFixer', {
		allowedModels: new Set([AIModels.DISABLED]),
		enabled: true,
	}],
	['fileRegeneration', {
		allowedModels: new Set(AllModels),
		enabled: true,
	}],
	['phaseGeneration', {
		allowedModels: new Set(AllModels),
		enabled: true,
	}],
	['projectSetup', {
		allowedModels: new Set([...RegularModels, AIModels.GEMINI_2_5_PRO]),
		enabled: true,
	}],
	['conversationalResponse', {
		allowedModels: new Set(RegularModels),
		enabled: true,
	}],
	['templateSelection', {
		allowedModels: new Set(LiteModels),
		enabled: true,
	}],
]);