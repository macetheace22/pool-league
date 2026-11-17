-- Section 90: manager review of IBA schedule changes

alter table public.iba_schedule_monitor_checks
  add column if not exists review_status text not null default 'not_required'
    check (review_status in ('not_required', 'pending', 'approved', 'rejected')),
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

update public.iba_schedule_monitor_checks
set review_status = case when status = 'changes_found' then 'pending' else 'not_required' end
where review_status = 'not_required';

create index if not exists iba_schedule_monitor_checks_review_idx
  on public.iba_schedule_monitor_checks (review_status, checked_at desc);

revoke update on public.iba_schedule_monitor_checks from authenticated;
grant update (review_status, reviewed_by, reviewed_at, review_note)
  on public.iba_schedule_monitor_checks to authenticated;

drop policy if exists "Managers can review IBA schedule monitor checks"
  on public.iba_schedule_monitor_checks;

create policy "Managers can review IBA schedule monitor checks"
  on public.iba_schedule_monitor_checks
  for update to authenticated
  using (
    public.current_role_name() = 'manager'
    and review_status = 'pending'
  )
  with check (
    public.current_role_name() = 'manager'
    and review_status in ('approved', 'rejected')
    and reviewed_by = (select auth.uid())
  );

-- Verification:
-- select review_status, count(*) from public.iba_schedule_monitor_checks group by review_status;
-- select has_table_privilege('authenticated', 'public.iba_schedule_monitor_checks', 'UPDATE') as update_granted;
-- select count(*) from pg_policies where schemaname='public'
--   and tablename='iba_schedule_monitor_checks'
--   and policyname='Managers can review IBA schedule monitor checks';
