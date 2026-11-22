-- Section 109: share already-open Practice sessions with confirmed opponents.
-- Backfill only unfinished opponent sessions whose existing opponent row has
-- a mutually confirmed linked profile. Completed history is not modified.

begin;

drop trigger if exists protect_practice_game_shared_participant on public.practice_games;

update public.practice_games as game
set shared_with_profile_id = opponent.linked_profile_id
from public.practice_opponents as opponent
where game.opponent_id = opponent.id
  and game.created_by = opponent.created_by
  and game.practice_type = 'opponent'
  and game.winner is null
  and game.completed_at is null
  and game.shared_with_profile_id is null
  and opponent.linked_profile_id is not null
  and opponent.linked_profile_id <> game.created_by;

create trigger protect_practice_game_shared_participant
before update on public.practice_games
for each row execute function public.protect_practice_game_shared_participant();

commit;
