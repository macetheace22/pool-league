-- Section 91: controlled application of manager-approved IBA schedule changes
--
-- Applies one approved IBA snapshot transactionally, preserves the complete
-- before/after schedule state, and marks the originating monitor check as
-- applied so it cannot be applied twice.

alter table public.iba_schedule_monitor_checks
  drop constraint if exists iba_schedule_monitor_checks_review_status_check;

alter table public.iba_schedule_monitor_checks
  add constraint iba_schedule_monitor_checks_review_status_check
  check (review_status in ('not_required', 'pending', 'approved', 'rejected', 'applied'));

alter table public.iba_schedule_monitor_checks
  add column if not exists application_id uuid,
  add column if not exists applied_by uuid,
  add column if not exists applied_at timestamptz;

create table if not exists public.iba_schedule_change_applications (
  id uuid primary key default gen_random_uuid(),
  monitor_check_id uuid not null references public.iba_schedule_monitor_checks(id) on delete restrict,
  season_id uuid not null references public.seasons(id) on delete restrict,
  division_id uuid not null references public.divisions(id) on delete restrict,
  applied_by uuid not null references public.profiles(id) on delete restrict,
  applied_at timestamptz not null default now(),
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  changes jsonb not null default '[]'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  unique (monitor_check_id)
);

create index if not exists iba_schedule_change_applications_division_idx
  on public.iba_schedule_change_applications (division_id, applied_at desc);

create index if not exists iba_schedule_change_applications_season_idx
  on public.iba_schedule_change_applications (season_id, applied_at desc);

alter table public.iba_schedule_change_applications enable row level security;

revoke all on public.iba_schedule_change_applications from public, anon, authenticated;
grant select on public.iba_schedule_change_applications to authenticated;

drop policy if exists "Managers can read IBA schedule applications"
  on public.iba_schedule_change_applications;

create policy "Managers can read IBA schedule applications"
  on public.iba_schedule_change_applications
  for select to authenticated
  using (public.current_role_name() = 'manager');

