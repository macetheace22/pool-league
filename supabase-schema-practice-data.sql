-- Practice data normalization: keep durable practice configuration in typed columns.
--
-- Existing practice_games.target_config JSON stores only configuration values
-- that already have stable meanings in the practice model. Move those values
-- into first-class columns so practice records are queryable and reportable.
--
-- No new public table is created, so existing practice_games RLS/Data API
-- permissions remain unchanged.

alter table public.practice_games
  add column if not exists my_target integer,
  add column if not exists opponent_target integer,
  add column if not exists target_games integer,
  add column if not exists table_size_feet numeric(4,1);

update public.practice_games
set
  my_target = coalesce(
    my_target,
    case
      when target_config ? 'myTarget'
        and (target_config->>'myTarget') ~ '^[0-9]+$'
      then (target_config->>'myTarget')::integer
      else null
    end
  ),
  opponent_target = coalesce(
    opponent_target,
    case
      when target_config ? 'oppTarget'
        and (target_config->>'oppTarget') ~ '^[0-9]+$'
      then (target_config->>'oppTarget')::integer
      else null
    end
  ),
  target_games = coalesce(
    target_games,
    case
      when target_config ? 'x'
        and (target_config->>'x') ~ '^[0-9]+$'
      then (target_config->>'x')::integer
      else null
    end
  ),
  table_size_feet = coalesce(
    table_size_feet,
    case
      when target_config ? 'tableSizeFeet'
        and (target_config->>'tableSizeFeet') ~ '^[0-9]+([.][0-9]+)?$'
      then (target_config->>'tableSizeFeet')::numeric(4,1)
      else null
    end
  );

alter table public.practice_games
  drop constraint if exists practice_games_my_target_positive,
  drop constraint if exists practice_games_opponent_target_positive,
  drop constraint if exists practice_games_target_games_positive,
  drop constraint if exists practice_games_table_size_feet_positive;

alter table public.practice_games
  add constraint practice_games_my_target_positive
    check (my_target is null or my_target > 0),
  add constraint practice_games_opponent_target_positive
    check (opponent_target is null or opponent_target > 0),
  add constraint practice_games_target_games_positive
    check (target_games is null or target_games > 0),
  add constraint practice_games_table_size_feet_positive
    check (table_size_feet is null or table_size_feet > 0);

-- All currently-known target_config values are now represented by typed
-- columns. Clear the JSON payload rather than maintaining two sources of truth.
update public.practice_games
set target_config = '{}'::jsonb
where target_config <> '{}'::jsonb;

comment on column public.practice_games.my_target is
  'Race-to-points target for the player who created the practice session.';

comment on column public.practice_games.opponent_target is
  'Race-to-points target for the practice opponent.';

comment on column public.practice_games.target_games is
  'Configured game target for race-to-games or best-of-X practice.';

comment on column public.practice_games.table_size_feet is
  'Table size used for the practice session, in feet.';
