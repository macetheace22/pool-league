-- Section 85: authoritative IBA roster reconciliation and Section 8.1 safeguards.
--
-- A validated official IBA import replaces current roster memberships for
-- complete divisions. Historical completed-match JSON, player ratings, and
-- the Section 84 player_division_team_assignments ledger are never deleted.

-- Preserve every player/team roster association independently of the
-- current rosters table. This includes players who never appeared in a match.
-- A player/team pair is stored once; active membership remains in public.rosters.
create table if not exists public.player_team_roster_history (
  player_num text not null references public.players(num) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  first_added_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (player_num, team_id)
);

alter table public.player_team_roster_history enable row level security;
revoke all on public.player_team_roster_history from public, anon, authenticated;
grant select on public.player_team_roster_history to authenticated;

drop policy if exists "Authenticated users can read roster history"
  on public.player_team_roster_history;
create policy "Authenticated users can read roster history"
  on public.player_team_roster_history
  for select to authenticated using (true);

-- Backfill existing account/team membership history, including ended
-- memberships for players who had already left a team before this migration.
insert into public.player_team_roster_history
  (player_num, team_id, division_id, first_added_at, last_seen_at)
select
  profile.player_num,
  membership.team_id,
  team.division_id,
  min(coalesce(membership.joined_at, now())),
  max(coalesce(membership.ended_at, membership.joined_at, now()))
from public.profile_team_memberships membership
join public.profiles profile on profile.id = membership.profile_id
join public.teams team on team.id = membership.team_id
where profile.player_num is not null
  and team.division_id is not null
group by profile.player_num, membership.team_id, team.division_id
on conflict (player_num, team_id) do update
set first_added_at = least(public.player_team_roster_history.first_added_at, excluded.first_added_at),
    last_seen_at = greatest(public.player_team_roster_history.last_seen_at, excluded.last_seen_at);

-- Completed matches recover prior team associations for players whose old
-- roster row and/or account membership had already been removed.
with match_players as (
  select set_row.value->'playerHome'->>'num' as player_num, cm.team_home_id as team_id, cm.created_at
  from public.completed_matches cm
  cross join lateral jsonb_array_elements(coalesce(cm.state->'sets', '[]'::jsonb)) as set_row(value)
  where cm.team_home_id is not null
    and jsonb_array_length(coalesce(set_row.value->'racks', '[]'::jsonb)) > 0
    and nullif(set_row.value->'playerHome'->>'num', '') is not null
  union all
  select set_row.value->'playerAway'->>'num' as player_num, cm.team_away_id as team_id, cm.created_at
  from public.completed_matches cm
  cross join lateral jsonb_array_elements(coalesce(cm.state->'sets', '[]'::jsonb)) as set_row(value)
  where cm.team_away_id is not null
    and jsonb_array_length(coalesce(set_row.value->'racks', '[]'::jsonb)) > 0
    and nullif(set_row.value->'playerAway'->>'num', '') is not null
),
match_summary as (
  select player_num, team_id, min(created_at) as first_match_at, max(created_at) as last_match_at
  from match_players
  group by player_num, team_id
)
insert into public.player_team_roster_history
  (player_num, team_id, division_id, first_added_at, last_seen_at)
select
  summary.player_num,
  summary.team_id,
  team.division_id,
  summary.first_match_at,
  summary.last_match_at
from match_summary summary
join public.teams team on team.id = summary.team_id
join public.players player on player.num = summary.player_num
where team.division_id is not null
on conflict (player_num, team_id) do update
set first_added_at = least(public.player_team_roster_history.first_added_at, excluded.first_added_at),
    last_seen_at = greatest(public.player_team_roster_history.last_seen_at, excluded.last_seen_at);

-- Seed every current roster member, including players without a linked account.
insert into public.player_team_roster_history
  (player_num, team_id, division_id)
select roster.player_num, roster.team_id, team.division_id
from public.rosters roster
join public.teams team on team.id = roster.team_id
where team.division_id is not null
on conflict (player_num, team_id) do update
set last_seen_at = greatest(public.player_team_roster_history.last_seen_at, now());

create or replace function public.track_player_team_roster_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $history$
declare
  v_division_id uuid;
begin
  select team.division_id into v_division_id
  from public.teams team
  where team.id = new.team_id;

  if v_division_id is not null then
    insert into public.player_team_roster_history
      (player_num, team_id, division_id, first_added_at, last_seen_at)
    values
      (new.player_num, new.team_id, v_division_id, now(), now())
    on conflict (player_num, team_id) do update
    set last_seen_at = now();
  end if;

  return new;
end;
$history$;

