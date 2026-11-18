-- Section 8.4: manager-controlled post-Week-5 TBA -> BYE conversion.
--
-- This is intentionally separate from IBA schedule monitoring/application:
-- after Week 5, a manager may resolve an unresolved TBA participant to a
-- schedule-only BYE. The BYE is represented by a real team row marked is_bye,
-- so existing schedule/team display paths can render it normally, while roster
-- reconciliation already excludes BYE teams from official roster requirements.

create table if not exists public.iba_schedule_bye_conversions (
  id uuid primary key default gen_random_uuid(),
  pairing_id uuid not null references public.schedule_pairings(id) on delete restrict,
  week_id uuid not null references public.schedule_weeks(id) on delete restrict,
  division_id uuid not null references public.divisions(id) on delete restrict,
  converted_side text not null check (converted_side in ('home', 'away')),
  previous_tbd_code text not null,
  bye_team_id uuid not null references public.teams(id) on delete restrict,
  converted_by uuid not null references public.profiles(id) on delete restrict,
  converted_at timestamptz not null default now(),
  unique (pairing_id, converted_side)
);

create index if not exists iba_schedule_bye_conversions_division_idx
  on public.iba_schedule_bye_conversions (division_id, converted_at desc);

create index if not exists iba_schedule_bye_conversions_week_idx
  on public.iba_schedule_bye_conversions (week_id, converted_at desc);

alter table public.iba_schedule_bye_conversions enable row level security;

revoke all on public.iba_schedule_bye_conversions from public, anon, authenticated;
grant select on public.iba_schedule_bye_conversions to authenticated;

drop policy if exists "Managers can read IBA TBA to BYE conversions"
  on public.iba_schedule_bye_conversions;

create policy "Managers can read IBA TBA to BYE conversions"
  on public.iba_schedule_bye_conversions
  for select to authenticated
  using (public.current_role_name() = 'manager');

create or replace function public.convert_iba_tba_to_bye(
  p_pairing_id uuid,
  p_side text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pairing_row public.schedule_pairings%rowtype;
  week_row public.schedule_weeks%rowtype;
  division_row public.divisions%rowtype;
  existing_bye public.teams%rowtype;
  bye_team public.teams%rowtype;
  converted_user uuid := (select auth.uid());
  prior_tbd_code text;
  converted_at_value timestamptz := now();
begin
  if converted_user is null then
    raise exception 'Authentication is required.';
  end if;

  if public.current_role_name() <> 'manager' then
    raise exception 'Manager access is required.';
  end if;

  if p_side not in ('home', 'away') then
    raise exception 'The TBA side must be home or away.';
  end if;

  select *
    into pairing_row
    from public.schedule_pairings
   where id = p_pairing_id
   for update;

  if not found then
    raise exception 'The schedule pairing was not found.';
  end if;

  select *
    into week_row
    from public.schedule_weeks
   where id = pairing_row.week_id
   for update;

  if not found then
    raise exception 'The schedule week was not found.';
  end if;

  select *
    into division_row
    from public.divisions
   where id = week_row.division_id
   for update;

  if not found then
    raise exception 'The schedule division was not found.';
  end if;

  if coalesce(week_row.is_playoff, false) then
    raise exception 'TBA to BYE conversion is only available for regular-season schedule weeks.';
  end if;

  if not exists (
    select 1
      from public.schedule_weeks w
     where w.division_id = division_row.id
       and w.week_num = 5
       and not coalesce(w.is_playoff, false)
       and nullif(trim(coalesce(w.date, '')), '') is not null
  ) then
    raise exception 'Week 5 is not available for this division.';
  end if;

  if (now() at time zone 'America/Chicago')::date <= (
    select to_date(trim(w.date), 'YYYY-MM-DD')
      from public.schedule_weeks w
     where w.division_id = division_row.id
       and w.week_num = 5
       and not coalesce(w.is_playoff, false)
     order by w.id
     limit 1
  ) then
    raise exception 'TBA to BYE conversion is available only after the Week 5 date has passed.';
  end if;

  if p_side = 'home' then
    if pairing_row.home_team_id is not null or nullif(trim(pairing_row.home_tbd_code), '') is null then
      raise exception 'The selected home participant is not unresolved TBA.';
    end if;
    prior_tbd_code := trim(pairing_row.home_tbd_code);
    if pairing_row.away_team_id is not null then
      select * into existing_bye from public.teams where id = pairing_row.away_team_id;
      if coalesce(existing_bye.is_bye, false) then
        raise exception 'A BYE is already the opponent in this pairing.';
      end if;
    end if;
  else
    if pairing_row.away_team_id is not null or nullif(trim(pairing_row.away_tbd_code), '') is null then
      raise exception 'The selected away participant is not unresolved TBA.';
    end if;
    prior_tbd_code := trim(pairing_row.away_tbd_code);
    if pairing_row.home_team_id is not null then
      select * into existing_bye from public.teams where id = pairing_row.home_team_id;
      if coalesce(existing_bye.is_bye, false) then
        raise exception 'A BYE is already the opponent in this pairing.';
      end if;
    end if;
  end if;

  if exists (
    select 1
      from public.schedule_pairings sp
      join public.teams t
        on t.id = case
          when sp.home_team_id is not null then sp.home_team_id
          else sp.away_team_id
        end
     where sp.week_id = week_row.id
       and t.is_bye = true
       and sp.id <> pairing_row.id
  ) then
    raise exception 'This week already has a BYE schedule entry.';
  end if;

  select *
    into bye_team
    from public.teams
   where division_id = division_row.id
     and is_bye = true
   order by id
   limit 1
   for update;

  if not found then
    insert into public.teams (
      division_id,
      team_num,
      name,
      venue,
      is_bye
    )
    values (
      division_row.id,
      'BYE',
      'BYE',
      '',
      true
    )
    on conflict (division_id, team_num)
    do update set
      name = 'BYE',
      is_bye = true
    returning * into bye_team;
  end if;

  if p_side = 'home' then
    update public.schedule_pairings
       set home_team_id = bye_team.id,
           home_tbd_code = null
     where id = pairing_row.id;
  else
    update public.schedule_pairings
       set away_team_id = bye_team.id,
           away_tbd_code = null
     where id = pairing_row.id;
  end if;

  insert into public.iba_schedule_bye_conversions (
    pairing_id,
    week_id,
    division_id,
    converted_side,
    previous_tbd_code,
    bye_team_id,
    converted_by,
    converted_at
  )
  values (
    pairing_row.id,
    week_row.id,
    division_row.id,
    p_side,
    prior_tbd_code,
    bye_team.id,
    converted_user,
    converted_at_value
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'converted',
    'pairingId', pairing_row.id,
    'weekId', week_row.id,
    'divisionId', division_row.id,
    'byeTeamId', bye_team.id,
    'convertedSide', p_side,
    'previousTbdCode', prior_tbd_code
  );
end;
$$;

revoke all on function public.convert_iba_tba_to_bye(uuid, text) from public, anon;
grant execute on function public.convert_iba_tba_to_bye(uuid, text) to authenticated;
