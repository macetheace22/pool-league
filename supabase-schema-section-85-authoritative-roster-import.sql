-- Section 85: authoritative IBA roster reconciliation and Section 8.1 safeguards.
--
-- A validated official IBA import replaces current roster memberships for
-- complete divisions. Historical completed-match JSON, player ratings, and
-- the Section 84 player_division_team_assignments ledger are never deleted.

create or replace function public.roster_change_window(p_team_id uuid)
returns table (
  week_six_date date,
  final_four_start_date date,
  postseason_start_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_division_id uuid;
  v_last_regular_week integer;
begin
  select t.division_id into v_division_id
  from public.teams t
  where t.id = p_team_id;

  if v_division_id is null then
    raise exception 'TEAM_NOT_FOUND';
  end if;

  select to_date(trim(sw.date), 'FMMM/FMDD/YYYY')
    into week_six_date
  from public.schedule_weeks sw
  where sw.division_id = v_division_id
    and sw.week_num = 6
    and trim(sw.date) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
  order by sw.created_at desc
  limit 1;

  select max(sw.week_num)
    into v_last_regular_week
  from public.schedule_weeks sw
  where sw.division_id = v_division_id
    and coalesce(sw.is_playoff, false) = false
    and sw.week_num is not null;

  if v_last_regular_week is not null then
    select to_date(trim(sw.date), 'FMMM/FMDD/YYYY')
      into final_four_start_date
    from public.schedule_weeks sw
    where sw.division_id = v_division_id
      and coalesce(sw.is_playoff, false) = false
      and sw.week_num = greatest(v_last_regular_week - 3, 1)
      and trim(sw.date) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
    order by sw.created_at desc
    limit 1;
  end if;

  select min(to_date(trim(sw.date), 'FMMM/FMDD/YYYY'))
    into postseason_start_date
  from public.schedule_weeks sw
  where sw.division_id = v_division_id
    and sw.is_playoff = true
    and trim(sw.date) ~ '^\d{1,2}/\d{1,2}/\d{4}$';

  return next;
end;
$$;

revoke all on function public.roster_change_window(uuid) from public, anon, authenticated;

create or replace function public.assert_team_roster_change_allowed(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_week_six_date date;
  v_final_four_start_date date;
  v_postseason_start_date date;
begin
  v_role := public.current_role_name();
  if v_role is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select w.week_six_date, w.final_four_start_date, w.postseason_start_date
    into v_week_six_date, v_final_four_start_date, v_postseason_start_date
  from public.roster_change_window(p_team_id) w;

  -- This bypass is set only inside the manager-only, SECURITY DEFINER
  -- authoritative import RPC below. Section 84's played-player transfer
  -- trigger remains in force for all imported assignments.
  if v_role = 'manager'
     and coalesce(current_setting('app.official_iba_roster_import', true), 'false') = 'true' then
    return;
  end if;

  if (v_postseason_start_date is not null and current_date >= v_postseason_start_date)
     or (v_final_four_start_date is not null and current_date >= v_final_four_start_date) then
    raise exception 'ROSTER_CHANGES_FROZEN: manual roster changes are not allowed during the final four weeks or postseason'
      using errcode = '42501';
  end if;

  if v_role = 'manager' then
    return;
  end if;

  if v_role <> 'captain' or not public.is_team_captain(p_team_id) then
    raise exception 'TEAM_ACCESS_DENIED' using errcode = '42501';
  end if;

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
  v_week_six_date date;
  v_final_four_start_date date;
  v_postseason_start_date date;
begin
  v_role := public.current_role_name();
  if v_role is null then return false; end if;

  select w.week_six_date, w.final_four_start_date, w.postseason_start_date
    into v_week_six_date, v_final_four_start_date, v_postseason_start_date
  from public.roster_change_window(p_team_id) w;

  if (v_postseason_start_date is not null and current_date >= v_postseason_start_date)
     or (v_final_four_start_date is not null and current_date >= v_final_four_start_date) then
    return false;
  end if;

  if v_role = 'manager' then return true; end if;
  if v_role <> 'captain' or not public.is_team_captain(p_team_id) then return false; end if;
  return v_week_six_date is null or current_date < v_week_six_date;
end;
$$;

revoke all on function public.can_captain_change_roster(uuid) from public, anon;
grant execute on function public.can_captain_change_roster(uuid) to authenticated;

-- The six-player roster ceiling applies to manual additions and official
-- imports. The manager retains discretion over survival-related changes
-- between the Week 6 cutoff and the final-four freeze.
create or replace function public.enforce_roster_change_cutoff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_role text;
  v_import boolean;
  v_roster_count integer;
begin
  v_role := public.current_role_name();
  v_import := coalesce(current_setting('app.official_iba_roster_import', true), 'false') = 'true';

  if tg_op = 'DELETE' then
    perform public.assert_team_roster_change_allowed(old.team_id);
    return old;
  elsif tg_op = 'UPDATE' then
    perform public.assert_team_roster_change_allowed(old.team_id);
    perform public.assert_team_roster_change_allowed(new.team_id);
    v_team_id := new.team_id;
  else
    perform public.assert_team_roster_change_allowed(new.team_id);
    v_team_id := new.team_id;
  end if;

  if tg_op <> 'DELETE' then
    select count(*) into v_roster_count
    from public.rosters
    where team_id = v_team_id
      and (tg_op <> 'UPDATE' or player_num <> old.player_num or team_id <> old.team_id);

    if not exists (
      select 1 from public.rosters
      where team_id = new.team_id and player_num = new.player_num
    ) and v_roster_count >= 6 then
      raise exception 'ROSTER_LIMIT_SIX: a team may not have more than six current roster members'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.enforce_roster_change_cutoff() from public, anon, authenticated;
drop trigger if exists enforce_roster_change_cutoff on public.rosters;
create trigger enforce_roster_change_cutoff
before insert or update or delete on public.rosters
for each row execute function public.enforce_roster_change_cutoff();

-- Atomic, manager-only replacement of current rosters for complete divisions.
-- The caller supplies every active team in each division, including empty
-- player arrays. This RPC never deletes player, match, rating, or assignment
-- history. Section 84 continues to reject unapproved played-player transfers.
create or replace function public.sync_imported_team_rosters(p_rosters jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_ids uuid[];
  v_team_count integer;
  v_player_count integer;
begin
  if auth.uid() is null or public.current_role_name() is distinct from 'manager' then
    raise exception 'MANAGER_REQUIRED' using errcode = '42501';
  end if;

  if jsonb_typeof(p_rosters) is distinct from 'array'
     or jsonb_array_length(p_rosters) = 0 then
    raise exception 'ROSTER_IMPORT_PAYLOAD_REQUIRED';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
    where item.team_id is null or jsonb_typeof(item.player_nums) is distinct from 'array'
  ) then
    raise exception 'ROSTER_IMPORT_PAYLOAD_INVALID';
  end if;

  if exists (
    select team_id
    from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
    group by team_id
    having count(*) > 1
  ) then
    raise exception 'ROSTER_IMPORT_DUPLICATE_TEAM';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
    left join public.teams t on t.id = item.team_id
    left join public.divisions d on d.id = t.division_id
    left join public.seasons s on s.id = d.season_id
    where t.id is null or d.id is null or s.is_active is distinct from true
  ) then
    raise exception 'ROSTER_IMPORT_TEAM_NOT_IN_ACTIVE_SEASON';
  end if;

  -- Do not clear a division unless every team currently configured in it is
  -- present in the import payload. Parser omissions and partial PDFs fail closed.
  if exists (
    select 1
    from (
      select distinct t.division_id
      from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
      join public.teams t on t.id = item.team_id
    ) included
    join public.teams expected on expected.division_id = included.division_id
    where not exists (
      select 1
      from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
      where item.team_id = expected.id
    )
  ) then
    raise exception 'ROSTER_IMPORT_INCOMPLETE_DIVISION';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
    cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
    where nullif(trim(player_row.player_num), '') is null
       or not exists (select 1 from public.players p where p.num = player_row.player_num)
  ) then
    raise exception 'ROSTER_IMPORT_UNKNOWN_PLAYER';
  end if;

  if exists (
    select player_num, division_id
    from (
      select t.division_id, player_row.player_num, t.id as team_id
      from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
      join public.teams t on t.id = item.team_id
      cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
    ) assignments
    group by player_num, division_id
    having count(distinct team_id) > 1
  ) then
    raise exception 'ROSTER_IMPORT_PLAYER_ON_MULTIPLE_TEAMS';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
    cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
    group by item.team_id
    having count(distinct player_row.player_num) > 6
  ) then
    raise exception 'ROSTER_LIMIT_SIX';
  end if;

  select array_agg(team_id), count(*)
    into v_team_ids, v_team_count
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb);

  select count(*) into v_player_count
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
  cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num);

  -- End current account/team access for removed players; preserve membership
  -- rows and history. Captain assignments are separate and remain untouched.
  update public.profile_team_memberships membership
  set ended_at = now()
  from public.profiles profile, public.rosters roster
  where roster.team_id = any(v_team_ids)
    and profile.player_num = roster.player_num
    and membership.profile_id = profile.id
    and membership.team_id = roster.team_id
    and membership.ended_at is null
    and not exists (
      select 1
      from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
      cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
      where item.team_id = roster.team_id
        and player_row.player_num = roster.player_num
    );

  -- Trigger bypass is transaction-local and can only be set inside this
  -- manager-only SECURITY DEFINER function.
  perform set_config('app.official_iba_roster_import', 'true', true);

  delete from public.rosters where team_id = any(v_team_ids);

  insert into public.rosters(team_id, player_num)
  select item.team_id, player_row.player_num
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
  cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
  on conflict (team_id, player_num) do nothing;

  -- Restore current profile/team access for members on the newly imported roster.
  insert into public.profile_team_memberships(profile_id, team_id)
  select distinct profile.id, item.team_id
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
  cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
  join public.profiles profile on profile.player_num = player_row.player_num
  on conflict (profile_id, team_id) where ended_at is null do nothing;

  return jsonb_build_object('teamCount', v_team_count, 'playerCount', v_player_count);
end;
$$;

revoke all on function public.sync_imported_team_rosters(jsonb) from public, anon;
grant execute on function public.sync_imported_team_rosters(jsonb) to authenticated;
