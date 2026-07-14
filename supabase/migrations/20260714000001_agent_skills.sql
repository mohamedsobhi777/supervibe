-- Custom agent skills: user-authored markdown instruction files injected
-- into the code-generation agent's prompts. Active skills are snapshotted
-- into agent_sessions.init_args at session creation; the sandboxed runtime
-- never reads this table.
create table public.agent_skills (
    id text primary key,
    user_id uuid not null references public.users(id) on delete cascade,
    name text not null,
    description text not null,
    content text not null,
    is_active boolean default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index agent_skills_user_name_idx on public.agent_skills (user_id, name);
create index agent_skills_user_idx on public.agent_skills (user_id);

alter table public.agent_skills enable row level security;

create policy user_rw_agent_skills on public.agent_skills
    for all using (user_id = auth.uid())
    with check (user_id = auth.uid());
