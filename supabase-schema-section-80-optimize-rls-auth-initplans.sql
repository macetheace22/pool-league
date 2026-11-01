-- Section 80: avoid per-row auth.uid() evaluation in RLS policies
--
-- Supabase's database advisor identified seven policies that evaluate
-- auth.uid() once per row. Wrapping it in a scalar subquery lets PostgreSQL
-- plan it as an initplan while preserving the existing authorization rules.

drop policy if exists "read own captaincy history" on public.captaincy_history;
create policy "read own captaincy history"
  on public.captaincy_history for select to authenticated
  using (profile_id = (select auth.uid()));

drop policy if exists "Managers can record IBA report imports" on public.iba_report_import_history;
create policy "Managers can record IBA report imports"
  on public.iba_report_import_history for insert to authenticated
  with check (
    public.current_role_name() = 'manager'
    and imported_by = (select auth.uid())
  );

drop policy if exists "manage own practice games" on public.practice_games;
create policy "manage own practice games"
  on public.practice_games for all to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

drop policy if exists "manage own practice opponents" on public.practice_opponents;
create policy "manage own practice opponents"
  on public.practice_opponents for all to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "log or manage own shot events" on public.shot_events;
create policy "log or manage own shot events"
  on public.shot_events for all to authenticated
  using (
    public.current_role_name() = 'manager'
    or (
      recorded_by = (select auth.uid())
      and (
        (team_id is not null and public.is_on_team(team_id))
        or (
          team_id is null
          and context_type = 'practice_game'
          and public.can_write_practice_shot_event(context_id, player_num)
        )
      )
    )
  )
  with check (
    recorded_by = (select auth.uid())
    and (
      public.current_role_name() = 'manager'
      or (team_id is not null and public.is_on_team(team_id))
      or (
        team_id is null
        and context_type = 'practice_game'
        and public.can_write_practice_shot_event(context_id, player_num)
      )
    )
  );
