-- Staging-only integration regression test for role authorization.
--
-- This script runs inside an explicit transaction and rolls back all mutations.
-- Run only in a staging Supabase project with active manager, captain, player,
-- and non-member test profiles, plus a scheduled pairing and an older completed
-- match. It intentionally raises an exception if the required fixtures are
-- missing or any expected authorization result changes.
--
-- It uses JWT claim settings to exercise auth.uid() while the SQL Editor runs
-- the script with its administrative connection. Do not treat static contract
-- tests as a substitute for this live PostgreSQL test.

begin;

do $test$
declare
  v_manager uuid;
  v_captain uuid;
  v_player uuid;
  v_nonmember uuid;
  v_team_id uuid;
  v_pairing_id uuid;
  v_home_id uuid;
  v_away_id uuid;
  v_match_id uuid;
  v_state jsonb;
  v_ok boolean;
  v_reason text;
begin
  select id into v_manager from public.profiles
    where role = 'manager' and is_active
    order by created_at limit 1;
  select id into v_captain from public.profiles
    where role = 'captain' and is_active
    order by created_at limit 1;
  select id into v_player from public.profiles
    where role = 'player' and is_active
    order by created_at limit 1;

  if v_manager is null or v_captain is null or v_player is null then
    raise exception 'FIXTURES_REQUIRED: create active manager, captain, and player profiles in staging';
  end if;

  select p.id into v_nonmember
  from public.profiles p
  where p.role = 'player' and p.is_active
    and p.id <> v_player
    and not exists (
      select 1 from public.profile_team_memberships m
      where m.profile_id = p.id and m.ended_at is null
    )
    and (p.player_num is null or not exists (
      select 1 from public.rosters r where r.player_num = p.player_num
    ))
  order by p.created_at
  limit 1;

  if v_nonmember is null then
    raise exception 'FIXTURES_REQUIRED: create an active player test account with no active team membership or roster link';
  end if;

  select id into v_team_id from public.teams order by id limit 1;
  if v_team_id is null then raise exception 'FIXTURES_REQUIRED: at least one team is required'; end if;

  -- Create or reuse a manager-owned membership within the test transaction.
  -- Any changes are rolled back at the end.
  insert into public.profile_team_memberships(profile_id, team_id)
  values (v_manager, v_team_id)
  on conflict (profile_id, team_id) where ended_at is null do nothing;

  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager::text, 'role', 'authenticated')::text, true);
  select r.ok, r.reason into v_ok, v_reason
  from public.remove_own_team_membership(v_team_id) r;
  if v_ok is distinct from true then
    raise exception 'FAIL manager removes own membership: %, %', v_ok, v_reason;
  end if;

  -- Captains and players must not use the manager-only self-service RPC.
  perform set_config('request.jwt.claim.sub', v_captain::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_captain::text, 'role', 'authenticated')::text, true);
  select r.ok, r.reason into v_ok, v_reason
  from public.remove_own_team_membership(v_team_id) r;
  if v_ok is distinct from false or v_reason is distinct from 'MANAGER_ONLY' then
    raise exception 'FAIL captain denied manager-only membership removal: %, %', v_ok, v_reason;
  end if;

  perform set_config('request.jwt.claim.sub', v_player::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_player::text, 'role', 'authenticated')::text, true);
  select r.ok, r.reason into v_ok, v_reason
  from public.remove_own_team_membership(v_team_id) r;
  if v_ok is distinct from false or v_reason is distinct from 'MANAGER_ONLY' then
    raise exception 'FAIL player denied manager-only membership removal: %, %', v_ok, v_reason;
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
  select r.ok, r.reason into v_ok, v_reason
  from public.remove_own_team_membership(v_team_id) r;
  if v_ok is distinct from false or v_reason is distinct from 'AUTH_REQUIRED' then
    raise exception 'FAIL anonymous membership removal denied: %, %', v_ok, v_reason;
  end if;

  -- Find a pairing neither the non-member nor their player number belongs to.
  select sp.id, sp.home_team_id, sp.away_team_id
    into v_pairing_id, v_home_id, v_away_id
  from public.schedule_pairings sp
  where not exists (
      select 1 from public.profile_team_memberships m
      where m.profile_id = v_nonmember and m.ended_at is null
        and m.team_id in (sp.home_team_id, sp.away_team_id)
    )
    and not exists (
      select 1 from public.rosters r
      where r.player_num = (select player_num from public.profiles where id = v_nonmember)
        and r.team_id in (sp.home_team_id, sp.away_team_id)
    )
    and not exists (select 1 from public.live_match lm where lm.id = sp.id)
  order by sp.id
  limit 1;

  if v_pairing_id is null then
    raise exception 'FIXTURES_REQUIRED: a scheduled pairing with no live_match row and no non-member connection is required';
  end if;

  v_state := jsonb_build_object(
    'teamHome', jsonb_build_object('id', v_home_id::text),
    'teamAway', jsonb_build_object('id', v_away_id::text),
    'sets', '[]'::jsonb
  );

  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager::text, 'role', 'authenticated')::text, true);
  select public.write_live_match_state(v_pairing_id, v_state, null) into v_ok;
  if v_ok is distinct from true then
    raise exception 'FAIL manager can create live state for scheduled pairing';
  end if;

  perform set_config('request.jwt.claim.sub', v_nonmember::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_nonmember::text, 'role', 'authenticated')::text, true);
  select public.write_live_match_state(v_pairing_id, v_state, null) into v_ok;
  if v_ok is distinct from false then
    raise exception 'FAIL unrelated non-member cannot create/update live state';
  end if;

  -- Even a manager may not change the scheduled home/away teams through state.
  v_state := jsonb_set(v_state, '{teamHome,id}', to_jsonb(v_away_id::text));
  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager::text, 'role', 'authenticated')::text, true);
  select public.write_live_match_state(v_pairing_id, v_state, null) into v_ok;
  if v_ok is distinct from false then
    raise exception 'FAIL live state cannot substitute different scheduled teams';
  end if;

  select cm.id into v_match_id
  from public.completed_matches cm
  where cm.reopened_at is null
    and (cm.confirmed_at is null or cm.confirmed_at::date <> current_date)
    and (
      case when cm.week_date ~ '^\d{1,2}/\d{1,2}/\d{4}$'
        then to_date(cm.week_date, 'MM/DD/YYYY') <> current_date
        else true
      end
    )
  order by cm.id
  limit 1;

  if v_match_id is null then
    raise exception 'FIXTURES_REQUIRED: an older completed match that is not already reopened is required';
  end if;

  perform set_config('request.jwt.claim.sub', v_nonmember::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_nonmember::text, 'role', 'authenticated')::text, true);
  select r.ok, r.reason into v_ok, v_reason
  from public.reopen_match_for_editing(v_match_id) r;
  if v_ok is distinct from false or v_reason is distinct from 'NOT_ALLOWED' then
    raise exception 'FAIL non-member cannot reopen a completed match: %, %', v_ok, v_reason;
  end if;

  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager::text, 'role', 'authenticated')::text, true);
  select r.ok, r.reason into v_ok, v_reason
  from public.reopen_match_for_editing(v_match_id) r;
  if v_ok is distinct from true then
    raise exception 'FAIL manager can reopen a completed match: %, %', v_ok, v_reason;
  end if;

  raise notice 'PASS: membership removal, live scoring authorization, scheduled-team integrity, and match reopening role checks';
end;
$test$;

rollback;
