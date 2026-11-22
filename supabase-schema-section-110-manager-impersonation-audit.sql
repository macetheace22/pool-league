-- Audited manager impersonation events. Access is service-role only; managers
-- cannot read or modify this audit ledger through the public Data API.
begin;

create table if not exists public.manager_impersonation_events (
  id uuid primary key default gen_random_uuid(),
  manager_profile_id uuid not null references public.profiles(id) on delete restrict,
  target_profile_id uuid not null references public.profiles(id) on delete restrict,
  event_type text not null check (event_type in ('started')),
  created_at timestamptz not null default now()
);

create index if not exists manager_impersonation_events_manager_created_idx
  on public.manager_impersonation_events (manager_profile_id, created_at desc);

alter table public.manager_impersonation_events enable row level security;
revoke all on public.manager_impersonation_events from public, anon, authenticated;
grant all on public.manager_impersonation_events to service_role;

commit;
