import { describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const gate = process.env.SUPABASE_LOCAL === '1' ? describe : describe.skip;

// Requires: `bunx supabase start` + `bunx supabase db reset` beforehand
// (applies both 20260707000001_agent_runtime.sql and this migration).
// Local defaults from `supabase status`:
const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';

/**
 * `public.users.id` is a foreign key into `auth.users(id)`, so rows must be
 * seeded through the GoTrue admin API rather than a raw `.from('users')
 * .insert(...)`. This also exercises `handle_new_user()` from
 * `20260708000001_core.sql`, which auto-provisions the `public.users` row
 * when Supabase Auth creates the `auth.users` row.
 */
async function seedAuthUser(admin: SupabaseClient): Promise<{ id: string; email: string }> {
    const email = `${crypto.randomUUID()}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) {
        throw new Error(`failed to seed auth user: ${error?.message ?? 'no user returned'}`);
    }
    return { id: data.user.id, email };
}

gate('core schema (users, apps) + RLS', () => {
    it('service role reads the trigger-provisioned profile and can insert/read an app', async () => {
        const admin = createClient(url, serviceKey);
        const user = await seedAuthUser(admin);

        const profile = await admin.from('users').select('*').eq('id', user.id).single();
        expect(profile.error).toBeNull();
        expect(profile.data?.email).toBe(user.email);

        const appId = `app-${user.id}`;
        const appInsert = await admin.from('apps').insert({
            id: appId,
            title: 'Core migration test app',
            original_prompt: 'build me a test app',
            user_id: user.id,
            visibility: 'private',
        });
        expect(appInsert.error).toBeNull();

        const appRead = await admin.from('apps').select('*').eq('id', appId).single();
        expect(appRead.error).toBeNull();
        expect(appRead.data?.title).toBe('Core migration test app');

        await admin.from('apps').delete().eq('id', appId);
        await admin.auth.admin.deleteUser(user.id);
    });

    it('an anon client cannot read a private app', async () => {
        const admin = createClient(url, serviceKey);
        const user = await seedAuthUser(admin);

        const appId = `app-${user.id}`;
        const insert = await admin.from('apps').insert({
            id: appId,
            title: 'Private app',
            original_prompt: 'build me a private app',
            user_id: user.id,
            visibility: 'private',
        });
        expect(insert.error).toBeNull();

        const anon = createClient(url, anonKey);
        const anonRead = await anon.from('apps').select('*').eq('id', appId);
        expect(anonRead.data ?? []).toHaveLength(0);

        await admin.from('apps').delete().eq('id', appId);
        await admin.auth.admin.deleteUser(user.id);
    });
});
