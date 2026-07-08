-- supabase/migrations/20260708000001_core.sql
--
-- Core application schema (7 tables) mirroring worker/database/schema.ts
-- (drizzle-orm/pg-core, post Phase-2a Task 2) column-for-column. Additive
-- only: coexists with the Phase-1 agent_* tables in
-- 20260707000001_agent_runtime.sql, which this migration does not touch.
--
-- `users` is a profile extension of Supabase `auth.users` — Supabase Auth
-- owns identity/credentials; `handle_new_user()` below auto-provisions the
-- matching public.users row on signup.

create table public.users (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null unique,
    display_name text,
    username text unique,
    avatar_url text,
    provider text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_active_at timestamptz
);

create table public.apps (
    id text primary key,
    title text not null,
    description text,
    icon_url text,
    original_prompt text not null,
    final_prompt text,
    framework text,
    user_id uuid references public.users(id) on delete cascade,
    session_token text,
    visibility text not null default 'private',
    status text not null default 'generating',
    deployment_id text,
    github_repository_url text,
    github_repository_visibility text,
    is_archived boolean default false,
    is_featured boolean default false,
    version integer default 1,
    parent_app_id text,
    screenshot_url text,
    screenshot_captured_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_deployed_at timestamptz
);

create index apps_user_idx on public.apps (user_id);
create index apps_status_idx on public.apps (status);
create index apps_visibility_idx on public.apps (visibility);
create index apps_framework_idx on public.apps (framework);
create index apps_created_at_idx on public.apps (created_at);
create index apps_parent_app_idx on public.apps (parent_app_id);

create table public.user_model_configs (
    id text primary key,
    user_id uuid not null references public.users(id) on delete cascade,
    agent_action_name text not null,
    model_name text,
    max_tokens integer,
    temperature double precision,
    reasoning_effort text,
    provider_override text,
    fallback_model text,
    is_active boolean default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index user_model_configs_user_agent_idx on public.user_model_configs (user_id, agent_action_name);
create index user_model_configs_user_idx on public.user_model_configs (user_id);

create table public.user_model_providers (
    id text primary key,
    user_id uuid not null references public.users(id) on delete cascade,
    name text not null,
    base_url text not null,
    api_key_encrypted text,
    is_active boolean default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index user_model_providers_user_name_idx on public.user_model_providers (user_id, name);
create index user_model_providers_user_idx on public.user_model_providers (user_id);

-- Ciphertext/nonces are opaque bytea; the app-layer XChaCha20-Poly1305
-- crypto (client-derived keys, server never sees plaintext) lives in
-- worker/services/secrets/ and is unchanged by this migration.
create table public.user_secrets (
    id text primary key,
    user_id uuid not null references public.users(id) on delete cascade,
    secret_type text not null,
    encrypted_name bytea not null,
    name_nonce bytea not null,
    encrypted_value bytea not null,
    value_nonce bytea not null,
    metadata jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index user_secrets_user_idx on public.user_secrets (user_id);

-- Postgres replacement for the Durable-Object sliding-window rate limiter.
-- One row per (key, bucket_timestamp); increments use
-- INSERT ... ON CONFLICT (key, bucket_timestamp) DO UPDATE, backed by the
-- unique index below. Service-role only — no owning user, no anon policy.
create table public.rate_limit_buckets (
    id bigserial primary key,
    key text not null,
    bucket_timestamp bigint not null,
    count integer not null default 0,
    created_at timestamptz not null default now()
);

create unique index rate_limit_buckets_key_bucket_idx on public.rate_limit_buckets (key, bucket_timestamp);
create index rate_limit_buckets_key_bucket_desc_idx on public.rate_limit_buckets (key, bucket_timestamp desc);
create index rate_limit_buckets_created_at_idx on public.rate_limit_buckets (created_at);

-- Global system configuration (replaces the KV CONFIG_KEY store).
-- Service-role only — no owning user, no anon policy.
create table public.system_settings (
    id text primary key,
    key text not null unique,
    value jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.users enable row level security;
alter table public.apps enable row level security;
alter table public.user_model_configs enable row level security;
alter table public.user_model_providers enable row level security;
alter table public.user_secrets enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.system_settings enable row level security;

-- Users manage their own profile row only.
create policy user_rw_users on public.users
    for all using (id = auth.uid())
    with check (id = auth.uid());

-- Owners have full read/write on their own apps; visibility = 'public'
-- rows are additionally readable by anyone (including anon) via the
-- second, permissive policy below (Postgres OR-combines permissive
-- policies for the same command).
create policy user_rw_apps on public.apps
    for all using (user_id = auth.uid())
    with check (user_id = auth.uid());

create policy apps_public_read on public.apps
    for select using (visibility = 'public');

create policy user_rw_user_model_configs on public.user_model_configs
    for all using (user_id = auth.uid())
    with check (user_id = auth.uid());

create policy user_rw_user_model_providers on public.user_model_providers
    for all using (user_id = auth.uid())
    with check (user_id = auth.uid());

create policy user_rw_user_secrets on public.user_secrets
    for all using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- rate_limit_buckets and system_settings intentionally get zero policies:
-- RLS is enabled with no grant, so anon/authenticated have no access at
-- all; the service role bypasses RLS (Supabase's service_role Postgres
-- role has BYPASSRLS), which is how the API reads/writes them.

-- Auto-provision a public.users profile row whenever Supabase Auth creates
-- a new auth.users row (email/OAuth/magic-link signup). security definer
-- so the trigger can write to public.users under the definer's privileges
-- regardless of which role performed the auth.users insert; search_path is
-- pinned to prevent search_path hijacking of a definer-privileged function.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.users (id, email, display_name, avatar_url, provider)
    values (
        new.id,
        new.email,
        new.raw_user_meta_data ->> 'full_name',
        new.raw_user_meta_data ->> 'avatar_url',
        new.raw_app_meta_data ->> 'provider'
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