revoke all on function public.track_player_team_roster_history() from public, anon, authenticated;
drop trigger if exists track_player_team_roster_history on public.rosters;
create trigger track_player_team_roster_history
after insert or update of team_id, player_num on public.rosters
for each row execute function public.track_player_team_roster_history();

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
  v_week_six_date date;
  v_final_four_start_date date;
  v_postseason_start_date date;
  v_roster_count integer;
  v_roster_limit integer := 8;
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

  select w.week_six_date, w.final_four_start_date, w.postseason_start_date
    into v_week_six_date, v_final_four_start_date, v_postseason_start_date
  from public.roster_change_window(v_team_id) w;

  -- Section 4.2 allows one to eight roster members. During the restricted
  -- Week 6-to-final-four window, a manager's approved change must leave no
  -- more than six. Deletions remain possible so an over-limit roster can be
  -- reduced one member at a time. Official imports retain the published IBA
  -- roster (up to the structural eight-member maximum).
  if not v_import
     and v_week_six_date is not null
     and current_date >= v_week_six_date
     and (v_final_four_start_date is null or current_date < v_final_four_start_date)
     and (v_postseason_start_date is null or current_date < v_postseason_start_date) then
    v_roster_limit := 6;
  end if;

  if tg_op <> 'DELETE' then
    if tg_op = 'UPDATE' then
      select count(*) into v_roster_count
      from public.rosters r
      where r.team_id = new.team_id
        and not (r.team_id = old.team_id and r.player_num = old.player_num);
    else
      select count(*) into v_roster_count
      from public.rosters r
      where r.team_id = new.team_id;
    end if;

    if not exists (
      select 1 from public.rosters r
      where r.team_id = new.team_id and r.player_num = new.player_num
    ) and v_roster_count >= v_roster_limit then
      raise exception 'ROSTER_LIMIT: resulting roster may not exceed % members in this period', v_roster_limit
        using errcode = '23514';
    end if;
  end if;

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
  v_removed record;
  v_over_six_teams jsonb := '[]'::jsonb;
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
    join public.teams expected
      on expected.division_id = included.division_id
     and coalesce(expected.is_bye, false) = false
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
    having count(distinct player_row.player_num) > 8
  ) then
    raise exception 'ROSTER_LIMIT_EIGHT';
  end if;

  select array_agg(team_id), count(*)
    into v_team_ids, v_team_count
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb);

  select count(*) into v_player_count
  from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
  cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num);

  perform set_config('app.official_iba_roster_import', 'true', true);

  -- Reuse the established removal workflow so removed captains lose their
  -- captain assignment and account/team access exactly as with a manager
  -- roster removal. The Section 84 assignment ledger is intentionally kept.
  for v_removed in
    select r.team_id, r.player_num
    from public.rosters r
    where r.team_id = any(v_team_ids)
      and not exists (
        select 1
        from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
        cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
        where item.team_id = r.team_id
          and player_row.player_num = r.player_num
      )
  loop
    perform public.remove_player_from_team(v_removed.team_id, v_removed.player_num);
  end loop;

  -- Keep unchanged active roster rows in place. Only missing assignments are
  -- inserted below; this avoids closing/reopening every history row weekly.

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

  -- Official imports remain authoritative, but flag any imported roster
  -- above six during the restricted period so management can review it.
  select coalesce(jsonb_agg(jsonb_build_object(
    'teamId', roster_counts.team_id,
    'teamNum', roster_counts.team_num,
    'playerCount', roster_counts.player_count
  )), '[]'::jsonb)
  into v_over_six_teams
  from (
    select t.id as team_id, t.team_num, count(distinct player_row.player_num)::integer as player_count
    from jsonb_to_recordset(p_rosters) as item(team_id uuid, player_nums jsonb)
    join public.teams t on t.id = item.team_id
    cross join lateral jsonb_array_elements_text(item.player_nums) as player_row(player_num)
    group by t.id, t.team_num
  ) roster_counts
  cross join lateral public.roster_change_window(roster_counts.team_id) window_dates
  where roster_counts.player_count > 6
    and window_dates.week_six_date is not null
    and current_date >= window_dates.week_six_date
    and (window_dates.final_four_start_date is null or current_date < window_dates.final_four_start_date)
    and (window_dates.postseason_start_date is null or current_date < window_dates.postseason_start_date);

  return jsonb_build_object('teamCount', v_team_count, 'playerCount', v_player_count, 'overSixTeams', v_over_six_teams);
end;
$$;

revoke all on function public.sync_imported_team_rosters(jsonb) from public, anon;
grant execute on function public.sync_imported_team_rosters(jsonb) to authenticated;
