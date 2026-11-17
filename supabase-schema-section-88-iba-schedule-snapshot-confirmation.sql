-- Section 88: persist independent IBA schedule snapshot checks
--
-- A candidate schedule is not considered confirmed until two distinct,
-- consecutive, valid retrievals of the same division produce the same
-- canonical snapshot fingerprint. Invalid retrievals reset the sequence.
-- This migration records confirmation evidence only; it does not apply
-- schedule changes or create manager notifications.

create table if not exists public.iba_schedule_snapshot_check_history (
  id uuid primary key default gen_random_uuid(),
  division_id uuid not null references public.divisions(id) on delete cascade,
  retrieval_id uuid not null,
  snapshot_fingerprint text,
  is_valid boolean not null,
  retrieved_by uuid references public.profiles(id) on delete set null default auth.uid(),
  retrieved_at timestamptz not null default now(),
  constraint iba_schedule_snapshot_check_history_retrieval_unique
    unique (division_id, retrieval_id),
  constraint iba_schedule_snapshot_check_history_valid_fingerprint
    check ((is_valid and snapshot_fingerprint is not null and length(snapshot_fingerprint) > 0)
      or (not is_valid and snapshot_fingerprint is null))
);

create index if not exists iba_schedule_snapshot_check_history_division_time_idx
  on public.iba_schedule_snapshot_check_history (division_id, retrieved_at desc);

create table if not exists public.iba_schedule_snapshot_confirmation_state (
  division_id uuid primary key references public.divisions(id) on delete cascade,
  snapshot_fingerprint text,
  consecutive_valid_matches integer not null default 0 check (consecutive_valid_matches >= 0),
  last_retrieval_id uuid,
  last_checked_at timestamptz,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint iba_schedule_snapshot_confirmation_state_shape
    check (
      (consecutive_valid_matches = 0 and snapshot_fingerprint is null and confirmed_at is null)
      or (consecutive_valid_matches = 1 and snapshot_fingerprint is not null and confirmed_at is null)
      or (consecutive_valid_matches >= 2 and snapshot_fingerprint is not null and confirmed_at is not null)
    )
);

alter table public.iba_schedule_snapshot_check_history enable row level security;
alter table public.iba_schedule_snapshot_confirmation_state enable row level security;

drop policy if exists "Managers can read IBA schedule snapshot check history"
  on public.iba_schedule_snapshot_check_history;
create policy "Managers can read IBA schedule snapshot check history"
  on public.iba_schedule_snapshot_check_history for select to authenticated
  using (public.current_role_name() = 'manager');

drop policy if exists "Managers can read IBA schedule snapshot confirmation state"
  on public.iba_schedule_snapshot_confirmation_state;
create policy "Managers can read IBA schedule snapshot confirmation state"
  on public.iba_schedule_snapshot_confirmation_state for select to authenticated
  using (public.current_role_name() = 'manager');

revoke all on public.iba_schedule_snapshot_check_history from public, anon;
revoke all on public.iba_schedule_snapshot_confirmation_state from public, anon;
grant select on public.iba_schedule_snapshot_check_history to authenticated;
grant select on public.iba_schedule_snapshot_confirmation_state to authenticated;

create or replace function public.record_iba_schedule_snapshot_check(
  p_division_id uuid,
  p_retrieval_id uuid,
  p_snapshot_fingerprint text,
  p_is_valid boolean
)
returns table (
  consecutive_valid_matches integer,
  confirmed boolean,
  duplicate_retrieval boolean,
  last_checked_at timestamptz
)
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_existing public.iba_schedule_snapshot_confirmation_state%rowtype;
  v_now timestamptz := now();
  v_inserted integer;
  v_count integer;
  v_confirmed_at timestamptz;
