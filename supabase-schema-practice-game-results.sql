-- Practice game results: normalize the former practice_games.game_log JSONB array.
-- One row represents one completed game/rack. Shot-level detail remains in shot_events.
create table if not exists public.practice_game_results (
  id uuid primary key default gen_random_uuid(),
  practice_game_id uuid not null references public.practice_games(id) on delete cascade,
  game_number integer not null check (game_number > 0),
  my_points integer,
  opponent_points integer,
  winner text not null check (winner in ('me', 'opponent')),
  recorded_at timestamptz not null default now(),
  constraint practice_game_results_unique_number unique (practice_game_id, game_number),
  constraint practice_game_results_points_pair check (
    (my_points is null and opponent_points is null)
    or (my_points is not null and opponent_points is not null
        and my_points >= 0 and opponent_points >= 0 and my_points <> opponent_points)
  )
);
create index if not exists practice_game_results_parent_idx
  on public.practice_game_results (practice_game_id, game_number);
alter table public.practice_game_results enable row level security;
drop policy if exists "manage own practice game results" on public.practice_game_results;
create policy "manage own practice game results"
  on public.practice_game_results for all to authenticated
  using (exists (select 1 from public.practice_games pg
    where pg.id = practice_game_id and pg.created_by = (select auth.uid())))
  with check (exists (select 1 from public.practice_games pg
    where pg.id = practice_game_id and pg.created_by = (select auth.uid())));
revoke all on public.practice_game_results from anon, authenticated;
grant select, insert, update, delete on public.practice_game_results to authenticated;

-- Backfill every valid legacy 8-ball entry before dropping the JSONB column.
do $$
declare
  v_parent record; v_item jsonb; v_game_number integer;
  v_my_points integer; v_opponent_points integer; v_winner text;
begin
  for v_parent in
    select id, game_log, played_at from public.practice_games
    where jsonb_typeof(coalesce(game_log, '[]'::jsonb)) = 'array'
      and jsonb_array_length(coalesce(game_log, '[]'::jsonb)) > 0
  loop
    v_game_number := 0;
    for v_item in select value from jsonb_array_elements(v_parent.game_log)
    loop
      v_game_number := v_game_number + 1;
      begin
        v_my_points := nullif(v_item->>'myPoints', '')::integer;
        v_opponent_points := nullif(v_item->>'oppPoints', '')::integer;
        v_winner := v_item->>'winner';
      exception when others then continue;
      end;
      if v_my_points is null or v_opponent_points is null
         or v_my_points < 0 or v_opponent_points < 0
         or v_my_points = v_opponent_points or v_winner not in ('me', 'opponent') then
        continue;
      end if;
      insert into public.practice_game_results
        (practice_game_id, game_number, my_points, opponent_points, winner, recorded_at)
      values (v_parent.id, v_game_number, v_my_points, v_opponent_points, v_winner, coalesce(v_parent.played_at, now()))
      on conflict (practice_game_id, game_number) do nothing;
    end loop;
  end loop;
end $$;
alter table public.practice_games drop column if exists game_log;

create or replace function public.record_practice_game_result(
  p_practice_game_id uuid, p_my_points integer default null,
  p_opponent_points integer default null, p_winner text default null
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_parent public.practice_games%rowtype;
  v_winner text;
  v_result public.practice_game_results%rowtype;
  v_my_add integer; v_opponent_add integer;
begin
  select * into v_parent from public.practice_games
  where id = p_practice_game_id and created_by = (select auth.uid()) for update;
  if not found then raise exception 'Practice session not found or access denied'; end if;
  if v_parent.practice_type <> 'opponent' then
    raise exception 'Game results can only be recorded for opponent practice';
  end if;
  if v_parent.game_type = '8ball' then
    if p_my_points is null or p_opponent_points is null
       or p_my_points < 0 or p_opponent_points < 0 or p_my_points = p_opponent_points then
      raise exception '8-ball requires two different nonnegative point totals';
    end if;
    v_winner := case when p_my_points > p_opponent_points then 'me' else 'opponent' end;
  else
    if p_my_points is not null or p_opponent_points is not null or p_winner not in ('me', 'opponent') then
      raise exception 'Non-8-ball results require a rack winner and no point totals';
    end if;
    v_winner := p_winner;
  end if;
  if v_parent.scoring_method = 'race_to_points' and v_parent.game_type = '8ball' then
    v_my_add := p_my_points; v_opponent_add := p_opponent_points;
  else
    v_my_add := case when v_winner = 'me' then 1 else 0 end;
    v_opponent_add := case when v_winner = 'opponent' then 1 else 0 end;
  end if;
  insert into public.practice_game_results
    (practice_game_id, game_number, my_points, opponent_points, winner)
  select p_practice_game_id, coalesce(max(game_number), 0) + 1, p_my_points, p_opponent_points, v_winner
  from public.practice_game_results where practice_game_id = p_practice_game_id
  returning * into v_result;
  update public.practice_games
  set my_score = coalesce(my_score, 0) + v_my_add,
      opponent_score = coalesce(opponent_score, 0) + v_opponent_add
  where id = p_practice_game_id;
  return jsonb_build_object('result', to_jsonb(v_result),
    'my_score', coalesce(v_parent.my_score, 0) + v_my_add,
    'opponent_score', coalesce(v_parent.opponent_score, 0) + v_opponent_add);
end;
$$;

create or replace function public.undo_last_practice_game_result(p_practice_game_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  v_parent public.practice_games%rowtype;
  v_removed public.practice_game_results%rowtype;
  v_my_score integer; v_opponent_score integer;
begin
  select * into v_parent from public.practice_games
  where id = p_practice_game_id and created_by = (select auth.uid()) for update;
  if not found then raise exception 'Practice session not found or access denied'; end if;
  select * into v_removed from public.practice_game_results
  where practice_game_id = p_practice_game_id
  order by game_number desc limit 1 for update;
  if not found then raise exception 'There is no game result to undo'; end if;
  delete from public.practice_game_results where id = v_removed.id;
  select
    coalesce(sum(case when v_parent.scoring_method = 'race_to_points' and v_parent.game_type = '8ball'
      then coalesce(my_points, 0) when winner = 'me' then 1 else 0 end), 0)::integer,
    coalesce(sum(case when v_parent.scoring_method = 'race_to_points' and v_parent.game_type = '8ball'
      then coalesce(opponent_points, 0) when winner = 'opponent' then 1 else 0 end), 0)::integer
  into v_my_score, v_opponent_score
  from public.practice_game_results where practice_game_id = p_practice_game_id;
  update public.practice_games set my_score = v_my_score, opponent_score = v_opponent_score,
    winner = null, completed_at = null where id = p_practice_game_id;
  return jsonb_build_object('removed', to_jsonb(v_removed),
    'my_score', v_my_score, 'opponent_score', v_opponent_score);
end;
$$;

revoke all on function public.record_practice_game_result(uuid, integer, integer, text) from public, anon;
grant execute on function public.record_practice_game_result(uuid, integer, integer, text) to authenticated;
revoke all on function public.undo_last_practice_game_result(uuid) from public, anon;
grant execute on function public.undo_last_practice_game_result(uuid) to authenticated;
comment on table public.practice_game_results is
  'One durable row per game/rack in an opponent practice session; shot-level detail remains in shot_events.';
