-- Section 89: daily IBA schedule monitor check history
--
-- The scheduled monitor stores validated source snapshots and proposed
-- differences for manager review. It never writes to schedule_weeks or
-- schedule_pairings. Service-role server code writes; managers can read.

create table if not exists public.iba_schedule_monitor_checks (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  monitor_date date not null,
  status text not null check (status in ('no_changes', 'changes_found', 'incomplete')),
  snapshot_fingerprint text,
  snapshot jsonb,
  changes jsonb not null default '[]'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  error text,
  checked_at timestamptz not null default now(),
  constraint iba_schedule_monitor_checks_snapshot_shape
    check (
      (status = 'incomplete' and snapshot_fingerprint is null)
      or (status in ('no_changes', 'changes_found') and snapshot_fingerprint is not null and snapshot is not null)
    ),
  constraint iba_schedule_monitor_checks_one_per_division_day
    unique (division_id, monitor_date)
);

create index if not exists iba_schedule_monitor_checks_season_date_idx
  on public.iba_schedule_monitor_checks (season_id, monitor_date desc);
create index if not exists iba_schedule_monitor_checks_division_date_idx
  on public.iba_schedule_monitor_checks (division_id, monitor_date desc);

alter table public.iba_schedule_monitor_checks enable row level security;

drop policy if exists "Managers can read IBA schedule monitor checks"
  on public.iba_schedule_monitor_checks;
create policy "Managers can read IBA schedule monitor checks"
  on public.iba_schedule_monitor_checks
  for select to authenticated
  using (public.current_role_name() = 'manager');

revoke all on public.iba_schedule_monitor_checks from public, anon, authenticated;
grant select on public.iba_schedule_monitor_checks to authenticated;

-- Service-role server functions bypass RLS and are the only writer.
-- No client insert/update/delete grants are provided.

-- Read-only verification after applying:
-- select to_regclass('public.iba_schedule_monitor_checks') is not null as table_exists;
-- select relrowsecurity from pg_class where oid = 'public.iba_schedule_monitor_checks'::regclass;
-- select count(*) from pg_policies where schemaname = 'public' and tablename = 'iba_schedule_monitor_checks';
