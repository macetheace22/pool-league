-- Section 104: expose only the owner identity needed to render linked practice history.
-- The caller can resolve names only for games whose guest opponent is linked
-- to the authenticated profile. No general profiles-table read access is added.

create or replace function public.list_linked_practice_game_owners(
  p_practice_game_ids uuid[]
)
returns table(
  practice_game_id uuid,
  username text,
  player_num text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select pg.id, owner_profile.username, owner_profile.player_num
  from public.practice_games pg
  join public.practice_opponents po on po.id = pg.opponent_id
  join public.profiles owner_profile on owner_profile.id = pg.created_by
  where pg.id = any(coalesce(p_practice_game_ids, '{}'::uuid[]))
    and po.linked_profile_id = (select auth.uid())
    and (select auth.uid()) is not null;
$function$;

revoke all on function public.list_linked_practice_game_owners(uuid[]) from public, anon, authenticated;
grant execute on function public.list_linked_practice_game_owners(uuid[]) to authenticated;

comment on function public.list_linked_practice_game_owners(uuid[]) is
  'Returns only the username and player number of original owners for practice games linked to the authenticated profile.';
