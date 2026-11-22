-- Section 108: shared access for newly created opponent Practice sessions.
-- Existing practice_games rows are intentionally left unshared. A confirmed
-- opponent identity is resolved only when a new session is inserted.

alter table public.practice_games
  add column if not exists shared_with_profile_id uuid references public.profiles(id) on delete set null;

create index if not exists practice_games_shared_with_profile_id_idx
  on public.practice_games (shared_with_profile_id, played_at desc)
  where shared_with_profile_id is not null;

create or replace function public.set_practice_game_shared_participant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opponent_profile_id uuid;
  v_opponent_player_num text;
begin
  if (select auth.uid()) is null or new.created_by is distinct from (select auth.uid()) then
    raise exception 'Practice sessions must be created by the signed-in player'
      using errcode = '42501';
  end if;

  -- Never trust a client-supplied participant id.
  new.shared_with_profile_id := null;

  if new.practice_type <> 'opponent' then
    return new;
  end if;

  if new.opponent_player_num is not null then
    select profile.id, profile.player_num
      into v_opponent_profile_id, v_opponent_player_num
    from public.profiles profile
    where profile.player_num = new.opponent_player_num
      and profile.is_active = true
      and profile.id <> new.created_by
    order by profile.created_at
    limit 1;
  elsif new.opponent_id is not null then
    select opponent.linked_profile_id, profile.player_num
      into v_opponent_profile_id, v_opponent_player_num
    from public.practice_opponents opponent
    left join public.profiles profile on profile.id = opponent.linked_profile_id
    where opponent.id = new.opponent_id
      and opponent.created_by = new.created_by
      and opponent.linked_profile_id is not null
      and opponent.linked_profile_id <> new.created_by;
  end if;

  if v_opponent_profile_id is not null then
    new.shared_with_profile_id := v_opponent_profile_id;
    -- Keep Track a Rack's player-number authorization aligned for a linked
    -- manually-entered opponent as well as a roster-selected opponent.
    if new.opponent_player_num is null then
      new.opponent_player_num := v_opponent_player_num;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.set_practice_game_shared_participant() from public, anon, authenticated;

drop trigger if exists set_practice_game_shared_participant on public.practice_games;
create trigger set_practice_game_shared_participant
before insert on public.practice_games
for each row execute function public.set_practice_game_shared_participant();

create or replace function public.protect_practice_game_shared_participant()
returns trigger
language plpgsql
set search_path = ''
as $
begin
  if new.created_by is distinct from old.created_by
     or new.shared_with_profile_id is distinct from old.shared_with_profile_id then
    raise exception 'Practice session ownership and sharing cannot be changed after creation'
      using errcode = '42501';
  end if;

  if old.shared_with_profile_id is not null and (
    new.practice_type is distinct from old.practice_type
    or new.opponent_id is distinct from old.opponent_id
    or new.opponent_player_num is distinct from old.opponent_player_num
  ) then
    raise exception 'The participants in a shared practice session cannot be changed'
      using errcode = '42501';
  end if;

  return new;
end;
$;

revoke all on function public.protect_practice_game_shared_participant() from public, anon, authenticated;

drop trigger if exists protect_practice_game_shared_participant on public.practice_games;
create trigger protect_practice_game_shared_participant
before update on public.practice_games
for each row execute function public.protect_practice_game_shared_participant();

drop policy if exists "read shared practice games" on public.practice_games;
create policy "read shared practice games"
on public.practice_games
for select
to authenticated
using (shared_with_profile_id = (select auth.uid()));

drop policy if exists "read shared practice game results" on public.practice_game_results;
create policy "read shared practice game results"
on public.practice_game_results
for select
to authenticated
using (
  exists (
    select 1
    from public.practice_games game
    where game.id = practice_game_results.practice_game_id
      and game.shared_with_profile_id = (select auth.uid())
  )
);

