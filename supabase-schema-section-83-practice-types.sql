-- Section 83: distinguish skills/drills practice from opponent practice
-- and persist the scoring method used for opponent practice.

alter table public.practice_games
  add column if not exists practice_type text not null default 'opponent',
  add column if not exists scoring_method text,
  add column if not exists completed_at timestamptz;

alter table public.practice_games
  alter column opponent_name drop not null,
  alter column game_type drop not null,
  alter column format drop not null;

alter table public.practice_games
  drop constraint if exists practice_games_opponent_check;

alter table public.practice_games
  add constraint practice_games_practice_type_check
    check (practice_type in ('skills_drills', 'opponent')),
  add constraint practice_games_scoring_method_check
    check (scoring_method is null or scoring_method in ('race_to_points', 'race_to_games')),
  add constraint practice_games_opponent_check
    check (
      practice_type = 'skills_drills'
      or opponent_player_num is not null
      or opponent_id is not null
    );

update public.practice_games
set completed_at = played_at
where completed_at is null
  and winner is not null;

update public.practice_games
set scoring_method = case
  when format = 'match' then 'race_to_points'
  when format = 'race' then 'race_to_games'
  else null
end
where scoring_method is null
  and winner is not null;

comment on column public.practice_games.practice_type is
  'Practice mode: skills_drills for solo skills/drills, opponent for play against an opponent.';

comment on column public.practice_games.scoring_method is
  'Opponent-practice scoring method: race_to_points or race_to_games. Null for skills/drills.';

comment on column public.practice_games.completed_at is
  'Timestamp when the practice session was completed and saved.';
