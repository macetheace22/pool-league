-- Section 110: secure, audited manager impersonation with database-enforced read-only mode.
-- The Auth custom access-token hook must be enabled for public.manager_impersonation_access_token_hook.
-- It adds signed manager impersonation claims only to the one-time target magic-link session.
-- A database trigger rejects INSERT/UPDATE/DELETE while that signed claim says read_only.

begin;

create table if not exists public.manager_impersonation_events (
  id uuid primary key default gen_random_uuid(),
  manager_profile_id uuid not null references public.profiles(id) on delete restrict,
  target_profile_id uuid not null references public.profiles(id) on delete restrict,
  impersonation_session_id uuid not null,
  mode text not null check (mode in ('read_only', 'update')),
  event_type text not null check (event_type in ('started', 'ended')),
  created_at timestamptz not null default now()
);

create index if not exists manager_impersonation_events_manager_created_idx
  on public.manager_impersonation_events (manager_profile_id, created_at desc);
create index if not exists manager_impersonation_events_session_idx
  on public.manager_impersonation_events (impersonation_session_id, created_at);

create table if not exists public.manager_impersonation_pending_sessions (
  id uuid primary key default gen_random_uuid(),
  manager_profile_id uuid not null references public.profiles(id) on delete restrict,
  target_profile_id uuid not null references public.profiles(id) on delete restrict,
  mode text not null check (mode in ('read_only', 'update')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists manager_impersonation_pending_target_idx
  on public.manager_impersonation_pending_sessions (target_profile_id, created_at desc)
  where consumed_at is null;

create table if not exists public.manager_impersonation_sessions (
  id uuid primary key default gen_random_uuid(),
  auth_session_id uuid not null unique,
  manager_profile_id uuid not null references public.profiles(id) on delete restrict,
  target_profile_id uuid not null references public.profiles(id) on delete restrict,
  mode text not null check (mode in ('read_only', 'update')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);

create index if not exists manager_impersonation_sessions_target_idx
  on public.manager_impersonation_sessions (target_profile_id, auth_session_id);

alter table public.manager_impersonation_events enable row level security;
alter table public.manager_impersonation_pending_sessions enable row level security;
alter table public.manager_impersonation_sessions enable row level security;

revoke all on public.manager_impersonation_events from public, anon, authenticated;
revoke all on public.manager_impersonation_pending_sessions from public, anon, authenticated;
revoke all on public.manager_impersonation_sessions from public, anon, authenticated;
grant all on public.manager_impersonation_events to service_role;
grant all on public.manager_impersonation_pending_sessions to service_role;
grant all on public.manager_impersonation_sessions to service_role;

-- Supabase Auth executes the hook as supabase_auth_admin. The hook itself is
-- SECURITY DEFINER and performs the narrowly-scoped pending/session updates.
grant usage on schema public to supabase_auth_admin;

create or replace function public.manager_impersonation_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;
  v_session public.manager_impersonation_sessions%rowtype;
  v_pending public.manager_impersonation_pending_sessions%rowtype;
  v_claims jsonb;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_auth_session_id := (event -> 'claims' ->> 'session_id')::uuid;
  v_claims := event -> 'claims';

  if v_user_id is null or v_auth_session_id is null then
    return jsonb_build_object('claims', v_claims);
  end if;

  -- Keep the signed impersonation claims on every token refresh. An ended or
  -- expired impersonation session must not silently become a normal target session.
  select *
    into v_session
    from public.manager_impersonation_sessions
   where auth_session_id = v_auth_session_id
     and target_profile_id = v_user_id;

  if found then
    if v_session.ended_at is not null or v_session.expires_at <= now() then
      raise exception 'This manager impersonation session has ended or expired';
    end if;
    if not exists (
      select 1 from public.profiles
       where id = v_session.manager_profile_id
         and role = 'manager'
         and is_active
    ) or not exists (
      select 1 from public.profiles
       where id = v_session.target_profile_id
         and is_active
    ) then
      raise exception 'The manager or target account is no longer active for impersonation';
    end if;
  else
    -- Only the server-issued, one-time magic-link flow may create a session.
    if event ->> 'authentication_method' is distinct from 'magiclink' then
      return jsonb_build_object('claims', v_claims);
    end if;

    with candidate as (
      select id
        from public.manager_impersonation_pending_sessions
       where target_profile_id = v_user_id
         and consumed_at is null
         and expires_at > now()
       order by created_at desc
       limit 1
       for update skip locked
    )
    update public.manager_impersonation_pending_sessions p
       set consumed_at = now()
      from candidate c
     where p.id = c.id
    returning p.* into v_pending;

    if not found then
      return jsonb_build_object('claims', v_claims);
    end if;

    if not exists (
      select 1 from public.profiles
       where id = v_pending.manager_profile_id
         and role = 'manager'
         and is_active
    ) or not exists (
      select 1 from public.profiles
       where id = v_pending.target_profile_id
         and is_active
    ) then
      raise exception 'The manager or target account is no longer active for impersonation';
    end if;

    insert into public.manager_impersonation_sessions (
      auth_session_id, manager_profile_id, target_profile_id, mode, expires_at
    ) values (
      v_auth_session_id, v_pending.manager_profile_id, v_pending.target_profile_id,
      v_pending.mode, now() + interval '8 hours'
    )
    returning * into v_session;

    insert into public.manager_impersonation_events (
      manager_profile_id, target_profile_id, impersonation_session_id, mode, event_type
    ) values (
      v_session.manager_profile_id, v_session.target_profile_id, v_session.id,
      v_session.mode, 'started'
    );
  end if;

  v_claims := jsonb_set(v_claims, '{manager_impersonator_id}', to_jsonb(v_session.manager_profile_id::text), true);
  v_claims := jsonb_set(v_claims, '{manager_impersonation_mode}', to_jsonb(v_session.mode), true);
  v_claims := jsonb_set(v_claims, '{manager_impersonation_session_id}', to_jsonb(v_session.id::text), true);

  return jsonb_build_object('claims', v_claims);
end;
$$;

revoke all on function public.manager_impersonation_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.manager_impersonation_access_token_hook(jsonb) to supabase_auth_admin;

create or replace function public.prevent_read_only_impersonation_writes()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'manager_impersonation_mode', '') = 'read_only' then
    raise exception 'This manager impersonation session is read-only'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_read_only_impersonation_writes() from public, anon, authenticated;

-- Protect every existing public table, including writes made inside SECURITY
-- DEFINER RPCs. The trigger checks the signed JWT claim, not client-side UI state.
do $$
declare
  v_table record;
begin
  for v_table in
    select c.oid::regclass as relation_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
  loop
    execute format(
      'drop trigger if exists manager_impersonation_read_only_guard on %s',
      v_table.relation_name
    );
    execute format(
      'create trigger manager_impersonation_read_only_guard before insert or update or delete on %s for each row execute function public.prevent_read_only_impersonation_writes()',
      v_table.relation_name
    );
  end loop;
end;
$$;

-- Automatically attach the guard to public tables created by future migrations.
create or replace function public.attach_manager_impersonation_guard_to_new_tables()
returns event_trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command record;
begin
  for v_command in select * from pg_event_trigger_ddl_commands() loop
    if v_command.command_tag in ('CREATE TABLE', 'CREATE ' || 'TABLE AS')
       and v_command.object_type = 'table'
       and v_command.schema_name = 'public'
       and v_command.objid is not null then
      execute format(
        'drop trigger if exists manager_impersonation_read_only_guard on %s',
        v_command.objid::regclass
      );
      execute format(
        'create trigger manager_impersonation_read_only_guard before insert or update or delete on %s for each row execute function public.prevent_read_only_impersonation_writes()',
        v_command.objid::regclass
      );
    end if;
  end loop;
end;
$;

revoke all on function public.attach_manager_impersonation_guard_to_new_tables() from public, anon, authenticated;

drop event trigger if exists manager_impersonation_attach_guard;
create event trigger manager_impersonation_attach_guard
  on ddl_command_end
  execute function public.attach_manager_impersonation_guard_to_new_tables();

commit;