create or replace function public.list_linked_practice_game_owners(p_practice_game_ids uuid[])
returns table(practice_game_id uuid, display_name text, player_num text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    game.id,
    coalesce(
      nullif(trim(concat_ws(' ', owner_profile.first_name, owner_profile.last_name)), ''),
      nullif(trim(owner_player.name), ''),
      owner_profile.username
    ),
    owner_profile.player_num
  from public.practice_games game
  join public.profiles owner_profile on owner_profile.id = game.created_by
  left join public.players owner_player on owner_player.num = owner_profile.player_num
  where game.id = any(coalesce(p_practice_game_ids, '{}'::uuid[]))
    and (select auth.uid()) is not null
    and (
      game.shared_with_profile_id = (select auth.uid())
      or exists (
        select 1
        from public.practice_opponents opponent
        where opponent.id = game.opponent_id
          and opponent.linked_profile_id = (select auth.uid())
      )
    );
$$;

revoke all on function public.list_linked_practice_game_owners(uuid[]) from public, anon;
grant execute on function public.list_linked_practice_game_owners(uuid[]) to authenticated;

create or replace function public.record_practice_game_result(
  p_practice_game_id uuid,
  p_my_points integer default null,
  p_opponent_points integer default null,
  p_winner text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.practice_games%rowtype;
  v_is_shared_viewer boolean;
  v_winner text;
  v_my_points integer := p_my_points;
  v_opponent_points integer := p_opponent_points;
  v_result public.practice_game_results%rowtype;
  v_my_add integer;
  v_opponent_add integer;
  v_result_json jsonb;
begin
  select * into v_parent
  from public.practice_games
  where id = p_practice_game_id
    and (
      created_by = (select auth.uid())
      or shared_with_profile_id = (select auth.uid())
    )
  for update;

  if not found or (select auth.uid()) is null then
    raise exception 'Practice session not found or access denied' using errcode = '42501';
  end if;

  v_is_shared_viewer := v_parent.created_by <> (select auth.uid());

  if v_parent.practice_type <> 'opponent' or v_parent.completed_at is not null then
    raise exception 'This practice session is not open for scoring';
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

  if v_is_shared_viewer then
    v_my_points := p_opponent_points;
    v_opponent_points := p_my_points;
    v_winner := case when v_winner = 'me' then 'opponent' else 'me' end;
  end if;

  if v_parent.scoring_method = 'race_to_points' and v_parent.game_type = '8ball' then
    v_my_add := v_my_points;
    v_opponent_add := v_opponent_points;
  else
    v_my_add := case when v_winner = 'me' then 1 else 0 end;
    v_opponent_add := case when v_winner = 'opponent' then 1 else 0 end;
  end if;

  insert into public.practice_game_results
    (practice_game_id, game_number, my_points, opponent_points, winner)
  select p_practice_game_id, coalesce(max(game_number), 0) + 1, v_my_points, v_opponent_points, v_winner
  from public.practice_game_results
  where practice_game_id = p_practice_game_id
  returning * into v_result;

  update public.practice_games
  set my_score = coalesce(my_score, 0) + v_my_add,
      opponent_score = coalesce(opponent_score, 0) + v_opponent_add
  where id = p_practice_game_id;

  if v_is_shared_viewer then
    v_result_json := jsonb_build_object(
      'id', v_result.id,
      'practice_game_id', v_result.practice_game_id,
      'game_number', v_result.game_number,
      'my_points', v_result.opponent_points,
      'opponent_points', v_result.my_points,
      'winner', case when v_result.winner = 'me' then 'opponent' else 'me' end,
      'recorded_at', v_result.recorded_at
    );
  else
    v_result_json := to_jsonb(v_result);
  end if;

  return jsonb_build_object(
    'result', v_result_json,
    'my_score', case when v_is_shared_viewer
      then coalesce(v_parent.opponent_score, 0) + v_opponent_add
      else coalesce(v_parent.my_score, 0) + v_my_add end,
    'opponent_score', case when v_is_shared_viewer
      then coalesce(v_parent.my_score, 0) + v_my_add
      else coalesce(v_parent.opponent_score, 0) + v_opponent_add end
  );
end;
$$;

create or replace function public.undo_last_practice_game_result(p_practice_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.practice_games%rowtype;
  v_is_shared_viewer boolean;
  v_removed public.practice_game_results%rowtype;
  v_my_score integer;
  v_opponent_score integer;
  v_removed_json jsonb;
begin
  select * into v_parent
  from public.practice_games
  where id = p_practice_game_id
    and (
      created_by = (select auth.uid())
      or shared_with_profile_id = (select auth.uid())
    )
  for update;

  if not found or (select auth.uid()) is null then
    raise exception 'Practice session not found or access denied' using errcode = '42501';
  end if;

  v_is_shared_viewer := v_parent.created_by <> (select auth.uid());

  if v_parent.completed_at is not null then
    raise exception 'A completed practice session cannot be changed';
  end if;

  select * into v_removed
  from public.practice_game_results
  where practice_game_id = p_practice_game_id
  order by game_number desc
  limit 1
  for update;

  if not found then
    raise exception 'There is no game result to undo';
  end if;

  delete from public.practice_game_results where id = v_removed.id;

  select
    coalesce(sum(case when v_parent.scoring_method = 'race_to_points' and v_parent.game_type = '8ball'
      then coalesce(my_points, 0) when winner = 'me' then 1 else 0 end), 0)::integer,
    coalesce(sum(case when v_parent.scoring_method = 'race_to_points' and v_parent.game_type = '8ball'
      then coalesce(opponent_points, 0) when winner = 'opponent' then 1 else 0 end), 0)::integer
  into v_my_score, v_opponent_score
  from public.practice_game_results
  where practice_game_id = p_practice_game_id;

  update public.practice_games
  set my_score = v_my_score,
      opponent_score = v_opponent_score,
      winner = null,
      completed_at = null
  where id = p_practice_game_id;

  if v_is_shared_viewer then
    v_removed_json := jsonb_build_object(
      'id', v_removed.id,
      'practice_game_id', v_removed.practice_game_id,
      'game_number', v_removed.game_number,
      'my_points', v_removed.opponent_points,
      'opponent_points', v_removed.my_points,
      'winner', case when v_removed.winner = 'me' then 'opponent' else 'me' end,
      'recorded_at', v_removed.recorded_at
    );
  else
    v_removed_json := to_jsonb(v_removed);
  end if;

  return jsonb_build_object(
    'removed', v_removed_json,
    'my_score', case when v_is_shared_viewer then v_opponent_score else v_my_score end,
    'opponent_score', case when v_is_shared_viewer then v_my_score else v_opponent_score end
  );
end;
$$;

create or replace function public.finish_practice_game(p_practice_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.practice_games%rowtype;
  v_is_shared_viewer boolean;
  v_winner text := null;
  v_my_target integer;
  v_opponent_target integer;
begin
  select * into v_parent
  from public.practice_games
  where id = p_practice_game_id
    and (
      created_by = (select auth.uid())
      or shared_with_profile_id = (select auth.uid())
    )
  for update;

  if not found or (select auth.uid()) is null then
    raise exception 'Practice session not found or access denied' using errcode = '42501';
  end if;

  v_is_shared_viewer := v_parent.created_by <> (select auth.uid());

  if v_parent.practice_type = 'opponent' then
    v_my_target := case
      when v_parent.scoring_method = 'race_to_points' then v_parent.my_target
      when v_parent.scoring_method = 'best_of_games' then floor(v_parent.target_games / 2.0)::integer + 1
      else v_parent.target_games
    end;
    v_opponent_target := case
      when v_parent.scoring_method = 'race_to_points' then v_parent.opponent_target
      when v_parent.scoring_method = 'best_of_games' then floor(v_parent.target_games / 2.0)::integer + 1
      else v_parent.target_games
    end;

    if v_parent.my_score >= v_my_target then
      v_winner := 'me';
    elsif v_parent.opponent_score >= v_opponent_target then
      v_winner := 'opponent';
    end if;
  end if;

  update public.practice_games
  set completed_at = coalesce(completed_at, now()),
      winner = coalesce(winner, v_winner)
  where id = p_practice_game_id;

  return jsonb_build_object(
    'id', p_practice_game_id,
    'completed_at', (select completed_at from public.practice_games where id = p_practice_game_id),
    'winner', case when v_is_shared_viewer and v_winner is not null
      then case when v_winner = 'me' then 'opponent' else 'me' end
      else v_winner end
  );
end;
$$;

revoke all on function public.record_practice_game_result(uuid, integer, integer, text) from public, anon;
revoke all on function public.undo_last_practice_game_result(uuid) from public, anon;
revoke all on function public.finish_practice_game(uuid) from public, anon;
grant execute on function public.record_practice_game_result(uuid, integer, integer, text) to authenticated;
grant execute on function public.undo_last_practice_game_result(uuid) to authenticated;
grant execute on function public.finish_practice_game(uuid) to authenticated;
