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
  v_team_a uuid;
  v_team_b uuid;
  v_team_c uuid;
  v_team_d uuid;
  v_mixed_profile uuid;
  v_multi_captain uuid;
  v_test_player_num text;
  v_other_player_num text;
  v_invite_code text;
  v_conflict_invite_code text;
  v_existing_player_num text;
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
    and p.player_num is null
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


  -- Mixed-role regression: memberships and captain assignments are distinct.
  -- Use disposable assignments in this transaction; rollback restores every
  -- prior captain and membership. Team A is player-only, B/C are captained.
  select id into v_team_a from public.teams order by id offset 0 limit 1;
  select id into v_team_b from public.teams where id <> v_team_a order by id limit 1;
  select id into v_team_c from public.teams where id not in (v_team_a, v_team_b) order by id limit 1;
  select id into v_team_d from public.teams where id not in (v_team_a, v_team_b, v_team_c) order by id limit 1;
  if v_team_a is null or v_team_b is null or v_team_c is null or v_team_d is null then
    raise exception 'FIXTURES_REQUIRED: four teams are required for mixed-role captain coverage';
  end if;

  select id into v_mixed_profile from public.profiles
    where is_active and role = 'player' order by created_at limit 1;
  select id into v_multi_captain from public.profiles
    where is_active and role = 'captain' order by created_at limit 1;
  if v_mixed_profile is null or v_multi_captain is null then
    raise exception 'FIXTURES_REQUIRED: active player and captain profiles are required for mixed-role coverage';
  end if;

  -- A captain remains an ordinary roster player on other teams. The
  -- profile-level role is captain because the account holds a captain seat.
  update public.profiles set role = 'captain' where id = v_mixed_profile;

  insert into public.profile_team_memberships(profile_id, team_id)
  values
    (v_mixed_profile, v_team_a),
    (v_mixed_profile, v_team_b),
    (v_multi_captain, v_team_a),
    (v_multi_captain, v_team_b),
    (v_multi_captain, v_team_c),
    (v_multi_captain, v_team_d)
  on conflict (profile_id, team_id) where ended_at is null do nothing;

  update public.teams set captain_profile_id = null
    where id in (v_team_a, v_team_b, v_team_c, v_team_d);
  update public.teams set captain_profile_id = v_mixed_profile where id = v_team_b;
  update public.teams set captain_profile_id = v_multi_captain where id in (v_team_c, v_team_d);

  perform set_config('request.jwt.claim.sub', v_mixed_profile::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_mixed_profile::text, 'role', 'authenticated')::text, true);
  if public.is_on_team(v_team_a) is distinct from true
     or public.is_on_team(v_team_b) is distinct from true
     or public.is_team_captain(v_team_a) is distinct from false
     or public.is_team_captain(v_team_b) is distinct from true then
    raise exception 'FAIL mixed player/captain: player must belong to A/B but captain only B';
  end if;

  perform set_config('request.jwt.claim.sub', v_multi_captain::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_multi_captain::text, 'role', 'authenticated')::text, true);
  if public.is_on_team(v_team_a) is distinct from true
     or public.is_team_captain(v_team_c) is distinct from true
     or public.is_team_captain(v_team_d) is distinct from true
     or public.is_team_captain(v_team_b) is distinct from false then
    raise exception 'FAIL multiple captain teams: captain assignment must cover C/D, not B, while retaining player membership on A/B/C/D';
  end if;


  -- Managers retain their manager role and permissions even when they also
  -- have a player membership and a team captain assignment.
  insert into public.profile_team_memberships(profile_id, team_id)
  values (v_manager, v_team_a)
  on conflict (profile_id, team_id) where ended_at is null do nothing;
  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager::text, 'role', 'authenticated')::text, true);
  select public.assign_team_captain(v_team_a, v_manager) into v_ok;
  if v_ok is distinct from true
     or public.current_role_name() is distinct from 'manager'
     or not exists (select 1 from public.teams where id = v_team_a and captain_profile_id = v_manager)
     or public.is_on_team(v_team_a) is distinct from true then
    raise exception 'FAIL assigning a captain seat must preserve manager role and player membership';
  end if;

  select public.remove_team_captain(v_team_a, v_manager) into v_ok;
  if v_ok is distinct from true
     or public.current_role_name() is distinct from 'manager'
     or exists (select 1 from public.teams where id = v_team_a and captain_profile_id = v_manager)
     or not exists (
       select 1 from public.profile_team_memberships
       where profile_id = v_manager and team_id = v_team_a and ended_at is null
     ) then
    raise exception 'FAIL removing a manager captain seat must preserve manager role and player membership';
  end if;

  -- An explicit account-level demotion to Player with no team selected removes
  -- every captain seat, but does not remove the user's player memberships.
  select public.assign_team_captain(v_team_a, v_manager) into v_ok;
  select public.assign_team_captain(v_team_b, v_manager) into v_ok;
  select public.set_profile_role(v_manager, 'player', null) into v_ok;
  if v_ok is distinct from true
     or public.current_role_name() is distinct from 'player'
     or exists (select 1 from public.teams where captain_profile_id = v_manager)
     or not exists (
       select 1 from public.profile_team_memberships
       where profile_id = v_manager and team_id = v_team_a and ended_at is null
     )
     or not exists (
       select 1 from public.profile_team_memberships
       where profile_id = v_manager and team_id = v_team_b and ended_at is null
     ) then
    raise exception 'FAIL account-level Player demotion must clear captain seats but retain all player memberships';
  end if;


  -- A non-manager cannot directly claim a player number. Player-number
  -- linking is performed through a trusted invite whose player_num is stored
  -- in the database, not through user-editable signup metadata.
  select pl.num into v_test_player_num
  from public.players pl
  where not exists (select 1 from public.profiles p where p.player_num = pl.num)
  order by pl.num
  limit 1;
  select p.player_num into v_other_player_num
  from public.profiles p
  where p.id <> v_nonmember and p.player_num is not null
  order by p.id
  limit 1;
  if v_test_player_num is null or v_other_player_num is null then
    raise exception 'FIXTURES_REQUIRED: one unlinked player record and one already-linked profile are required for player-number authorization coverage';
  end if;

  -- A player-specific invite links the server-stored number and team. The
  -- profile cannot supply a different number through editable signup metadata.
  v_invite_code := 'ROLE-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
  insert into public.invite_codes(code, role, team_id, player_num, expires_at, label_name)
  values (v_invite_code, 'player', v_team_id, v_test_player_num, now() + interval '1 day', 'role-matrix player link');
  perform set_config('request.jwt.claim.sub', v_nonmember::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_nonmember::text, 'role', 'authenticated')::text, true);
  perform public.claim_invite_code(v_invite_code);
  if (select player_num from public.profiles where id = v_nonmember) is distinct from v_test_player_num
     or not exists (
       select 1 from public.profile_team_memberships
       where profile_id = v_nonmember and team_id = v_team_id and ended_at is null
     )
     or not exists (
       select 1 from public.invite_codes
       where code = v_invite_code and used_by = v_nonmember and used_at is not null
     ) then
    raise exception 'FAIL trusted player invite must link only its stored player number and team';
  end if;

  -- An invite cannot link a player number already claimed by another
  -- profile, and the rejected invite remains unused.
  v_conflict_invite_code := 'ROLE-' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
  insert into public.invite_codes(code, role, team_id, player_num, expires_at, label_name)
  values (v_conflict_invite_code, 'player', v_team_id, v_other_player_num, now() + interval '1 day', 'role-matrix claimed-number conflict');
  begin
    perform public.claim_invite_code(v_conflict_invite_code);
    raise exception 'FAIL a different player invite must not replace an existing player number';
  exception when others then
    if sqlerrm <> 'PLAYER_ALREADY_CLAIMED' then
      raise;
    end if;
  end;
  if (select player_num from public.profiles where id = v_nonmember) is distinct from v_test_player_num
     or exists (
       select 1 from public.invite_codes
       where code = v_conflict_invite_code and used_at is not null
     ) then
    raise exception 'FAIL invite for an already-claimed player number must preserve identity and leave invite unused';
  end if;

  perform set_config('request.jwt.claim.sub', v_manager::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_manager::text, 'role', 'authenticated')::text, true);
  begin
    perform public.set_own_player_number(v_test_player_num);
    raise exception 'FAIL non-manager must not self-assign a player number';
  exception when others then
    if sqlerrm <> 'PLAYER_NUMBER_REQUIRES_MANAGER_OR_INVITE' then
      raise;
    end if;
  end;

  select player_num into v_existing_player_num
  from public.profiles where id = v_manager;
  update public.profiles
  set player_num = v_test_player_num
  where id = v_manager;
  if (select player_num from public.profiles where id = v_manager)
     is distinct from v_existing_player_num then
    raise exception 'FAIL profile protection trigger must block direct player-number changes by non-managers';
  end if;

  raise notice 'PASS: membership removal, live scoring authorization, scheduled-team integrity, match reopening, mixed player/captain roles, manager role retention, and player-number identity protection';
end;
$test$;

rollback;
