-- Section 102: manager-confirmed, season-wide single-elimination tournaments.
-- Seasonal tournaments are intentionally separate from division playoff_matches:
-- they combine qualifiers across divisions and must not rewrite division results.

begin;

create table if not exists public.seasonal_tournaments (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete restrict,
  tournament_type text not null
    check (tournament_type in ('championship', 'consolation')),
  status text not null default 'confirmed'
    check (status in ('confirmed', 'in_progress', 'completed', 'cancelled')),
  champion_team_id uuid references public.teams(id) on delete restrict,
  confirmed_by uuid not null references public.profiles(id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seasonal_tournaments_season_type_unique unique (season_id, tournament_type)
);

create table if not exists public.seasonal_tournament_entries (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.seasonal_tournaments(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete restrict,
  division_id uuid not null references public.divisions(id) on delete restrict,
  seed_num integer not null check (seed_num > 0),
  seed_category text not null check (seed_category in (
    'first_place_and_division_champion',
    'first_place_not_division_champion',
    'below_first_division_champion',
    'consolation_champion_back_to_back_wins',
    'consolation_champion_after_bye'
  )),
  seed_category_source text not null default 'rulebook_derived'
    check (seed_category_source in ('rulebook_derived', 'manager_verified')),
  division_position integer,
  received_bye_history boolean,
  created_at timestamptz not null default now(),
  constraint seasonal_tournament_entries_team_unique unique (tournament_id, team_id),
  constraint seasonal_tournament_entries_seed_unique unique (tournament_id, seed_num)
);

create table if not exists public.seasonal_tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.seasonal_tournaments(id) on delete cascade,
  match_key text not null,
  round_num integer not null check (round_num > 0),
  slot_num integer not null check (slot_num > 0),
  team_home_id uuid references public.teams(id) on delete restrict,
  team_away_id uuid references public.teams(id) on delete restrict,
  winner_team_id uuid references public.teams(id) on delete restrict,
  is_bye boolean not null default false,
  status text not null default 'pending'
    check (status in ('bye', 'pending', 'in_progress', 'completed')),
  feeds_into_match_id uuid references public.seasonal_tournament_matches(id) on delete restrict,
  feeds_into_slot text check (feeds_into_slot in ('home', 'away')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seasonal_tournament_matches_key_unique unique (tournament_id, match_key),
  constraint seasonal_tournament_matches_slot_unique unique (tournament_id, round_num, slot_num),
  constraint seasonal_tournament_matches_winner_participant check (
    winner_team_id is null or winner_team_id = team_home_id or winner_team_id = team_away_id
  ),
  constraint seasonal_tournament_matches_bye_shape check (
    not is_bye or (
      (team_home_id is null) <> (team_away_id is null)
      and winner_team_id = coalesce(team_home_id, team_away_id)
      and status = 'bye'
    )
  ),
  constraint seasonal_tournament_matches_feed_pair check (
    (feeds_into_match_id is null and feeds_into_slot is null)
    or (feeds_into_match_id is not null and feeds_into_slot is not null)
  )
);

create index if not exists seasonal_tournaments_season_idx
  on public.seasonal_tournaments(season_id, tournament_type);
create index if not exists seasonal_tournament_entries_seed_idx
  on public.seasonal_tournament_entries(tournament_id, seed_num);
create index if not exists seasonal_tournament_matches_round_idx
  on public.seasonal_tournament_matches(tournament_id, round_num, slot_num);

alter table public.seasonal_tournaments enable row level security;
alter table public.seasonal_tournament_entries enable row level security;
alter table public.seasonal_tournament_matches enable row level security;

revoke all on public.seasonal_tournaments from public, anon, authenticated;
revoke all on public.seasonal_tournament_entries from public, anon, authenticated;
revoke all on public.seasonal_tournament_matches from public, anon, authenticated;
grant select on public.seasonal_tournaments to authenticated;
grant select on public.seasonal_tournament_entries to authenticated;
grant select, insert on public.seasonal_tournament_matches to authenticated;
grant insert on public.seasonal_tournaments to authenticated;
grant insert on public.seasonal_tournament_entries to authenticated;


drop policy if exists seasonal_tournaments_manager_insert on public.seasonal_tournaments;
create policy seasonal_tournaments_manager_insert
  on public.seasonal_tournaments for insert to authenticated
  with check (
    (select public.current_role_name()) = 'manager'
    and confirmed_by = (select auth.uid())
  );

drop policy if exists seasonal_tournament_entries_manager_insert on public.seasonal_tournament_entries;
create policy seasonal_tournament_entries_manager_insert
  on public.seasonal_tournament_entries for insert to authenticated
  with check (
    exists (
      select 1 from public.seasonal_tournaments t
      where t.id = tournament_id
        and t.confirmed_by = (select auth.uid())
        and (select public.current_role_name()) = 'manager'
    )
  );

drop policy if exists seasonal_tournament_matches_manager_insert on public.seasonal_tournament_matches;
create policy seasonal_tournament_matches_manager_insert
  on public.seasonal_tournament_matches for insert to authenticated
  with check (
    exists (
      select 1 from public.seasonal_tournaments t
      where t.id = tournament_id
        and t.confirmed_by = (select auth.uid())
        and (select public.current_role_name()) = 'manager'
    )
  );

drop policy if exists seasonal_tournaments_manager_select on public.seasonal_tournaments;
create policy seasonal_tournaments_manager_select
  on public.seasonal_tournaments for select to authenticated
  using ((select public.current_role_name()) = 'manager');

drop policy if exists seasonal_tournament_entries_manager_select on public.seasonal_tournament_entries;
create policy seasonal_tournament_entries_manager_select
  on public.seasonal_tournament_entries for select to authenticated
  using (
    exists (
      select 1 from public.seasonal_tournaments t
      where t.id = tournament_id
        and (select public.current_role_name()) = 'manager'
    )
  );

drop policy if exists seasonal_tournament_matches_manager_select on public.seasonal_tournament_matches;
create policy seasonal_tournament_matches_manager_select
  on public.seasonal_tournament_matches for select to authenticated
  using (
    exists (
      select 1 from public.seasonal_tournaments t
      where t.id = tournament_id
        and (select public.current_role_name()) = 'manager'
    )
  );

create or replace function public.create_seasonal_tournament(
  p_season_id uuid,
  p_tournament_type text,
  p_entries jsonb,
  p_matches jsonb,
  p_champion_team_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_tournament_id uuid;
  v_team_count integer;
  v_bracket_size integer := 1;
  v_match_count integer;
  v_profile_id uuid := (select auth.uid());
begin
  if v_profile_id is null or (select public.current_role_name()) <> 'manager' then
    raise exception 'MANAGER_ONLY' using errcode = '42501';
  end if;
  if not exists (select 1 from public.seasons s where s.id = p_season_id) then
    raise exception 'SEASON_NOT_FOUND';
  end if;
  if p_tournament_type not in ('championship', 'consolation') then
    raise exception 'INVALID_TOURNAMENT_TYPE';
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_typeof(p_matches) <> 'array' then
    raise exception 'ENTRIES_AND_MATCHES_MUST_BE_ARRAYS';
  end if;

  select count(*) into v_team_count from jsonb_array_elements(p_entries);
  if v_team_count = 0 then raise exception 'NO_QUALIFIED_TEAMS'; end if;

  while v_bracket_size < v_team_count loop
    v_bracket_size := v_bracket_size * 2;
  end loop;
  if v_team_count > 1 then
  else
  end if;
  v_match_count := (select count(*) from jsonb_array_elements(p_matches));
  if v_match_count <> greatest(v_bracket_size - 1, 0) then
    raise exception 'BRACKET_MATCH_COUNT_INVALID';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_entries) as e(
      team_id uuid, division_id uuid, seed_num integer, seed_category text,
      seed_category_source text, division_position integer, received_bye_history boolean
    )
    group by e.team_id
    having count(*) > 1
  ) then raise exception 'DUPLICATE_TEAM_ENTRY'; end if;

  if (select count(distinct (e.seed_num)) from jsonb_to_recordset(p_entries) as e(
      team_id uuid, division_id uuid, seed_num integer, seed_category text,
      seed_category_source text, division_position integer, received_bye_history boolean
    )) <> v_team_count
    or (select min(e.seed_num) from jsonb_to_recordset(p_entries) as e(
      team_id uuid, division_id uuid, seed_num integer, seed_category text,
      seed_category_source text, division_position integer, received_bye_history boolean
    )) <> 1
    or (select max(e.seed_num) from jsonb_to_recordset(p_entries) as e(
      team_id uuid, division_id uuid, seed_num integer, seed_category text,
      seed_category_source text, division_position integer, received_bye_history boolean
    )) <> v_team_count
  then raise exception 'SEED_NUMBERS_MUST_BE_CONTIGUOUS'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_entries) as e(
      team_id uuid, division_id uuid, seed_num integer, seed_category text,
      seed_category_source text, division_position integer, received_bye_history boolean
    )
    left join public.teams tm on tm.id = e.team_id
    left join public.divisions d on d.id = tm.division_id
    where tm.id is null or d.id is null or d.season_id <> p_season_id
      or e.division_id <> tm.division_id
  ) then raise exception 'TEAM_NOT_IN_SEASON'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_entries) as e(
      team_id uuid, division_id uuid, seed_num integer, seed_category text,
      seed_category_source text, division_position integer, received_bye_history boolean
    )
    where (p_tournament_type = 'championship' and e.seed_category not in (
      'first_place_and_division_champion','first_place_not_division_champion','below_first_division_champion'
    ))
    or (p_tournament_type = 'consolation' and e.seed_category not in (
      'consolation_champion_back_to_back_wins','consolation_champion_after_bye'
    ))
    or e.seed_category_source not in ('rulebook_derived','manager_verified')
    or (p_tournament_type = 'championship' and e.seed_category_source <> 'rulebook_derived')
    or (p_tournament_type = 'consolation' and e.seed_category = 'consolation_champion_back_to_back_wins'
        and e.received_bye_history is distinct from false)
    or (p_tournament_type = 'consolation' and e.seed_category = 'consolation_champion_after_bye'
        and e.received_bye_history is distinct from true)
  ) then raise exception 'INVALID_SEED_CATEGORY_OR_HISTORY'; end if;

  if exists (
    select 1 from (
      select e.seed_num,
        array_position(
          case when p_tournament_type = 'championship'
            then array['first_place_and_division_champion','first_place_not_division_champion','below_first_division_champion']::text[]
            else array['consolation_champion_back_to_back_wins','consolation_champion_after_bye']::text[]
          end,
          e.seed_category
        ) as category_order,
        lag(array_position(
          case when p_tournament_type = 'championship'
            then array['first_place_and_division_champion','first_place_not_division_champion','below_first_division_champion']::text[]
            else array['consolation_champion_back_to_back_wins','consolation_champion_after_bye']::text[]
          end,
          e.seed_category
        )) over (order by e.seed_num) as prior_category
      from jsonb_to_recordset(p_entries) as e(
        team_id uuid, division_id uuid, seed_num integer, seed_category text,
        seed_category_source text, division_position integer, received_bye_history boolean
      )
    ) ordered
    where ordered.category_order < ordered.prior_category
  ) then raise exception 'SEED_CATEGORY_ORDER_INVALID'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_matches) as m(
      match_key text, round_num integer, slot_num integer, team_home_id uuid,
      team_away_id uuid, winner_team_id uuid, is_bye boolean,
      feeds_into_match_key text, feeds_into_slot text
    )
    where (m.team_home_id is not null and not exists (
        select 1 from jsonb_to_recordset(p_entries) as e(
          team_id uuid, division_id uuid, seed_num integer, seed_category text,
          seed_category_source text, division_position integer, received_bye_history boolean
        ) where e.team_id = m.team_home_id
      ))
      or (m.team_away_id is not null and not exists (
        select 1 from jsonb_to_recordset(p_entries) as e(
          team_id uuid, division_id uuid, seed_num integer, seed_category text,
          seed_category_source text, division_position integer, received_bye_history boolean
        ) where e.team_id = m.team_away_id
      ))
      or (m.winner_team_id is not null and m.winner_team_id not in (m.team_home_id, m.team_away_id))
      or (m.is_bye is true and not (
        ((m.team_home_id is null) <> (m.team_away_id is null))
        and m.winner_team_id = coalesce(m.team_home_id, m.team_away_id)
      ))
  ) then raise exception 'INVALID_MATCH_PARTICIPANT_OR_BYE'; end if;

  if v_team_count > 1 then
    if (
      select count(*) from (
        select team_home_id as team_id
        from jsonb_to_recordset(p_matches) as m(
          match_key text, round_num integer, slot_num integer, team_home_id uuid,
          team_away_id uuid, winner_team_id uuid, is_bye boolean,
          feeds_into_match_key text, feeds_into_slot text
        ) where m.round_num = 1 and m.team_home_id is not null
        union all
        select team_away_id
        from jsonb_to_recordset(p_matches) as m(
          match_key text, round_num integer, slot_num integer, team_home_id uuid,
          team_away_id uuid, winner_team_id uuid, is_bye boolean,
          feeds_into_match_key text, feeds_into_slot text
        ) where m.round_num = 1 and m.team_away_id is not null
      ) first_round
    ) <> v_team_count
    or (
      select count(distinct team_id) from (
        select team_home_id as team_id
        from jsonb_to_recordset(p_matches) as m(
          match_key text, round_num integer, slot_num integer, team_home_id uuid,
          team_away_id uuid, winner_team_id uuid, is_bye boolean,
          feeds_into_match_key text, feeds_into_slot text
        ) where m.round_num = 1 and m.team_home_id is not null
        union all
        select team_away_id
        from jsonb_to_recordset(p_matches) as m(
          match_key text, round_num integer, slot_num integer, team_home_id uuid,
          team_away_id uuid, winner_team_id uuid, is_bye boolean,
          feeds_into_match_key text, feeds_into_slot text
        ) where m.round_num = 1 and m.team_away_id is not null
      ) first_round
    ) <> v_team_count
    then raise exception 'FIRST_ROUND_ENTRIES_MUST_APPEAR_EXACTLY_ONCE'; end if;
  elsif p_champion_team_id is distinct from (
    select e.team_id from jsonb_to_recordset(p_entries) as e(
      team_id uuid, division_id uuid, seed_num integer, seed_category text,
      seed_category_source text, division_position integer, received_bye_history boolean
    ) limit 1
  ) then
    raise exception 'SINGLE_TEAM_CHAMPION_MISMATCH';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_matches) as m(
      match_key text, round_num integer, slot_num integer, team_home_id uuid,
      team_away_id uuid, winner_team_id uuid, is_bye boolean,
      feeds_into_match_key text, feeds_into_slot text
    )
    where m.match_key is null or m.round_num < 1 or m.slot_num < 1
      or (m.feeds_into_match_key is not null and not exists (
        select 1 from jsonb_to_recordset(p_matches) as target(
          match_key text, round_num integer, slot_num integer, team_home_id uuid,
          team_away_id uuid, winner_team_id uuid, is_bye boolean,
          feeds_into_match_key text, feeds_into_slot text
        ) where target.match_key = m.feeds_into_match_key
          and target.round_num > m.round_num
      ))
      or (m.feeds_into_match_key is not null and m.feeds_into_slot not in ('home','away'))
  ) then raise exception 'INVALID_MATCH_FEED'; end if;

  if exists (
    select 1 from public.seasonal_tournaments t
    where t.season_id = p_season_id and t.tournament_type = p_tournament_type
  ) then raise exception 'TOURNAMENT_ALREADY_EXISTS'; end if;

  insert into public.seasonal_tournaments (
    season_id, tournament_type, status, champion_team_id, confirmed_by
  ) values (
    p_season_id, p_tournament_type,
    case when v_team_count = 1 then 'completed' else 'confirmed' end,
    p_champion_team_id, v_profile_id
  ) returning id into v_tournament_id;

  insert into public.seasonal_tournament_entries (
    tournament_id, team_id, division_id, seed_num, seed_category,
    seed_category_source, division_position, received_bye_history
  )
  select v_tournament_id, e.team_id, e.division_id, e.seed_num, e.seed_category,
    e.seed_category_source, e.division_position, e.received_bye_history
  from jsonb_to_recordset(p_entries) as e(
    team_id uuid, division_id uuid, seed_num integer, seed_category text,
    seed_category_source text, division_position integer, received_bye_history boolean
  );

  insert into public.seasonal_tournament_matches (
    tournament_id, match_key, round_num, slot_num, team_home_id, team_away_id,
    winner_team_id, is_bye, status
  )
  select v_tournament_id, m.match_key, m.round_num, m.slot_num, m.team_home_id, m.team_away_id,
    m.winner_team_id, coalesce(m.is_bye,false),
    case when coalesce(m.is_bye,false) then 'bye' else 'pending' end
  from jsonb_to_recordset(p_matches) as m(
    match_key text, round_num integer, slot_num integer, team_home_id uuid,
    team_away_id uuid, winner_team_id uuid, is_bye boolean,
    feeds_into_match_key text, feeds_into_slot text
  );

  update public.seasonal_tournament_matches source
  set feeds_into_match_id = target.id,
      feeds_into_slot = payload.feeds_into_slot
  from jsonb_to_recordset(p_matches) as payload(
    match_key text, round_num integer, slot_num integer, team_home_id uuid,
    team_away_id uuid, winner_team_id uuid, is_bye boolean,
    feeds_into_match_key text, feeds_into_slot text
  )
  join public.seasonal_tournament_matches target
    on target.tournament_id = v_tournament_id
   and target.match_key = payload.feeds_into_match_key
  where source.tournament_id = v_tournament_id
    and source.match_key = payload.match_key
    and payload.feeds_into_match_key is not null;

  return v_tournament_id;
end;
$function$;

revoke all on function public.create_seasonal_tournament(uuid, text, jsonb, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.create_seasonal_tournament(uuid, text, jsonb, jsonb, uuid)
  to authenticated;

comment on table public.seasonal_tournaments is
  'Manager-confirmed season-wide Championship and Consolation tournament records; separate from division playoffs.';
comment on table public.seasonal_tournament_entries is
  'Immutable manager-confirmed seasonal tournament seeds and their rulebook seeding evidence.';
comment on table public.seasonal_tournament_matches is
  'Seasonal single-elimination bracket graph. Match scheduling and live scoring are linked in a later workflow.';

commit;