begin
  if public.current_role_name() is distinct from 'manager' then
    raise exception 'MANAGER_ONLY';
  end if;
  if p_division_id is null or p_retrieval_id is null then
    raise exception 'DIVISION_AND_RETRIEVAL_REQUIRED';
  end if;
  if p_is_valid and (p_snapshot_fingerprint is null or length(p_snapshot_fingerprint) = 0) then
    raise exception 'VALID_SNAPSHOT_REQUIRES_FINGERPRINT';
  end if;
  if not p_is_valid and p_snapshot_fingerprint is not null then
    raise exception 'INVALID_SNAPSHOT_MUST_NOT_HAVE_FINGERPRINT';
  end if;

  -- Serialize concurrent checks for the same division, including the first
  -- check when no state row exists yet.
  perform pg_advisory_xact_lock(hashtextextended(p_division_id::text, 0));

  insert into public.iba_schedule_snapshot_check_history
    (division_id, retrieval_id, snapshot_fingerprint, is_valid, retrieved_by, retrieved_at)
  values
    (p_division_id, p_retrieval_id, p_snapshot_fingerprint, p_is_valid, auth.uid(), v_now)
  on conflict (division_id, retrieval_id) do nothing;

  get diagnostics v_inserted = row_count;

  select * into v_existing
  from public.iba_schedule_snapshot_confirmation_state
  where division_id = p_division_id
  for update;

  if v_inserted = 0 then
    return query
      select coalesce(v_existing.consecutive_valid_matches, 0),
             coalesce(v_existing.consecutive_valid_matches, 0) >= 2,
             true,
             v_existing.last_checked_at;
    return;
  end if;

  if not p_is_valid then
    insert into public.iba_schedule_snapshot_confirmation_state
      (division_id, snapshot_fingerprint, consecutive_valid_matches, last_retrieval_id,
       last_checked_at, confirmed_at, updated_at)
    values (p_division_id, null, 0, p_retrieval_id, v_now, null, v_now)
    on conflict (division_id) do update set
      snapshot_fingerprint = null,
      consecutive_valid_matches = 0,
      last_retrieval_id = excluded.last_retrieval_id,
      last_checked_at = excluded.last_checked_at,
      confirmed_at = null,
      updated_at = excluded.updated_at;
  else
    if v_existing.division_id is null or v_existing.snapshot_fingerprint is distinct from p_snapshot_fingerprint then
      v_count := 1;
      v_confirmed_at := null;
    else
      v_count := v_existing.consecutive_valid_matches + 1;
      v_confirmed_at := case when v_count >= 2 then coalesce(v_existing.confirmed_at, v_now) else null end;
    end if;

    insert into public.iba_schedule_snapshot_confirmation_state
      (division_id, snapshot_fingerprint, consecutive_valid_matches, last_retrieval_id,
       last_checked_at, confirmed_at, updated_at)
    values (p_division_id, p_snapshot_fingerprint, v_count, p_retrieval_id,
            v_now, v_confirmed_at, v_now)
    on conflict (division_id) do update set
      snapshot_fingerprint = excluded.snapshot_fingerprint,
      consecutive_valid_matches = excluded.consecutive_valid_matches,
      last_retrieval_id = excluded.last_retrieval_id,
      last_checked_at = excluded.last_checked_at,
      confirmed_at = excluded.confirmed_at,
      updated_at = excluded.updated_at;
  end if;

  return query
    select s.consecutive_valid_matches,
           s.consecutive_valid_matches >= 2,
           false,
           s.last_checked_at
    from public.iba_schedule_snapshot_confirmation_state s
    where s.division_id = p_division_id;
end;
$function$;

revoke all on function public.record_iba_schedule_snapshot_check(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.record_iba_schedule_snapshot_check(uuid, uuid, text, boolean) to authenticated;

-- Read-only verification after applying:
-- select to_regclass('public.iba_schedule_snapshot_check_history') is not null as history_exists,
--        to_regclass('public.iba_schedule_snapshot_confirmation_state') is not null as state_exists,
--        to_regprocedure('public.record_iba_schedule_snapshot_check(uuid,uuid,text,boolean)') is not null as rpc_exists;
