/**
 * Agent State Service - Database operations for agent_state.
 *
 * `agent_state` (supabase/migrations/20260707000001_agent_runtime.sql) holds
 * the agent runtime's full `AgentState` JSON blob (query, generatedFilesMap,
 * ...), written by the standalone agent runtime (agent-runtime/) via
 * supabase-js under RLS (a session-scoped JWT's `session_id` claim grants
 * access to exactly that session's row). This service is the Drizzle-side
 * read path used on the service-role Postgres connection (bypasses RLS by
 * design - see the migration's policy comments), replacing the Durable
 * Object RPC (`getAgentStubLightweight(...).getSummary()`) that
 * `AppViewController.getAppDetails` used to call, which has no equivalent
 * on this runtime.
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq } from 'drizzle-orm';
import type { AgentStateJson } from '../schema';

export class AgentStateService extends BaseService {
    /**
     * Look up the agent runtime's persisted state for a session.
     *
     * Returns `null` when the row is missing (no state written yet) or on
     * any query error. Never throws: mirrors `SystemSettingsService`'s
     * fail-safe read contract so callers (`AppViewController.getAppDetails`)
     * can degrade to an empty agent summary instead of a 500.
     */
    async getAgentState(sessionId: string): Promise<AgentStateJson | null> {
        try {
            const rows = await this.database
                .select({ state: schema.agentState.state })
                .from(schema.agentState)
                .where(eq(schema.agentState.sessionId, sessionId))
                .limit(1);

            return rows[0]?.state ?? null;
        } catch (error) {
            this.logger.error(`Failed to read agent_state row for session "${sessionId}"`, error);
            return null;
        }
    }
}
