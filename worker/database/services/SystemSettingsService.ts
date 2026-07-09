/**
 * System Settings Service - Database operations for system_settings.
 *
 * `system_settings` (worker/database/schema.ts) replaces the Cloudflare KV
 * `VibecoderStore` store that `worker/config/index.ts` used to read
 * platform-wide and per-user configuration overrides from
 * (`platform_configs` / `user_config:{userId}` keys). This service is the
 * read seam config/index.ts uses in its place.
 */

import { BaseService } from './BaseService';
import * as schema from '../schema';
import { eq } from 'drizzle-orm';

/**
 * Narrow check for "usable as a config override fragment": jsonb can hold
 * any JSON type (array, string, number, boolean, null), but only a plain
 * object is a meaningful partial-config value to deep-merge over defaults.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SystemSettingsService extends BaseService {
    /**
     * Look up a `system_settings` row by key and return its `value` jsonb
     * column.
     *
     * Returns `null` when the row is missing, `value` is SQL NULL, or
     * `value` is not a plain JSON object - callers (worker/config/index.ts)
     * treat `null` as "no override, use defaults". Never throws: any query
     * error is logged and treated the same as "no override" so the
     * fail-safe-to-defaults contract holds even if the database is
     * unreachable.
     */
    async getByKey(key: string): Promise<Record<string, unknown> | null> {
        try {
            const rows = await this.database
                .select({ value: schema.systemSettings.value })
                .from(schema.systemSettings)
                .where(eq(schema.systemSettings.key, key))
                .limit(1);

            const value = rows[0]?.value;
            return isPlainObject(value) ? value : null;
        } catch (error) {
            this.logger.error(`Failed to read system_settings row for key "${key}"`, error);
            return null;
        }
    }
}
