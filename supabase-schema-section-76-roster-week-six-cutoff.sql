-- Section 76: enforce the week-six team-roster cutoff
--
-- Captains may add/remove players through the end of their division's Week 5.
-- Starting on the scheduled Week 6 date, roster changes are manager-only.
-- The database RPCs enforce this rule so direct API calls cannot bypass the UI.

create or replace function public.assert_team_roster_change_allowed(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_division_id uuid;
  v_week_six_date date;
begin
  v_role := current_role_name();
  if v_role is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if not exists (select 1 from public.teams where id = p_team_id) then
    raise exception 'TEAM_NOT_FOUND';
  end if;

  if v_role = 'manager' then
    return;
  end if;

  if v_role <> 'captain' or not is_team_captain(p_team_id) then
    raise exception 'TEAM_ACCESS_DENIED' using errcode = '42501';
  end if;

  select division_id into v_division_id
  from public.teams
  where id = p_team_id;

  select to_date(trim(sw.date), 'FMMM/FMDD/YYYY')
    into v_week_six_date
  from public.schedule_weeks sw
  where sw.division_id = v_division_id
    and sw.week_num = 6
    and trim(sw.date) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
  order by sw.created_at desc
  limit 1;

  -- If the division has not yet received a Week 6 schedule row, the
  -- scheduled cutoff is not yet knowable; normal pre-season roster work
  -- remains available until that schedule is published.
  if v_week_six_date is not null and current_date >= v_week_six_date then
    raise exception 'ROSTER_CHANGES_MANAGER_ONLY: Week 6 begins on %', v_week_six_date
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_team_roster_change_allowed(uuid) from public, anon, authenticated;

create or replace function public.can_captain_change_roster(p_team_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_division_id uuid;
  v_week_six_date date;
begin
  v_role := current_role_name();
  if v_role is null then return false; end if;
  if v_role = 'manager' then return true; end if;
  if v_role <> 'captain' or not is_team_captain(p_team_id) then return false; end if;

  select division_id into v_division_id
  from public.teams
  where id = p_team_id;

  if v_division_id is null then return false; end if;

  select to_date(trim(sw.date), 'FMMM/FMDD/YYYY')
    into v_week_six_date
  from public.schedule_weeks sw
  where sw.division_id = v_division_id
    and sw.week_num = 6
    and trim(sw.date) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
  order by sw.created_at desc
  limit 1;

  return v_week_six_date is null or current_date < v_week_six_date;
end;
$$;

revoke all on function public.can_captain_change_roster(uuid) from public, anon;
grant execute on function public.can_captain_change_roster(uuid) to authenticated;

create or replace function public.add_new_player_to_team(
  p_team_id uuid,
  p_player_num text,
  p_name text,
  p_nickname text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_team_roster_change_allowed(p_team_id);

  if nullif(trim(p_player_num), '') is null or nullif(trim(p_name), '') is null then
    raise exception 'PLAYER_NAME_AND_NUMBER_REQUIRED';
  end if;

  insert into public.players(num, name, nickname)
  values (p_player_num, trim(p_name), nullif(trim(p_nickname), ''));

  insert into public.rosters(team_id, player_num)
  values (p_team_id, p_player_num)
  on conflict (team_id, player_num) do nothing;

  return true;
end;
$$;

revoke all on function public.add_new_player_to_team(uuid, text, text, text) from public, anon;
grant execute on function public.add_new_player_to_team(uuid, text, text, text) to authenticated;

create or replace function public.add_player_to_team(p_team_id uuid, p_player_num text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  perform public.assert_team_roster_change_allowed(p_team_id);

  if not exists (select 1 from public.players where num = p_player_num) then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  insert into public.rosters(team_id, player_num)
  values (p_team_id, p_player_num)
  on conflict (team_id, player_num) do nothing;

  select id into v_profile_id
  from public.profiles
  where player_num = p_player_num;

  if v_profile_id is not null then
    insert into public.profile_team_memberships(profile_id, team_id)
    values (v_profile_id, p_team_id)
    on conflict (profile_id, team_id) where ended_at is null do nothing;
  end if;

  return true;
end;
$$;

create or replace function public.remove_player_from_team(p_team_id uuid, p_player_num text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_is_captain boolean;
begin
  perform public.assert_team_roster_change_allowed(p_team_id);

  select p.id into v_profile_id
  from public.profiles p
  where p.player_num = p_player_num;

  delete from public.rosters
  where team_id = p_team_id
    and player_num = p_player_num;

  update public.profile_team_memberships
  set ended_at = now()
  where team_id = p_team_id
    and profile_id = v_profile_id
    and ended_at is null;

  if v_profile_id is not null then
    select exists (
      select 1 from public.teams where captain_profile_id = v_profile_id
    ) into v_is_captain;

    if exists (
      select 1 from public.teams
      where id = p_team_id and captain_profile_id = v_profile_id
    ) then
      update public.teams
      set captain_profile_id = null
      where id = p_team_id and captain_profile_id = v_profile_id;

      update public.captaincy_history
      set ended_at = now()
      where team_id = p_team_id
        and profile_id = v_profile_id
        and ended_at is null;

      v_is_captain := exists (
        select 1 from public.teams where captain_profile_id = v_profile_id
      );
    end if;

    if not v_is_captain then
      update public.profiles
      set role = 'player'
      where id = v_profile_id and role = 'captain';
    end if;
  end if;

  return true;
end;
$$;

-- Existing roster RPCs remain authenticated entry points; their bodies now
-- call the private authorization/cutoff helper before touching roster data.
grant execute on function public.add_player_to_team(uuid, text) to authenticated;
grant execute on function public.remove_player_from_team(uuid, text) to authenticated;


-- Enforce the same rule for direct table writes as well as RPC calls. RLS
-- remains responsible for deciding which team a captain may access; this
-- trigger adds the scheduled Week 6 cutoff to every roster insert/update/delete.
create or replace function public.enforce_roster_change_cutoff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.assert_team_roster_change_allowed(old.team_id);
    return old;
  elsif tg_op = 'UPDATE' then
    perform public.assert_team_roster_change_allowed(old.team_id);
    perform public.assert_team_roster_change_allowed(new.team_id);
    return new;
  else
    perform public.assert_team_roster_change_allowed(new.team_id);
    return new;
  end if;
end;
$$;

revoke all on function public.enforce_roster_change_cutoff() from public, anon, authenticated;

drop trigger if exists enforce_roster_change_cutoff on public.rosters;
create trigger enforce_roster_change_cutoff
before insert or update or delete on public.rosters
for each row execute function public.enforce_roster_change_cutoff();
