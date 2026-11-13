-- Section 84: enforce one team per division/season and require approval for transfers
--
-- A player's first team assignment in a division is retained for the season,
-- even if the roster row is later removed. Moving to another team in that
-- division requires a pending request from the receiving team's captain and
-- an explicit League Manager decision.

create table if not exists public.player_division_team_assignments (
  player_num text not null references public.players(num) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  primary key (player_num, division_id)
);

alter table public.player_division_team_assignments enable row level security;
revoke all on public.player_division_team_assignments from anon, authenticated;

-- Backfill only unambiguous existing assignments. Existing duplicate assignments
-- are deliberately left for the manager to resolve; new duplicates are blocked.
insert into public.player_division_team_assignments (player_num, division_id, team_id)
select r.player_num, t.division_id, min(r.team_id::text)::uuid
from public.rosters r
join public.teams t on t.id = r.team_id
where t.division_id is not null
group by r.player_num, t.division_id
having count(distinct r.team_id) = 1
on conflict (player_num, division_id) do nothing;

create table if not exists public.player_transfer_requests (
  id uuid primary key default gen_random_uuid(),
  player_num text not null references public.players(num) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  from_team_id uuid not null references public.teams(id) on delete restrict,
  to_team_id uuid not null references public.teams(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (from_team_id <> to_team_id)
);

create unique index if not exists player_transfer_one_pending_per_player
  on public.player_transfer_requests(player_num)
  where status = 'pending';
create index if not exists player_transfer_requests_status_created
  on public.player_transfer_requests(status, created_at desc);

alter table public.player_transfer_requests enable row level security;
revoke all on public.player_transfer_requests from anon;
grant select on public.player_transfer_requests to authenticated;

drop policy if exists "Managers can review player transfer requests" on public.player_transfer_requests;
create policy "Managers can review player transfer requests"
  on public.player_transfer_requests
  for select to authenticated
  using (public.current_role_name() = 'manager');

-- Record a player's first team in each division and reject direct reassignment,
-- including delete-then-insert attempts and weekly-import upserts.
create or replace function public.enforce_player_division_team_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_division_id uuid;
  v_assigned_team_id uuid;
begin
  select division_id into v_division_id
  from public.teams
  where id = new.team_id;

  if v_division_id is null then
    return new;
  end if;

  insert into public.player_division_team_assignments (player_num, division_id, team_id)
  values (new.player_num, v_division_id, new.team_id)
  on conflict (player_num, division_id) do nothing;

  select team_id into v_assigned_team_id
  from public.player_division_team_assignments
  where player_num = new.player_num
    and division_id = v_division_id
  for update;

  if v_assigned_team_id <> new.team_id then
    raise exception 'PLAYER_TRANSFER_APPROVAL_REQUIRED'
      using errcode = '23514',
        detail = 'This player is already assigned to another team in this division for the season. The receiving team captain must submit a transfer request for League Manager approval.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_player_division_team_assignment() from public, anon, authenticated;
drop trigger if exists enforce_player_division_team_assignment on public.rosters;
create trigger enforce_player_division_team_assignment
before insert or update of team_id, player_num on public.rosters
for each row execute function public.enforce_player_division_team_assignment();

create or replace function public.create_player_transfer_request(
  p_player_num text,
  p_to_team_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_division_id uuid;
  v_from_team_id uuid;
  v_request_id uuid;
begin
  v_role := public.current_role_name();
  if v_role not in ('captain', 'manager') or not public.is_team_captain(p_to_team_id) then
    raise exception 'RECEIVING_TEAM_CAPTAIN_REQUIRED' using errcode = '42501';
  end if;

  select division_id into v_division_id
  from public.teams
  where id = p_to_team_id and coalesce(is_bye, false) = false;

  if v_division_id is null then
    raise exception 'INVALID_RECEIVING_TEAM';
  end if;

  if not exists (select 1 from public.players where num = p_player_num) then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  select team_id into v_from_team_id
  from public.player_division_team_assignments
  where player_num = p_player_num and division_id = v_division_id;

  -- No previous assignment in this division (or already assigned to this
  -- team): the caller should use the ordinary roster-add RPC instead.
  if v_from_team_id is null or v_from_team_id = p_to_team_id then
    return jsonb_build_object('status', 'add');
  end if;

  if exists (
    select 1 from public.player_transfer_requests
    where player_num = p_player_num and status = 'pending'
  ) then
    select id into v_request_id from public.player_transfer_requests
    where player_num = p_player_num and status = 'pending';
    return jsonb_build_object('status', 'pending', 'request_id', v_request_id);
  end if;

  insert into public.player_transfer_requests
    (player_num, division_id, from_team_id, to_team_id, requested_by)
  values
    (p_player_num, v_division_id, v_from_team_id, p_to_team_id, auth.uid())
  returning id into v_request_id;

  return jsonb_build_object('status', 'pending', 'request_id', v_request_id);
end;
$$;

revoke all on function public.create_player_transfer_request(text, uuid) from public, anon;
grant execute on function public.create_player_transfer_request(text, uuid) to authenticated;

create or replace function public.decide_player_transfer_request(
  p_request_id uuid,
  p_approve boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.player_transfer_requests%rowtype;
  v_profile_id uuid;
begin
  if public.current_role_name() <> 'manager' then
    raise exception 'MANAGER_ONLY' using errcode = '42501';
  end if;

  select * into v_request
  from public.player_transfer_requests
  where id = p_request_id
  for update;

  if not found or v_request.status <> 'pending' then
    raise exception 'TRANSFER_REQUEST_NOT_PENDING';
  end if;

  if p_approve then
    -- Update the durable assignment first so the roster trigger recognizes
    -- this exact manager-authorized destination.
    update public.player_division_team_assignments
    set team_id = v_request.to_team_id, assigned_at = now()
    where player_num = v_request.player_num
      and division_id = v_request.division_id
      and team_id = v_request.from_team_id;

    if not found then
      raise exception 'TRANSFER_ASSIGNMENT_CHANGED';
    end if;

    delete from public.rosters
    where team_id = v_request.from_team_id
      and player_num = v_request.player_num;

    insert into public.rosters(team_id, player_num)
    values (v_request.to_team_id, v_request.player_num)
    on conflict (team_id, player_num) do nothing;

    select id into v_profile_id
    from public.profiles
    where player_num = v_request.player_num
    limit 1;

    if v_profile_id is not null then
      update public.profile_team_memberships
      set ended_at = now()
      where profile_id = v_profile_id
        and team_id = v_request.from_team_id
        and ended_at is null;

      insert into public.profile_team_memberships(profile_id, team_id)
      values (v_profile_id, v_request.to_team_id)
      on conflict (profile_id, team_id) where ended_at is null do nothing;
    end if;
  end if;

  update public.player_transfer_requests
  set status = case when p_approve then 'approved' else 'declined' end,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = p_request_id;

  return true;
end;
$$;

revoke all on function public.decide_player_transfer_request(uuid, boolean) from public, anon;
grant execute on function public.decide_player_transfer_request(uuid, boolean) to authenticated;
