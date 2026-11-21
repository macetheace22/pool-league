-- Section 105: account full names and validated identity links.
--
-- New accounts must provide first and last name. Existing league-linked
-- profiles are backfilled from the canonical IBA player record where possible.
-- Official player-number linking is accepted only when the account name
-- matches the IBA player name. Practice links retain mutual confirmation and
-- now require both accounts to have full names.

alter table public.profiles
  add column if not exists first_name text,
  add column if not exists last_name text;

-- Backfill existing linked league accounts from the canonical IBA player name.
update public.profiles profile
set first_name = coalesce(nullif(trim(profile.first_name), ''), split_part(trim(player.name), ' ', 1)),
    last_name = coalesce(
      nullif(trim(profile.last_name), ''),
      nullif(regexp_replace(trim(player.name), '^\S+\s*', ''), '')
    )
from public.players player
where player.num = profile.player_num
  and nullif(trim(player.name), '') is not null
  and (
    nullif(trim(profile.first_name), '') is null
    or nullif(trim(profile.last_name), '') is null
  );

create or replace function public.validate_profile_full_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_metadata jsonb;
  v_iba_name text;
  v_account_name_normalized text;
  v_iba_name_normalized text;
begin
  if tg_op = 'INSERT' then
    select u.raw_user_meta_data
      into v_metadata
    from auth.users u
    where u.id = new.id;

    new.first_name := coalesce(nullif(trim(new.first_name), ''), nullif(trim(v_metadata->>'first_name'), ''));
    new.last_name := coalesce(nullif(trim(new.last_name), ''), nullif(trim(v_metadata->>'last_name'), ''));
  end if;

  new.first_name := nullif(trim(new.first_name), '');
  new.last_name := nullif(trim(new.last_name), '');

  if new.first_name is null or new.last_name is null then
    raise exception 'PROFILE_FULL_NAME_REQUIRED';
  end if;

  if new.player_num is not null then
    select player.name
      into v_iba_name
    from public.players player
    where player.num = new.player_num;

    if v_iba_name is null then
      raise exception 'PLAYER_NOT_FOUND';
    end if;

    -- Ignore case, whitespace, and punctuation while preserving the actual
    -- first/last-name content. This accepts common punctuation variations
    -- without allowing a different person's name to claim the player number.
    v_account_name_normalized := regexp_replace(
      lower(concat_ws(' ', new.first_name, new.last_name)),
      '[^[:alnum:]]',
      '',
      'g'
    );
    v_iba_name_normalized := regexp_replace(
      lower(trim(v_iba_name)),
      '[^[:alnum:]]',
      '',
      'g'
    );

    if v_account_name_normalized is distinct from v_iba_name_normalized then
      raise exception 'PLAYER_NAME_MISMATCH';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.validate_profile_full_name() from public, anon, authenticated;

drop trigger if exists validate_profile_full_name on public.profiles;
create trigger validate_profile_full_name
  before insert or update of first_name, last_name, player_num
  on public.profiles
  for each row
  execute function public.validate_profile_full_name();

