-- Section 107: edit manually-entered Practice opponent full names.
--
-- Earlier versions of the opponent form collected first and last name but
-- passed them to a helper that accepted only one name argument. This RPC
-- lets the owner correct those existing guest labels and updates the
-- corresponding historical game display labels atomically.
--
-- SECURITY INVOKER preserves the existing RLS ownership checks on both
-- practice_opponents and practice_games.

create or replace function public.update_my_practice_opponent_name(
  p_opponent_id uuid,
  p_first_name text,
  p_last_name text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_full_name text;
  v_updated_count integer;
begin
  if (select auth.uid()) is null
     or p_opponent_id is null
     or nullif(trim(coalesce(p_first_name, '')), '') is null
     or nullif(trim(coalesce(p_last_name, '')), '') is null then
    return false;
  end if;

  v_full_name := trim(p_first_name) || ' ' || trim(p_last_name);

  update public.practice_opponents
  set name = v_full_name
  where id = p_opponent_id
    and created_by = (select auth.uid())
    and linked_profile_id is null;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    return false;
  end if;

  update public.practice_games
  set opponent_name = v_full_name
  where opponent_id = p_opponent_id
    and created_by = (select auth.uid());

  return true;
end;
$function$;

revoke all on function public.update_my_practice_opponent_name(uuid, text, text) from public, anon, authenticated;
grant execute on function public.update_my_practice_opponent_name(uuid, text, text) to authenticated;

comment on function public.update_my_practice_opponent_name(uuid, text, text) is
  'Allows the authenticated owner to correct an unlinked manually-entered Practice opponent full name and updates that opponent name in their historical practice games.';
