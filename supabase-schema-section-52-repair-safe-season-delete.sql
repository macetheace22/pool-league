-- Section 52: repair safe season deletion
-- The season-delete RPC performs explicit cleanup for season-scoped rows
-- before deleting the division hierarchy, while preserving global players,
-- profiles, and locations.
create or replace function public.delete_season_safely(p_season_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
begin
  select p.role into v_role
    from public.profiles p
   where p.id = (select auth.uid())
     and p.is_active;

  if v_role is distinct from 'manager' then
    raise exception 'MANAGER_ONLY';
  end if;

  if not exists (select 1 from public.seasons where id = p_season_id) then
    raise exception 'SEASON_NOT_FOUND';
  end if;

  delete from public.completed_matches where season_id = p_season_id;
  delete from public.mvp_adjustments where season_id = p_season_id;
  delete from public.standings_adjustments where season_id = p_season_id;
  delete from public.player_ratings where season_id = p_season_id;
  delete from public.player_playoff_eligibility where season_id = p_season_id;

  delete from public.playoff_matches
   where division_id in (
     select d.id from public.divisions d where d.season_id = p_season_id
   );

  delete from public.shot_events
   where division_id in (
     select d.id from public.divisions d where d.season_id = p_season_id
   );

  delete from public.invite_codes
   where team_id in (
     select t.id
       from public.teams t
       join public.divisions d on d.id = t.division_id
      where d.season_id = p_season_id
   );

  delete from public.schedule_pairings
   where week_id in (
     select sw.id
       from public.schedule_weeks sw
       join public.divisions d on d.id = sw.division_id
      where d.season_id = p_season_id
   );

  delete from public.divisions where season_id = p_season_id;
  delete from public.seasons where id = p_season_id;

  return true;
end;
$function$;

revoke execute on function public.delete_season_safely(uuid) from public;
revoke execute on function public.delete_season_safely(uuid) from anon;
grant execute on function public.delete_season_safely(uuid) to authenticated;
