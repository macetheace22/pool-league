-- Section 87: safely discard an unfinished practice game and its dependent data.
-- The game owner is checked inside the SECURITY DEFINER function because
-- shot_events.context_id is polymorphic and has no foreign-key cascade.

create or replace function public.discard_practice_game(p_practice_game_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
begin
  select created_by
    into v_created_by
    from public.practice_games
   where id = p_practice_game_id
   for update;

  if not found then
    raise exception 'Practice session not found';
  end if;

  if v_created_by is distinct from auth.uid() then
    raise exception 'Not authorized to discard this practice session'
      using errcode = '42501';
  end if;

  delete from public.shot_events
   where context_type = 'practice_game'
     and context_id = p_practice_game_id;

  delete from public.practice_game_results
   where practice_game_id = p_practice_game_id;

  delete from public.practice_games
   where id = p_practice_game_id
     and created_by = auth.uid();
end;
$$;

revoke all on function public.discard_practice_game(uuid) from public;
grant execute on function public.discard_practice_game(uuid) to authenticated;
