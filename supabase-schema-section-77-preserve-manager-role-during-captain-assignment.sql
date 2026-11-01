-- Section 77: preserve manager authority when a manager is also a team captain
--
-- Captain assignments are team-specific (teams.captain_profile_id). The
-- profiles.role column remains the account-level authority role. Assigning or
-- claiming a captain seat must not downgrade an existing manager account.
-- Explicitly changing an account to Player with no team selected removes all
-- of that profile's captain assignments so UI and database authorization stay
-- in sync. Removing one captain seat leaves other captain seats and player
-- memberships intact.

create or replace function public.assign_team_captain(p_team_id uuid, p_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_previous_captain uuid;
begin
  if current_role_name() is distinct from 'manager' then
    raise exception 'MANAGER_ONLY';
  end if;
  if not exists (select 1 from public.teams where id = p_team_id) then
    raise exception 'TEAM_NOT_FOUND';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile_id and is_active) then
    raise exception 'PROFILE_NOT_FOUND';
  end if;

  select captain_profile_id into v_previous_captain
  from public.teams
  where id = p_team_id
  for update;

  insert into public.profile_team_memberships (profile_id, team_id)
  values (p_profile_id, p_team_id)
  on conflict (profile_id, team_id) where ended_at is null do nothing;

  update public.teams
  set captain_profile_id = p_profile_id
  where id = p_team_id;

  update public.captaincy_history
  set ended_at = now()
  where team_id = p_team_id
    and ended_at is null
    and profile_id is distinct from p_profile_id;

  if v_previous_captain is not null
     and v_previous_captain is distinct from p_profile_id
     and not exists (
       select 1 from public.teams
       where captain_profile_id = v_previous_captain
     ) then
    update public.profiles
    set role = 'player'
    where id = v_previous_captain
      and role = 'captain';
  end if;

  -- Keep manager as the account-level role while recording the team-specific
  -- captain assignment in teams.captain_profile_id.
  update public.profiles
  set role = case when role = 'manager' then 'manager' else 'captain' end,
      is_claimed = true
  where id = p_profile_id;

  insert into public.captaincy_history (team_id, profile_id, started_at)
  select p_team_id, p_profile_id, now()
  where not exists (
    select 1 from public.captaincy_history
    where team_id = p_team_id
      and profile_id = p_profile_id
      and ended_at is null
  );

  return true;
end;
$function$;

create or replace function public.claim_invite_code(p_code text)
returns table(role text, team_id uuid)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_invite public.invite_codes%rowtype;
  v_user_id uuid := auth.uid();
  v_previous_captain uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_invite
  from public.invite_codes
  where code = upper(p_code)
    and used_at is null
    and expires_at > now();

  if v_invite.code is null then
    raise exception 'Invalid or expired invite code';
  end if;

  update public.profiles
  set is_claimed = true,
      player_num = coalesce(v_invite.player_num, player_num)
  where id = v_user_id;

  if v_invite.team_id is not null then
    insert into public.profile_team_memberships (profile_id, team_id)
    values (v_user_id, v_invite.team_id)
    on conflict (profile_id, team_id) where ended_at is null do nothing;

    if v_invite.role = 'captain' then
      select captain_profile_id into v_previous_captain
      from public.teams
      where id = v_invite.team_id
      for update;

      update public.teams
      set captain_profile_id = v_user_id
      where id = v_invite.team_id;

      update public.captaincy_history
      set ended_at = now()
      where team_id = v_invite.team_id
        and ended_at is null
        and profile_id is distinct from v_user_id;

      if v_previous_captain is not null
         and v_previous_captain is distinct from v_user_id
         and not exists (
           select 1 from public.teams
           where captain_profile_id = v_previous_captain
         ) then
        update public.profiles
        set role = 'player'
        where id = v_previous_captain
          and role = 'captain';
      end if;

      -- A captain invite adds a team assignment, not a replacement for the
      -- recipient's existing manager authority.
      update public.profiles
      set role = case when role = 'manager' then 'manager' else 'captain' end
      where id = v_user_id;

      insert into public.captaincy_history (team_id, profile_id, started_at)
      select v_invite.team_id, v_user_id, now()
      where not exists (
        select 1 from public.captaincy_history
        where team_id = v_invite.team_id
          and profile_id = v_user_id
          and ended_at is null
      );
    end if;
  end if;

  update public.invite_codes
  set used_at = now(),
      used_by = v_user_id
  where code = v_invite.code;

  return query select v_invite.role, v_invite.team_id;
end;
$function$;

create or replace function public.set_profile_role(
  p_profile_id uuid,
  p_role text,
  p_team_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_team_id uuid;
begin
  if current_role_name() is distinct from 'manager' then
    raise exception 'MANAGER_ONLY';
  end if;
  if p_role not in ('player', 'captain', 'manager') then
    raise exception 'INVALID_ROLE';
  end if;

  if p_role = 'captain' then
    if p_team_id is null then
      raise exception 'CAPTAIN_TEAM_REQUIRED';
    end if;
    return public.assign_team_captain(p_team_id, p_profile_id);
  end if;

  if p_role = 'player' then
    if p_team_id is not null then
      return public.remove_team_captain(p_team_id, p_profile_id);
    end if;

    -- No team supplied means an explicit account-level demotion: remove all
    -- captain seats, but preserve every player membership and its history.
    for v_team_id in
      select id
      from public.teams
      where captain_profile_id = p_profile_id
      order by id
    loop
      perform public.remove_team_captain(v_team_id, p_profile_id);
    end loop;

    update public.profiles
    set role = 'player',
        is_claimed = true
    where id = p_profile_id;

    return found;
  end if;

  update public.profiles
  set role = 'manager',
      is_claimed = true
  where id = p_profile_id;

  return found;
end;
$function$;

-- Keep these RPCs available only to authenticated callers; each function
-- performs its own manager/authentication checks.
revoke all on function public.assign_team_captain(uuid, uuid) from public, anon;
grant execute on function public.assign_team_captain(uuid, uuid) to authenticated;

revoke all on function public.claim_invite_code(text) from public, anon;
grant execute on function public.claim_invite_code(text) to authenticated;

revoke all on function public.set_profile_role(uuid, text, uuid) from public, anon;
grant execute on function public.set_profile_role(uuid, text, uuid) to authenticated;
