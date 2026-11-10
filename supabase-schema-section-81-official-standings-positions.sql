-- Section 81: preserve official IBA standings positions in each weekly snapshot.
-- Position is the row order in the imported division report (1 = first row).
alter table public.standings_adjustments
  add column if not exists position integer;
alter table public.mvp_adjustments
  add column if not exists position integer;

create or replace view public.standings_adjustments_current
with (security_invoker = true)
as
select distinct on (season_id, division_id, team_id)
  id, division_id, team_name, wins, losses, sets_for, sets_against,
  created_at, team_id, week_key, label, team_num, points_last_wk,
  total_points, sets_played, season_id, position
from public.standings_adjustments
where team_id is not null
order by season_id, division_id, team_id, week_key desc, created_at desc;

create or replace view public.mvp_adjustments_current
with (security_invoker = true)
as
select distinct on (season_id, division_id, player_num)
  id, division_id, player_num, player_name, wins, sets, total_points,
  note, created_at, week_key, label, team_num, losses, mvp_ranking_points, season_id,
  position
from public.mvp_adjustments
where player_num is not null
order by season_id, division_id, player_num, week_key desc, created_at desc;

notify pgrst, 'reload schema';
