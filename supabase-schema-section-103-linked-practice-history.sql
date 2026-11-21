-- Section 103: allow linked practice identities to read shared history.
--
-- A practice identity link does not transfer ownership of practice records.
-- The original creator remains the owner/writer. The linked profile receives
-- read access to practice games, game results, shot events, and the durable
-- guest-opponent row represented by that identity.
--
-- This preserves the existing write boundary while making the Section 102
-- accepted link actually usable from the linked player's Practice history.

drop policy if exists "read linked practice opponents" on public.practice_opponents;
create policy "read linked practice opponents"
  on public.practice_opponents for select to authenticated
  using (linked_profile_id = (select auth.uid()));

drop policy if exists "read linked practice games" on public.practice_games;
create policy "read linked practice games"
  on public.practice_games for select to authenticated
  using (
    exists (
      select 1
      from public.practice_opponents po
      where po.id = practice_games.opponent_id
        and po.linked_profile_id = (select auth.uid())
    )
  );

drop policy if exists "read linked practice game results" on public.practice_game_results;
create policy "read linked practice game results"
  on public.practice_game_results for select to authenticated
  using (
    exists (
      select 1
      from public.practice_games pg
      join public.practice_opponents po on po.id = pg.opponent_id
      where pg.id = practice_game_results.practice_game_id
        and po.linked_profile_id = (select auth.uid())
    )
  );

drop policy if exists "read linked practice shot events" on public.shot_events;
create policy "read linked practice shot events"
  on public.shot_events for select to authenticated
  using (
    context_type = 'practice_game'
    and exists (
      select 1
      from public.practice_games pg
      join public.practice_opponents po on po.id = pg.opponent_id
      where pg.id = shot_events.context_id
        and po.linked_profile_id = (select auth.uid())
    )
  );
