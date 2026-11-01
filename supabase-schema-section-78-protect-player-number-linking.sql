-- Section 78: protect player-number identity linking
--
-- A player number identifies a real league player and can unlock roster-based
-- team access. Never accept it from user-editable auth metadata or a direct
-- self-service RPC. A player number is linked by a manager/captain-issued
-- invite code whose player_num is stored server-side in invite_codes.
-- Managers may still correct their own account's player number.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_code text := new.raw_user_meta_data->>'invite_code';
  v_username text := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));
  v_phone text := new.raw_user_meta_data->>'phone_number';
  v_is_first boolean;
  v_invite public.invite_codes%rowtype;
  v_profile_role text := 'player';
  v_previous_captain uuid;
begin
  -- Serialize the one-time bootstrap-manager decision so two simultaneous
  -- first registrations cannot both become managers.
  perform pg_advisory_xact_lock(118004, 1);
  select not exists(select 1 from public.profiles) into v_is_first;

  if v_is_first then
    insert into public.profiles (id, username, role, phone_number, is_claimed, player_num, email)
    values (new.id, v_username, 'manager', v_phone, true, null, new.email);
    return new;
  end if;

  -- Lock a valid invite row so simultaneous signup attempts cannot redeem the
  -- same one-time code for two different accounts.
  select * into v_invite
  from public.invite_codes
  where code = upper(coalesce(v_code, ''))
    and used_at is null
    and expires_at > now()
  for update;

  if v_invite.code is not null then
    v_profile_role := v_invite.role;
  end if;

  insert into public.profiles (id, username, role, phone_number, is_claimed, player_num, email)
  values (
    new.id,
    v_username,
    v_profile_role,
    v_phone,
    v_invite.code is not null,
    v_invite.player_num,
    new.email
  );

  if v_invite.code is not null and v_invite.team_id is not null then
    insert into public.profile_team_memberships (profile_id, team_id)
    values (new.id, v_invite.team_id)
    on conflict (profile_id, team_id) where ended_at is null do nothing;

    if v_invite.role = 'captain' then
      select captain_profile_id into v_previous_captain
      from public.teams
      where id = v_invite.team_id
      for update;

      update public.teams
      set captain_profile_id = new.id
      where id = v_invite.team_id;

      update public.captaincy_history
      set ended_at = now()
      where team_id = v_invite.team_id
        and ended_at is null
        and profile_id is distinct from new.id;

      if v_previous_captain is not null
         and v_previous_captain is distinct from new.id
         and not exists (
           select 1 from public.teams
           where captain_profile_id = v_previous_captain
         ) then
        update public.profiles
        set role = 'player'
        where id = v_previous_captain
          and role = 'captain';
      end if;

      insert into public.captaincy_history (team_id, profile_id, started_at)
      select v_invite.team_id, new.id, now()
      where not exists (
        select 1 from public.captaincy_history
        where team_id = v_invite.team_id
          and profile_id = new.id
          and ended_at is null
      );
    end if;

    update public.invite_codes
    set used_at = now(),
        used_by = new.id
    where code = v_invite.code;
  end if;

  return new;
end;
$function$;

create or replace function public.set_own_player_number(p_player_num text)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_num text := nullif(trim(p_player_num), '');
  v_exists boolean;
  v_taken boolean;
begin
  if public.current_role_name() is distinct from 'manager' then
    raise exception 'PLAYER_NUMBER_REQUIRES_MANAGER_OR_INVITE'
      using errcode = '42501';
  end if;

  if v_num is null then
    update public.profiles
    set player_num = null
    where id = auth.uid();
    return found;
  end if;

  select exists (
    select 1 from public.players where num = v_num
  ) into v_exists;
  if not v_exists then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  select exists (
    select 1 from public.profiles
    where player_num = v_num and id <> auth.uid()
  ) into v_taken;
  if v_taken then
    raise exception 'PLAYER_ALREADY_CLAIMED';
  end if;

  update public.profiles
  set player_num = v_num
  where id = auth.uid();
  return found;
end;
$function$;

revoke all on function public.set_own_player_number(text) from public, anon;
grant execute on function public.set_own_player_number(text) to authenticated;

-- Verification queries:
-- 1. handle_new_user must not read raw_user_meta_data->>'player_num'.
-- 2. set_own_player_number must reject non-manager callers.
-- 3. a valid player invite code remains the only self-service route to link
--    its server-stored player_num to the authenticated profile.