create or replace function public.apply_iba_schedule_change(p_check_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  check_row public.iba_schedule_monitor_checks%rowtype;
  division_row public.divisions%rowtype;
  latest_check public.iba_schedule_monitor_checks%rowtype;
  before_state jsonb;
  resulting_state jsonb;
  application_row public.iba_schedule_change_applications%rowtype;
  applied_user uuid := (select auth.uid());
  team_item jsonb;
  week_item jsonb;
  pairing_item jsonb;
  week_row public.schedule_weeks%rowtype;
  application_exists boolean;
begin
  if applied_user is null then
    raise exception 'Authentication is required.';
  end if;

  if public.current_role_name() <> 'manager' then
    raise exception 'Manager access is required.';
  end if;

  select *
    into check_row
    from public.iba_schedule_monitor_checks
   where id = p_check_id
   for update;

  if not found then
    raise exception 'IBA schedule monitor check was not found.';
  end if;

  if check_row.review_status = 'applied' then
    return jsonb_build_object(
      'ok', true,
      'status', 'already_applied',
      'applicationId', check_row.application_id
    );
  end if;

  if check_row.review_status <> 'approved' then
    raise exception 'Only an approved IBA schedule change can be applied.';
  end if;

  -- Do not allow an older approved snapshot to overwrite a newer monitor
  -- result that has already been recorded for this division.
  select *
    into latest_check
    from public.iba_schedule_monitor_checks
   where division_id = check_row.division_id
   order by monitor_date desc, checked_at desc
   limit 1;

  if latest_check.id <> check_row.id
     and coalesce(latest_check.snapshot_fingerprint, '') <> coalesce(check_row.snapshot_fingerprint, '') then
    raise exception 'A newer IBA schedule check exists for this division. Review the newer change before applying this approval.';
  end if;

  select *
    into division_row
    from public.divisions
   where id = check_row.division_id
   for update;

  if not found then
    raise exception 'The IBA division no longer exists.';
  end if;

  if check_row.snapshot is null
     or jsonb_typeof(check_row.snapshot) <> 'object'
     or jsonb_typeof(check_row.snapshot->'teams') <> 'array'
     or jsonb_typeof(check_row.snapshot->'weeks') <> 'array' then
    raise exception 'The approved IBA snapshot is incomplete.';
  end if;

  select exists (
    select 1
      from public.iba_schedule_change_applications
     where monitor_check_id = check_row.id
  )
  into application_exists;

  if application_exists then
    raise exception 'This approved IBA schedule change has already been applied.';
  end if;

  select jsonb_build_object(
    'teams',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'teamNum', t.team_num,
          'name', t.name,
          'venue', coalesce(t.venue, ''),
          'isBye', coalesce(t.is_bye, false)
        )
        order by t.team_num
      )
      from public.teams t
      where t.division_id = division_row.id
    ), '[]'::jsonb),
    'weeks',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'week', sw.week_num,
          'date', sw.date,
          'special', coalesce(sw.special, ''),
          'isPlayoff', coalesce(sw.is_playoff, false),
          'pairings',
          coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'homeTeamNum', ht.team_num,
                'awayTeamNum', at.team_num,
                'homeTbdCode', sp.home_tbd_code,
                'awayTbdCode', sp.away_tbd_code
              )
              order by sp.id
            )
            from public.schedule_pairings sp
            left join public.teams ht on ht.id = sp.home_team_id
            left join public.teams at on at.id = sp.away_team_id
            where sp.week_id = sw.id
          ), '[]'::jsonb)
        )
        order by sw.week_num, sw.date
      )
      from public.schedule_weeks sw
      where sw.division_id = division_row.id
    ), '[]'::jsonb)
  )
  into before_state;

  insert into public.iba_schedule_change_applications (
    monitor_check_id,
    season_id,
    division_id,
    applied_by,
    before_snapshot,
    after_snapshot,
    changes,
    summary
  )
  values (
    check_row.id,
    check_row.season_id,
    check_row.division_id,
    applied_user,
    before_state,
    check_row.snapshot,
    coalesce(check_row.changes, '[]'::jsonb),
    coalesce(check_row.summary, '{}'::jsonb)
  )
  returning * into application_row;

  -- Update/add IBA teams while preserving existing UUIDs, captains, rosters,
  -- and other app-owned team data. Teams absent from the new IBA snapshot are
  -- retained because other app data can still reference their UUIDs.
  for team_item in
    select value
      from jsonb_array_elements(check_row.snapshot->'teams')
     where coalesce(value->>'teamNum', '') <> ''
       and coalesce((value->>'isTbd')::boolean, false) = false
  loop
    insert into public.teams (
      division_id, team_num, name, venue, is_bye
    )
    values (
      division_row.id,
      trim(team_item->>'teamNum'),
      trim(team_item->>'name'),
      trim(coalesce(team_item->>'venue', '')),
      coalesce((team_item->>'isBye')::boolean, false)
    )
    on conflict (division_id, team_num)
    do update set
      name = excluded.name,
      venue = excluded.venue,
      is_bye = excluded.is_bye;
  end loop;

  -- The live schedule is replaced only after approval, inside this transaction.
  -- The application history row above makes the prior schedule recoverable.
  delete from public.schedule_weeks
   where division_id = division_row.id;

  for week_item in
    select value
      from jsonb_array_elements(check_row.snapshot->'weeks')
     order by coalesce(nullif(value->>'week', '')::integer, 2147483647),
              value->>'date'
  loop
    insert into public.schedule_weeks (
      division_id,
      week_num,
      date,
      special,
      is_playoff,
      playoff_label
    )
    values (
      division_row.id,
      nullif(week_item->>'week', '')::integer,
      trim(week_item->>'date'),
      nullif(trim(week_item->>'special'), ''),
      coalesce((week_item->>'isPlayoff')::boolean, false),
      case
        when coalesce((week_item->>'isPlayoff')::boolean, false)
          then nullif(trim(week_item->>'special'), '')
        else null
      end
    )
    returning * into week_row;

    for pairing_item in
      select value
        from jsonb_array_elements(coalesce(week_item->'pairings', '[]'::jsonb))
    loop
      insert into public.schedule_pairings (
        week_id,
        home_team_id,
        away_team_id,
        home_tbd_code,
        away_tbd_code
      )
      select
        week_row.id,
        ht.id,
        at.id,
        nullif(trim(pairing_item->>'homeTbdCode'), ''),
        nullif(trim(pairing_item->>'awayTbdCode'), '')
      from public.teams ht
      left join public.teams at
        on at.division_id = division_row.id
       and at.team_num = trim(pairing_item->>'awayTeamNum')
      where ht.division_id = division_row.id
        and ht.team_num = trim(pairing_item->>'homeTeamNum')
        and (
          at.id is not null
          or nullif(trim(pairing_item->>'awayTbdCode'), '') is not null
        );

      if not found and nullif(trim(pairing_item->>'homeTbdCode'), '') is null then
        raise exception 'IBA schedule application could not resolve home team % for week %.',
          pairing_item->>'homeTeamNum', week_item->>'week';
      end if;
    end loop;
  end loop;

  select jsonb_build_object(
    'teams',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'teamNum', t.team_num,
          'name', t.name,
          'venue', coalesce(t.venue, ''),
          'isBye', coalesce(t.is_bye, false)
        )
        order by t.team_num
      )
      from public.teams t
      where t.division_id = division_row.id
    ), '[]'::jsonb),
    'weeks',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'week', sw.week_num,
          'date', sw.date,
          'special', coalesce(sw.special, ''),
          'isPlayoff', coalesce(sw.is_playoff, false),
          'pairings',
          coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'homeTeamNum', ht.team_num,
                'awayTeamNum', at.team_num,
                'homeTbdCode', sp.home_tbd_code,
                'awayTbdCode', sp.away_tbd_code
              )
              order by sp.id
            )
            from public.schedule_pairings sp
            left join public.teams ht on ht.id = sp.home_team_id
            left join public.teams at on at.id = sp.away_team_id
            where sp.week_id = sw.id
          ), '[]'::jsonb)
        )
        order by sw.week_num, sw.date
      )
      from public.schedule_weeks sw
      where sw.division_id = division_row.id
    ), '[]'::jsonb)
  )
  into resulting_state;

  update public.iba_schedule_change_applications
     set after_snapshot = resulting_state,
         applied_at = now()
   where id = application_row.id;

  update public.iba_schedule_monitor_checks
     set review_status = 'applied',
         application_id = application_row.id,
         applied_by = applied_user,
         applied_at = now()
   where id = check_row.id;

  return jsonb_build_object(
    'ok', true,
    'status', 'applied',
    'applicationId', application_row.id,
    'divisionId', division_row.id,
    'divisionNum', division_row.num
  );
end;
$$;

revoke all on function public.apply_iba_schedule_change(uuid) from public, anon;
grant execute on function public.apply_iba_schedule_change(uuid) to authenticated;

-- Verification:
-- select to_regclass('public.iba_schedule_change_applications') is not null as application_table_exists;
-- select has_function_privilege('authenticated', 'public.apply_iba_schedule_change(uuid)', 'EXECUTE') as execute_granted;
-- select count(*) from pg_policies where schemaname='public'
--   and tablename='iba_schedule_change_applications'
--   and policyname='Managers can read IBA schedule applications';
