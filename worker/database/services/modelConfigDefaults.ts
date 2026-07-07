/**
 * D1-free construction of the `agents` display list and `defaultConfigs`
 * record used by `ModelConfigsInfoMessage` (worker/api/websocketTypes.ts).
 *
 * Extracted from `ModelConfigService.getModelConfigsInfo` so the standalone
 * agent runtime can produce the same shape without a userId or a database:
 * `agents`/`defaultConfigs` are derived purely from `AGENT_CONFIG` and
 * `AGENT_CONSTRAINTS`, which never depend on user data.
 */
import { AgentActionKey, ModelConfig } from '../../agents/inferutils/config.types';
import { AGENT_CONFIG, AGENT_CONSTRAINTS } from '../../agents/inferutils/config';
import type { ModelConfigsInfo } from '../../api/websocketTypes';

export function buildAgentDisplayConfigs(): ModelConfigsInfo['agents'] {
    return Object.entries(AGENT_CONFIG).map(([key, config]) => {
        const constraint = AGENT_CONSTRAINTS.get(key as AgentActionKey);
        return {
            key,
            name: config.name,
            description: config.description,
            constraint: constraint ? {
                enabled: constraint.enabled,
                allowedModels: Array.from(constraint.allowedModels)
            } : undefined
        };
    });
}

export function buildDefaultModelConfigs(): Record<string, ModelConfig> {
    const defaultConfigs: Record<string, ModelConfig> = {};
    for (const actionKey of Object.keys(AGENT_CONFIG)) {
        defaultConfigs[actionKey] = AGENT_CONFIG[actionKey as AgentActionKey];
    }
    return defaultConfigs;
}

/**
 * `agents` + `defaultConfigs` derived purely from `AGENT_CONFIG`, with an
 * empty `userConfigs` record. Used as the standalone-runtime response for
 * `getModelConfigsInfo()` (no D1, no userId required) and matches the shape
 * `ModelConfigService.getModelConfigsInfo` returns for a user with zero
 * overrides.
 */
export function buildDefaultModelConfigsInfo(): ModelConfigsInfo {
    return {
        agents: buildAgentDisplayConfigs(),
        userConfigs: {},
        defaultConfigs: buildDefaultModelConfigs(),
    };
}
