-- Section 97: IBA schedule import history for dropout/replacement resolution
create table if not exists public.iba_schedule_import_snapshots (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  import_id uuid not null default gen_random_uuid(),
  phase text not null check (phase in ('before', 'after')),
  source text not null default 'automatic' check (source in ('automatic', 'manual')),
  report_week integer,
  report_printed_on_date date,
  schedule_state jsonb not null,
  created_at timestamptz not null default now(),
  constraint iba_schedule_import_snapshots_import_phase_unique unique (import_id, phase),
  constraint iba_schedule_import_snapshots_report_week_check check (report_week is null or report_week > 0),
  constraint iba_schedule_import_snapshots_state_object_check check (jsonb_typeof(schedule_state) = 'object')
);

create index if not exists idx_iba_schedule_import_snapshots_division_created
  on public.iba_schedule_import_snapshots (division_id, created_at desc);

create index if not exists idx_iba_schedule_import_snapshots_season_division_week
  on public.iba_schedule_import_snapshots (season_id, division_id, report_week, created_at desc);

alter table public.iba_schedule_import_snapshots enable row level security;

revoke all on public.iba_schedule_import_snapshots from anon, authenticated;
grant select, insert on public.iba_schedule_import_snapshots to authenticated;

drop policy if exists "Managers can read IBA schedule import snapshots" on public.iba_schedule_import_snapshots;
create policy "Managers can read IBA schedule import snapshots"
  on public.iba_schedule_import_snapshots
  for select
  to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'manager'
  ));

drop policy if exists "Managers can insert IBA schedule import snapshots" on public.iba_schedule_import_snapshots;
create policy "Managers can insert IBA schedule import snapshots"
  on public.iba_schedule_import_snapshots
  for insert
  to authenticated
  with check (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'manager'
  ));