-- Registration calls this before auth.signUp so a mismatched player invite
-- gives a useful message before the auth trigger attempts profile creation.
create or replace function public.validate_player_invite_name(
  p_code text,
  p_first_name text,
  p_last_name text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_player_num text;
  v_iba_name text;
  v_account_name_normalized text;
  v_iba_name_normalized text;
begin
  select invite.player_num
    into v_player_num
  from public.invite_codes invite
  where invite.code = upper(trim(coalesce(p_code, '')))
    and invite.used_at is null
    and invite.expires_at > now();

  if not found then
    return 'INVALID_CODE';
  end if;

  if v_player_num is null then
    return 'OK';
  end if;

  select player.name
    into v_iba_name
  from public.players player
  where player.num = v_player_num;

  if v_iba_name is null then
    return 'PLAYER_NOT_FOUND';
  end if;

  v_account_name_normalized := regexp_replace(
    lower(concat_ws(' ', trim(coalesce(p_first_name, '')), trim(coalesce(p_last_name, '')))),
    '[^[:alnum:]]',
    '',
    'g'
  );
  v_iba_name_normalized := regexp_replace(
    lower(trim(v_iba_name)),
    '[^[:alnum:]]',
    '',
    'g'
  );

  if v_account_name_normalized = '' or v_account_name_normalized is distinct from v_iba_name_normalized then
    return 'PLAYER_NAME_MISMATCH';
  end if;

  return 'OK';
end;
$function$;

revoke all on function public.validate_player_invite_name(text, text, text) from public;
grant execute on function public.validate_player_invite_name(text, text, text) to anon, authenticated;

-- A practice identity can only be linked when both participants have
-- completed their account names. The existing mutual-confirmation RPC remains
-- the only way to set linked_profile_id.
create or replace function public.validate_practice_opponent_link_names()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_owner_first text;
  v_owner_last text;
  v_target_first text;
  v_target_last text;
begin
  if new.linked_profile_id is null or new.linked_profile_id is not distinct from old.linked_profile_id then
    return new;
  end if;

  if old.linked_profile_id is not null then
    raise exception 'PRACTICE_OPPONENT_ALREADY_LINKED';
  end if;

  select profile.first_name, profile.last_name
    into v_owner_first, v_owner_last
  from public.profiles profile
  where profile.id = new.created_by;

  select profile.first_name, profile.last_name
    into v_target_first, v_target_last
  from public.profiles profile
  where profile.id = new.linked_profile_id;

  if nullif(trim(v_owner_first), '') is null
     or nullif(trim(v_owner_last), '') is null
     or nullif(trim(v_target_first), '') is null
     or nullif(trim(v_target_last), '') is null then
    raise exception 'PRACTICE_LINK_FULL_NAME_REQUIRED';
  end if;

  return new;
end;
$function$;

revoke all on function public.validate_practice_opponent_link_names() from public, anon, authenticated;

drop trigger if exists validate_practice_opponent_link_names on public.practice_opponents;
create trigger validate_practice_opponent_link_names
  before update of linked_profile_id
  on public.practice_opponents
  for each row
  execute function public.validate_practice_opponent_link_names();

-- Search results reveal only the selected account's name and username. The
-- recipient still has to confirm the identity request before history is linked.
create or replace function public.search_profiles_for_practice_link(p_query text)
returns table(
  id uuid,
  username text,
  first_name text,
  last_name text,
  full_name text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    profile.id,
    profile.username,
    profile.first_name,
    profile.last_name,
    concat_ws(' ', profile.first_name, profile.last_name)
  from public.profiles profile
  where (select auth.uid()) is not null
    and profile.id <> (select auth.uid())
    and profile.is_active is true
    and nullif(trim(profile.first_name), '') is not null
    and nullif(trim(profile.last_name), '') is not null
    and (
      lower(profile.username) like '%' || lower(trim(coalesce(p_query, ''))) || '%'
      or lower(concat_ws(' ', profile.first_name, profile.last_name)) like '%' || lower(trim(coalesce(p_query, ''))) || '%'
    )
  order by profile.username
  limit 20;
$function$;

revoke all on function public.search_profiles_for_practice_link(text) from public, anon, authenticated;
grant execute on function public.search_profiles_for_practice_link(text) to authenticated;

-- Include both participants' verified account names in the request inbox so
-- the owner/claimant can recognize the other person before accepting.
create or replace function public.list_practice_opponent_link_requests_with_names()
returns table(
  request_id uuid,
  opponent_id uuid,
  opponent_name text,
  requester_id uuid,
  requester_username text,
  target_profile_id uuid,
  target_username text,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  direction text,
  link_type text,
  requester_full_name text,
  target_full_name text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    request.id,
    request.opponent_id,
    opponent.name,
    request.requested_by,
    requester.username,
    request.target_profile_id,
    target.username,
    request.status,
    request.created_at,
    request.expires_at,
    case when request.target_profile_id = (select auth.uid()) then 'incoming' else 'outgoing' end,
    case when request.link_profile_id = request.requested_by then 'claim' else 'link' end,
    concat_ws(' ', requester.first_name, requester.last_name),
    concat_ws(' ', target.first_name, target.last_name)
  from public.practice_opponent_link_requests request
  join public.practice_opponents opponent on opponent.id = request.opponent_id
  left join public.profiles requester on requester.id = request.requested_by
  left join public.profiles target on target.id = request.target_profile_id
  where (request.requested_by = (select auth.uid()) or request.target_profile_id = (select auth.uid()))
    and (select auth.uid()) is not null
  order by request.created_at desc
  limit 50;
$function$;

revoke all on function public.list_practice_opponent_link_requests_with_names() from public, anon, authenticated;
grant execute on function public.list_practice_opponent_link_requests_with_names() to authenticated;

-- The person who originally recorded a game sees the linked opponent's full
-- account name rather than the stale guest label they typed before linking.
create or replace function public.list_linked_practice_opponent_names(
  p_practice_game_ids uuid[]
)
returns table(practice_game_id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    game.id,
    coalesce(
      nullif(trim(concat_ws(' ', opponent_profile.first_name, opponent_profile.last_name)), ''),
      nullif(trim(opponent_player.name), ''),
      opponent_profile.username
    )
  from public.practice_games game
  join public.practice_opponents opponent on opponent.id = game.opponent_id
  join public.profiles opponent_profile on opponent_profile.id = opponent.linked_profile_id
  left join public.players opponent_player on opponent_player.num = opponent_profile.player_num
  where game.id = any(coalesce(p_practice_game_ids, '{}'::uuid[]))
    and game.created_by = (select auth.uid())
    and opponent.linked_profile_id is not null
    and (select auth.uid()) is not null;
$function$;

revoke all on function public.list_linked_practice_opponent_names(uuid[]) from public, anon, authenticated;
grant execute on function public.list_linked_practice_opponent_names(uuid[]) to authenticated;

-- Update the Section 104 owner lookup to prefer the account's first + last
-- name. The canonical IBA player name remains a safe fallback for older
-- linked profiles; username is the final fallback.
create or replace function public.list_linked_practice_game_owners(
  p_practice_game_ids uuid[]
)
returns table(
  practice_game_id uuid,
  display_name text,
  player_num text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    game.id,
    coalesce(
      nullif(trim(concat_ws(' ', owner_profile.first_name, owner_profile.last_name)), ''),
      nullif(trim(owner_player.name), ''),
      owner_profile.username
    ),
    owner_profile.player_num
  from public.practice_games game
  join public.practice_opponents opponent on opponent.id = game.opponent_id
  join public.profiles owner_profile on owner_profile.id = game.created_by
  left join public.players owner_player on owner_player.num = owner_profile.player_num
  where game.id = any(coalesce(p_practice_game_ids, '{}'::uuid[]))
    and opponent.linked_profile_id = (select auth.uid())
    and (select auth.uid()) is not null;
$function$;

revoke all on function public.list_linked_practice_game_owners(uuid[]) from public, anon, authenticated;
grant execute on function public.list_linked_practice_game_owners(uuid[]) to authenticated;

comment on function public.validate_profile_full_name() is
  'Populates and validates account first/last names, and requires a matching canonical IBA player name before player-number linking.';

comment on function public.validate_practice_opponent_link_names() is
  'Requires both participants to have first and last names before a mutual-confirmation practice identity link can be applied.';
