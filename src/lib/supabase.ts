/**
 * Browser Supabase client (Auth + Realtime).
 * Auth methods and Realtime channels are wired up in later tasks.
 */

import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY,
    { auth: { persistSession: true, autoRefreshToken: true } },
);
