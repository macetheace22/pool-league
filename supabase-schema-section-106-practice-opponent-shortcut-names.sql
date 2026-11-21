-- Section 106: resolve linked account names in prior-practice-opponent shortcuts.
--
-- OpponentStep's "People you've played before" list is backed by the durable
-- guest-opponent row. Once that row is linked, show the linked account's
-- first + last name to both participants instead of the original guest label.
-- The function returns only rows the caller owns or rows linked to the caller.

create or replace function public.list_my_practice_opponents_with_names()
returns table(
  id uuid,
  name text,
  created_by uuid,
  linked_profile_id uuid,
  created_at timestamptz,
  display_name text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    opponent.id,
    opponent.name,
    opponent.created_by,
    opponent.linked_profile_id,
    opponent.created_at,
    coalesce(
      nullif(trim(concat_ws(' ', linked_profile.first_name, linked_profile.last_name)), ''),
      nullif(trim(linked_player.name), ''),
      linked_profile.username,
      opponent.name
    )
  from public.practice_opponents opponent
  left join public.profiles linked_profile
    on linked_profile.id = opponent.linked_profile_id
  left join public.players linked_player
    on linked_player.num = linked_profile.player_num
  where (select auth.uid()) is not null
    and (
      opponent.created_by = (select auth.uid())
      or opponent.linked_profile_id = (select auth.uid())
    )
  order by opponent.created_at desc;
$function$;

revoke all on function public.list_my_practice_opponents_with_names() from public, anon, authenticated;
grant execute on function public.list_my_practice_opponents_with_names() to authenticated;

comment on function public.list_my_practice_opponents_with_names() is
  'Returns only practice opponent rows owned by or linked to the authenticated profile, preferring the linked account first and last name for display.';
