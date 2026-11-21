-- Section 104: manager-approved reconciliation of seasonal tournament brackets.
-- Rebuilds only unplayed slots. Completed/in-progress matches are immutable.
-- If a completed result cannot be carried into the proposed bracket safely, the
-- transaction fails and leaves the saved bracket untouched.

begin;

create or replace function public.reconcile_seasonal_tournament(
  p_tournament_id uuid,
  p_entries jsonb,
  p_matches jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tournament public.seasonal_tournaments%rowtype;
  v_existing_count integer;
  v_incoming_count integer;
  v_has_recorded_matches boolean;
  v_match record;
  v_target_key text;
  v_target_slot text;
  v_target_match public.seasonal_tournament_matches%rowtype;
  v_proposed jsonb;
  v_current_slot uuid;
  v_updated integer := 0;
begin
  if (select auth.uid()) is null
     or (select public.current_role_name()) is distinct from 'manager' then
    raise exception 'MANAGER_ONLY' using errcode = '42501';
  end if;

  if jsonb_typeof(p_entries) is distinct from 'array'
     or jsonb_typeof(p_matches) is distinct from 'array' then
    raise exception 'ENTRIES_AND_MATCHES_MUST_BE_ARRAYS';
  end if;

  select * into v_tournament
    from public.seasonal_tournaments
   where id = p_tournament_id
   for update;

  if not found then raise exception 'SEASONAL_TOURNAMENT_NOT_FOUND'; end if;
  if v_tournament.status <> 'needs_review' then
    raise exception 'TOURNAMENT_DOES_NOT_REQUIRE_REVIEW';
  end if;

  select count(*) into v_existing_count
    from public.seasonal_tournament_matches
   where tournament_id = p_tournament_id;
  select count(*) into v_incoming_count
    from jsonb_array_elements(p_matches);
  if v_existing_count <> v_incoming_count then
    raise exception 'BRACKET_LAYOUT_CHANGED_REQUIRES_MANUAL_REVIEW';
  end if;

  if exists (
    select 1
      from public.seasonal_tournament_matches old_match
     where old_match.tournament_id = p_tournament_id
       and not exists (
         select 1
           from jsonb_to_recordset(p_matches) as incoming(
             match_key text, round_num integer, slot_num integer
           )
          where incoming.match_key = old_match.match_key
            and incoming.round_num = old_match.round_num
            and incoming.slot_num = old_match.slot_num
       )
  ) or exists (
    select 1
      from jsonb_to_recordset(p_matches) as incoming(
        match_key text, round_num integer, slot_num integer
      )
     where not exists (
       select 1
         from public.seasonal_tournament_matches old_match
        where old_match.tournament_id = p_tournament_id
          and old_match.match_key = incoming.match_key
          and old_match.round_num = incoming.round_num
          and old_match.slot_num = incoming.slot_num
     )
  ) then
    raise exception 'BRACKET_LAYOUT_CHANGED_REQUIRES_MANUAL_REVIEW';
  end if;

  select exists (
    select 1 from public.seasonal_tournament_matches
     where tournament_id = p_tournament_id
       and status in ('completed', 'in_progress')
  ) into v_has_recorded_matches;

  if v_has_recorded_matches then
    if exists (
      select 1
        from public.seasonal_tournament_entries old_entry
       where old_entry.tournament_id = p_tournament_id
         and not exists (
           select 1
             from jsonb_to_recordset(p_entries) as incoming(
               team_id uuid, division_id uuid, seed_num integer,
               seed_category text
             )
            where incoming.team_id = old_entry.team_id
              and incoming.division_id = old_entry.division_id
              and incoming.seed_num = old_entry.seed_num
              and incoming.seed_category = old_entry.seed_category
         )
    ) or exists (
      select 1
        from jsonb_to_recordset(p_entries) as incoming(
          team_id uuid, division_id uuid, seed_num integer,
          seed_category text
        )
       where not exists (
         select 1
           from public.seasonal_tournament_entries old_entry
          where old_entry.tournament_id = p_tournament_id
            and old_entry.team_id = incoming.team_id
            and old_entry.division_id = incoming.division_id
            and old_entry.seed_num = incoming.seed_num
            and old_entry.seed_category = incoming.seed_category
       )
    ) then
      raise exception 'QUALIFIED_ENTRIES_CHANGED_AFTER_RESULTS_RECORDED';
    end if;
  else
    delete from public.seasonal_tournament_entries
     where tournament_id = p_tournament_id;

    insert into public.seasonal_tournament_entries (
      tournament_id, team_id, division_id, seed_num, seed_category,
      seed_category_source, division_position, received_bye_history
    )
    select p_tournament_id, incoming.team_id, incoming.division_id,
           incoming.seed_num, incoming.seed_category,
           coalesce(incoming.seed_category_source, 'rulebook_derived'),
           incoming.division_position, incoming.received_bye_history
      from jsonb_to_recordset(p_entries) as incoming(
        team_id uuid, division_id uuid, seed_num integer, seed_category text,
        seed_category_source text, division_position integer,
        received_bye_history boolean
      );
  end if;

  -- Recorded matches must retain their participants and bye shape exactly.
  if exists (
    select 1
      from public.seasonal_tournament_matches saved
      join jsonb_to_recordset(p_matches) as incoming(
        match_key text, team_home_id uuid, team_away_id uuid, is_bye boolean
      ) on incoming.match_key = saved.match_key
     where saved.tournament_id = p_tournament_id
       and saved.status in ('completed', 'in_progress')
       and (
         saved.team_home_id is distinct from incoming.team_home_id
         or saved.team_away_id is distinct from incoming.team_away_id
         or saved.is_bye is distinct from coalesce(incoming.is_bye, false)
       )
  ) then
    raise exception 'RECORDED_MATCH_PARTICIPANTS_CHANGED';
  end if;

  v_proposed := p_matches;

  -- Carry every completed/in-progress winner into its existing downstream slot.
  -- If the proposed structure would contradict that recorded result, fail closed.
  for v_match in
    select * from public.seasonal_tournament_matches
     where tournament_id = p_tournament_id
       and status in ('completed', 'in_progress')
       and feeds_into_match_id is not null
  loop
    select match_key into v_target_key
      from public.seasonal_tournament_matches
     where id = v_match.feeds_into_match_id;

    v_target_slot := case when v_match.feeds_into_slot = 'home'
      then 'team_home_id' else 'team_away_id' end;

    select * into v_target_match
      from public.seasonal_tournament_matches
     where id = v_match.feeds_into_match_id;

    v_current_slot := case when v_match.feeds_into_slot = 'home'
      then v_target_match.team_home_id else v_target_match.team_away_id end;

    if v_current_slot is not null and v_current_slot <> v_match.winner_team_id then
      raise exception 'RECORDED_WINNER_CONFLICTS_WITH_ADVANCEMENT';
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_proposed) as proposed(item)
       where item->>'match_key' = v_target_key
         and nullif(item->>v_target_slot, '') is not null
         and (item->>v_target_slot)::uuid <> v_match.winner_team_id
    ) then
      raise exception 'RECORDED_WINNER_CONFLICTS_WITH_PROPOSED_BRACKET';
    end if;

    select coalesce(jsonb_agg(
      case when item->>'match_key' = v_target_key
        then jsonb_set(item, array[v_target_slot], to_jsonb(v_match.winner_team_id::text), true)
        else item end
      order by ordinality
    ), '[]'::jsonb)
      into v_proposed
      from jsonb_array_elements(v_proposed) with ordinality as rows(item, ordinality);
  end loop;

  -- Completed and in-progress records are intentionally skipped.
  update public.seasonal_tournament_matches saved
     set team_home_id = incoming.team_home_id,
         team_away_id = incoming.team_away_id,
         winner_team_id = case when incoming.is_bye then
           coalesce(incoming.team_home_id, incoming.team_away_id)
           else null end,
         is_bye = coalesce(incoming.is_bye, false),
         status = case when coalesce(incoming.is_bye, false) then 'bye' else 'pending' end,
         updated_at = now()
    from jsonb_to_recordset(v_proposed) as incoming(
      match_key text, team_home_id uuid, team_away_id uuid, is_bye boolean
    )
   where saved.tournament_id = p_tournament_id
     and saved.match_key = incoming.match_key
     and saved.status not in ('completed', 'in_progress');

  get diagnostics v_updated = row_count;

  update public.seasonal_tournaments
     set status = case when exists (
       select 1 from public.seasonal_tournament_matches
        where tournament_id = p_tournament_id and status in ('completed', 'in_progress')
     ) then 'in_progress' else 'confirmed' end,
         champion_team_id = case when jsonb_array_length(p_entries) = 1
           then (p_entries->0->>'team_id')::uuid else null end,
         review_required_at = null,
         review_reason = null,
         updated_at = now()
   where id = p_tournament_id;

  return jsonb_build_object(
    'ok', true,
    'updated_unplayed_matches', v_updated,
    'preserved_recorded_matches', (
      select count(*) from public.seasonal_tournament_matches
       where tournament_id = p_tournament_id
         and status in ('completed', 'in_progress')
    )
  );
end;
$function$;

revoke all on function public.reconcile_seasonal_tournament(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.reconcile_seasonal_tournament(uuid, jsonb, jsonb)
  to authenticated;

commit;
