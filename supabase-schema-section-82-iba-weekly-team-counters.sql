-- Section 82: persist team-specific IBA weekly Play/Win counters
--
-- Each row is one player's cumulative IBA counter snapshot for one team,
-- division, and report week. A player on multiple teams gets a separate
-- row per team. Multiple report versions are retained by content hash.
-- Reports with no Play/Win values (including playoff eligibility-only
-- imports) do not create match-counter snapshots.

create table if not exists public.iba_player_weekly_counters (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  team_num text not null,
  player_num text not null references public.players(num) on delete restrict,
  report_week integer not null check (report_week > 0),
  schedule_week_date date,
  report_printed_on_date date,
  matches_played integer check (matches_played is null or matches_played >= 0),
  matches_won integer check (matches_won is null or matches_won >= 0),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  source text not null check (source in ('automatic', 'manual')),
  imported_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  imported_at timestamptz not null default now(),
  constraint iba_player_weekly_counters_wins_not_over_played
    check (matches_played is null or matches_won is null or matches_won <= matches_played),
  constraint iba_player_weekly_counters_snapshot_unique
    unique (season_id, division_id, team_id, player_num, report_week, content_sha256)
);

create index if not exists iba_player_weekly_counters_team_week_idx
  on public.iba_player_weekly_counters (season_id, division_id, team_id, report_week, player_num);

create index if not exists iba_player_weekly_counters_player_history_idx
  on public.iba_player_weekly_counters (season_id, player_num, report_week desc);

alter table public.iba_player_weekly_counters enable row level security;

drop policy if exists "Managers can read IBA weekly team counters" on public.iba_player_weekly_counters;
create policy "Managers can read IBA weekly team counters"
  on public.iba_player_weekly_counters for select to authenticated
  using (public.current_role_name() = 'manager');

drop policy if exists "Managers can record IBA weekly team counters" on public.iba_player_weekly_counters;
create policy "Managers can record IBA weekly team counters"
  on public.iba_player_weekly_counters for insert to authenticated
  with check (
    public.current_role_name() = 'manager'
    and imported_by = (select auth.uid())
  );

revoke all on public.iba_player_weekly_counters from public, anon, authenticated;
grant select, insert on public.iba_player_weekly_counters to authenticated;

-- Verify after applying:
-- select tablename, rowsecurity
-- from pg_tables
-- where schemaname = 'public'
--   and tablename = 'iba_player_weekly_counters';
--
-- select count(*) as weekly_counter_snapshot_rows
-- from public.iba_player_weekly_counters;
