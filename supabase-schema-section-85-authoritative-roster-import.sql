-- Section 85: authoritative IBA roster reconciliation and Section 8.1 freeze
--
-- Official weekly roster imports replace current roster membership for every
-- fully represented division. Historical match JSON and the Section 84
-- player_division_team_assignments ledger are deliberately retained.

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
  v_last_regular_week integer;
  v_final_four_start_date date;
  v_postseason_start_date date;
begin
  v_role := public.current_role_name();
  if v_role is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select division_id into v_division_id
  from public.teams
  where id = p_team_id;

  if v_division_id is null then
    raise exception 'TEAM_NOT_FOUND';
  end if;

  -- The official IBA import RPC is manager-only and has already validated
  -- complete division coverage. It may reconcile the published roster even
  -- during a manual-change freeze; Section 84 transfer safeguards still run.
  if v_role = 'manager'
     and coalesce(current_setting('app.official_iba_roster_import', true), 'false') = 'true' then
    return;
  end if;

  select to_date(trim(sw.date), 'FMMM/FMDD/YYYY')
    into v_week_six_date
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
      into v_final_four_start_date
    from public.schedule_weeks sw
    where sw.division_id = v_division_id
      and coalesce(sw.is_playoff, false) = false
      and sw.week_num = greatest(v_last_regular_week - 3, 1)
      and trim(sw.date) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
    order by sw.created_at desc
    limit 1;
  end if;

  select min(to_date(trim(sw.date), 'FMMM/FMDD/YYYY'))
    into v_postseason_start_date
  from public.schedule_weeks sw
  where sw.division_id = v_division_id
    and sw.is_playoff = true
    and trim(sw.date) ~ '^\d{1,2}/\d{1,2}/\d{4}$';

  if v_postseason_start_date is not null and current_date >= v_postseason_start_date then
    raise exception 'ROSTER_CHANGES_FROZEN: postseason roster changes are not allowed'
      using errcode = '42501';
  end if;

  if v_final_four_start_date is not null and current_date >= v_final_four_start_date then
    raise exception 'ROSTER_CHANGES_FROZEN: roster changes are not allowed during the final four weeks'
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

-- Add the Section 8.1 six-player ceiling for manager-initiated changes in the
-- restricted Week 6-to-final-four window. Survival purpose remains a League
-- Manager judgment; the app does not attempt to infer it.
create or replace function public.enforce_roster_change_cutoff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_division_id uuid;
  v_role text;
  v_week_six_date date;
  v_last_regular_week integer;
  v_final_four_start_date date;
  v_roster_count integer;
begin
  v_role := public.current_role_name();

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

  if v_role = 'manager'
     and coalesce(current_setting('app.official_iba_roster_import', true), 'false') <> 'true'
     and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.team_id is distinct from old.team_id)) then
    select division_id into v_division_id from public.teams where id = v_team_id;

    select to_date(trim(sw.date), 'FMMM/FMDD/YYYY')
      into v_week_six_date
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
        into v_final_four_start_date
      from public.schedule_weeks sw
      where sw.division_id = v_division_id
        and coalesce(sw.is_playoff, false) = false
        and sw.week_num = greatest(v_last_regular_week - 3, 1)
        and trim(sw.date) ~ '^\d{1,2}/\d{1,2}/\d{4}$'
      order by sw.created_at desc
      limit 1;
    end if;

    if v_week_six_date is not null
       and v_final_four_start_date is not null
       and current_date >= v_week_six_date
       and current_date < v_final_four_start_date then
      select count(*) into v_roster_count
      from public.rosters
      where team_id = v_team_id;

      if tg_op = 'INSERT'
         and not exists (
           select 1 from public.rosters
           where team_id = new.team_id and player_num = new.player_num
         )
         and v_roster_count >= 6 then
        raise exception 'ROSTER_LIMIT_SIX: restricted-period roster changes may not result in more than six members'
          using errcode = '23514';
      end if;

      if tg_op = 'UPDATE'
         and new.team_id is distinct from old.team_id
         and v_roster_count >= 6 then
        raise exception 'ROSTER_LIMIT_SIX: restricted-period roster changes may not result in more than six members'
          using errcode = '23514';
      end if;
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

-- Atomically replace current roster rows for complete divisions. The Section
-- 84 BEFORE INSERT trigger still checks the durable assignment ledger and
-- rejects a played player's unapproved same-division transfer.
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

  -- Refuse partial division reports. An incomplete PDF must never remove
  -- current members from teams whose roster section was not parsed.
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
    select player_num, division_id
    from (
      select
        t.division_id,
        player_row.player_num,
        t.id as team_id
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
    left join public.players p on p.num = player_row.player_num
    where p.num is null or nullif(trim(player_row.player_num), '') is null
  ) then
    raise exception 'ROSTER_IMPORT_UNKNOWN_PLAYER';
  end if;

  select array_agg(team_id), count(*)
    into v_team_ids, v_team_count
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb);

  select count(*) into v_player_count
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
  cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num);

  -- Keep profile/team access aligned with current roster membership, but end
  -- memberships rather than deleting them. Captain assignments are separate
  -- and are not changed by an IBA roster import.
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

  -- This flag bypasses only the manual Section 8.1 date/captain/cap guard.
  -- Section 84 assignment protection remains active for every inserted row.
  perform set_config('app.official_iba_roster_import', 'true', true);

  delete from public.rosters
  where team_id = any(v_team_ids);

  insert into public.rosters(team_id, player_num)
  select item.team_id, player_row.player_num
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
  cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
  on conflict (team_id, player_num) do nothing;

  insert into public.profile_team_memberships(profile_id, team_id)
  select distinct profile.id, item.team_id
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
  cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
  join public.profiles profile on profile.player_num = player_row.player_num
  on conflict (profile_id, team_id) where ended_at is null do nothing;

  return jsonb_build_object(
    'teamCount', v_team_count,
    'playerCount', v_player_count
  );
end;
$$;

revoke all on function public.sync_imported_team_rosters(jsonb) from public, anon;
grant execute on function public.sync_imported_team_rosters(jsonb) to authenticated;
