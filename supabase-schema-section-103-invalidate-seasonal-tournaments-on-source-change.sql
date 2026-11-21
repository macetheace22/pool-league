-- Section 103: invalidate confirmed seasonal tournament plans when authoritative inputs change.
-- Both IBA playoff-bracket imports and live-scored playoff results write playoff_matches.
-- Official IBA standings imports write standings_adjustments.
-- This migration marks affected, unfinished seasonal tournaments for manager review;
-- it never rewrites a seasonal match or changes a completed/cancelled tournament.

begin;

alter table public.seasonal_tournaments
  drop constraint if exists seasonal_tournaments_status_check;

alter table public.seasonal_tournaments
  add constraint seasonal_tournaments_status_check
  check (status in ('confirmed', 'in_progress', 'needs_review', 'completed', 'cancelled'));

alter table public.seasonal_tournaments
  add column if not exists review_required_at timestamptz,
  add column if not exists review_reason text;

grant update (status, review_required_at, review_reason)
  on public.seasonal_tournaments to authenticated;

drop policy if exists seasonal_tournaments_manager_update on public.seasonal_tournaments;
create policy seasonal_tournaments_manager_update
  on public.seasonal_tournaments for update to authenticated
  using ((select public.current_role_name()) = 'manager')
  with check ((select public.current_role_name()) = 'manager');

create or replace function public.mark_seasonal_tournaments_for_review(p_division_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_season_id uuid;
  v_count integer;
begin
  select d.season_id into v_season_id
    from public.divisions d
   where d.id = p_division_id;

  if v_season_id is null then
    return 0;
  end if;

  update public.seasonal_tournaments
     set status = 'needs_review',
         review_required_at = now(),
         review_reason = left(coalesce(p_reason, 'Authoritative playoff source changed.'), 500),
         updated_at = now()
   where season_id = v_season_id
     and status in ('confirmed', 'in_progress');

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.mark_seasonal_tournaments_for_review(uuid, text) from public, anon, authenticated;

create or replace function public.invalidate_seasonal_tournament_after_playoff_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_division_id uuid;
begin
  if tg_op = 'DELETE' then
    v_division_id := old.division_id;
  else
    v_division_id := new.division_id;
  end if;

  perform public.mark_seasonal_tournaments_for_review(
    v_division_id,
    case
      when tg_table_name = 'playoff_matches' then 'IBA playoff bracket or recorded playoff result changed.'
      else 'Official IBA standings import changed.'
    end
  );

  if tg_op = 'UPDATE' and old.division_id is distinct from new.division_id then
    perform public.mark_seasonal_tournaments_for_review(
      old.division_id,
      'A playoff or standings record moved to another division.'
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

revoke all on function public.invalidate_seasonal_tournament_after_playoff_change() from public, anon, authenticated;

drop trigger if exists invalidate_seasonal_tournament_on_playoff_change on public.playoff_matches;
create trigger invalidate_seasonal_tournament_on_playoff_change
  after insert or update or delete on public.playoff_matches
  for each row execute function public.invalidate_seasonal_tournament_after_playoff_change();

drop trigger if exists invalidate_seasonal_tournament_on_standings_change on public.standings_adjustments;
create trigger invalidate_seasonal_tournament_on_standings_change
  after insert or update or delete on public.standings_adjustments
  for each row execute function public.invalidate_seasonal_tournament_after_playoff_change();

commit;
