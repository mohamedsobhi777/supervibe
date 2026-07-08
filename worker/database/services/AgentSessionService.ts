/**
 * Agent Session Service - Database operations for agent_sessions.
 *
 * `agent_sessions` (supabase/migrations/20260707000001_agent_runtime.sql)
 * backs the standalone agent runtime (agent-runtime/), which writes it via
 * supabase-js under RLS (a session-scoped JWT's `session_id` claim grants
 * access to exactly that session's row). This service is the Drizzle-side
 * counterpart used on the service-role Postgres connection, which bypasses
 * RLS by design (see the migration's policy comments), to provision and
 * look up sessions server-side.
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq } from 'drizzle-orm';
import type { AgentSession } from '../schema';

export class AgentSessionService extends BaseService {

    /**
     * Create a new agent session row in "provisioning" status.
     */
    async createAgentSession(input: {
        sessionId: string;
        agentId: string;
        userId?: string | null;
        initArgs?: Record<string, unknown>;
    }): Promise<AgentSession> {
        const [session] = await this.database
            .insert(schema.agentSessions)
            .values({
                sessionId: input.sessionId,
                agentId: input.agentId,
                userId: input.userId ?? null,
                status: 'provisioning',
                initArgs: input.initArgs ?? null,
            })
            .returning();
        return session;
    }

    /**
     * Look up an agent session by its session ID.
     */
    async getAgentSession(sessionId: string): Promise<AgentSession | null> {
        const rows = await this.database
            .select()
            .from(schema.agentSessions)
            .where(eq(schema.agentSessions.sessionId, sessionId))
            .limit(1);
        return rows[0] ?? null;
    }

    /**
     * Record the sandbox instance backing a session once provisioned.
     */
    async updateSandboxId(sessionId: string, sandboxId: string): Promise<void> {
        await this.database
            .update(schema.agentSessions)
            .set({ sandboxId })
            .where(eq(schema.agentSessions.sessionId, sessionId));
    }
}
