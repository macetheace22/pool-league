-- Section 51: secure current-stat views
-- These views expose season-scoped derived data and must respect the
-- querying user's RLS policies.
create or replace view public.player_current_ratings
with (security_invoker = true)
as
select distinct on (season_id, player_num)
  player_num, week_key, label, rating, source, season_id, updated_at
from public.player_ratings
where season_id is not null
order by season_id, player_num, week_key desc, updated_at desc;

create or replace view public.mvp_adjustments_current
with (security_invoker = true)
as
select distinct on (season_id, division_id, player_num)
  id, division_id, player_num, player_name, wins, sets, total_points,
  note, created_at, week_key, label, team_num, losses, mvp_ranking_points, season_id
from public.mvp_adjustments
where player_num is not null
order by season_id, division_id, player_num, week_key desc, created_at desc;

create or replace view public.player_playoff_eligibility_current
with (security_invoker = true)
as
select distinct on (season_id, division_id, player_num)
  id, division_id, player_num, player_name, team_num, elig_code,
  week_key, label, created_at, season_id
from public.player_playoff_eligibility
where player_num is not null
order by season_id, division_id, player_num, week_key desc, created_at desc;

create or replace view public.standings_adjustments_current
with (security_invoker = true)
as
select distinct on (season_id, division_id, team_id)
  id, division_id, team_name, wins, losses, sets_for, sets_against,
  created_at, team_id, week_key, label, team_num, points_last_wk,
  total_points, sets_played, season_id
from public.standings_adjustments
where team_id is not null
order by season_id, division_id, team_id, week_key desc, created_at desc;
