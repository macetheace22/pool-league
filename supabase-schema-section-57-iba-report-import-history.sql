-- Section 57: persistent IBA weekly report import history
--
-- Apply manually in Supabase SQL Editor after reviewing. This migration adds
-- an append-only audit trail; it does not alter or delete existing league data.
-- Each row represents a successfully imported PDF for one division, report
-- category, and explicit report week. Content hashes distinguish exact
-- duplicates from changed reports for a previously imported week.

create table if not exists public.iba_report_import_history (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  division_id uuid not null references public.divisions(id) on delete cascade,
  report_type text not null check (report_type in ('rost', 'div', 'mvp')),
  report_week integer not null check (report_week > 0),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  source text not null check (source in ('automatic', 'manual')),
  metadata jsonb not null default '{}'::jsonb,
  imported_by uuid references public.profiles(id) on delete set null default auth.uid(),
  imported_at timestamptz not null default now(),
  constraint iba_report_import_history_exact_import_unique
    unique (season_id, division_id, report_type, report_week, content_sha256)
);

create index if not exists iba_report_import_history_lookup_idx
  on public.iba_report_import_history (season_id, division_id, report_type, report_week, imported_at desc);

alter table public.iba_report_import_history enable row level security;

drop policy if exists "Managers can read IBA report import history" on public.iba_report_import_history;
create policy "Managers can read IBA report import history"
  on public.iba_report_import_history for select to authenticated
  using (public.current_role_name() = 'manager');

drop policy if exists "Managers can record IBA report imports" on public.iba_report_import_history;
create policy "Managers can record IBA report imports"
  on public.iba_report_import_history for insert to authenticated
  with check (public.current_role_name() = 'manager' and imported_by = auth.uid());

revoke all on public.iba_report_import_history from public, anon;
grant select, insert on public.iba_report_import_history to authenticated;

-- Verify the table, RLS, and unique index exist after applying:
-- select tablename, rowsecurity from pg_tables
-- where schemaname = 'public' and tablename = 'iba_report_import_history';
