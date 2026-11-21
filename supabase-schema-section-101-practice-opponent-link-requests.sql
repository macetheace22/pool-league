-- Section 101: mutual confirmation when linking a manually-entered
-- practice opponent to a real account.
--
-- The existing practice_opponents row remains the durable identity anchor.
-- Accepting a request updates linked_profile_id on that row, so all existing
-- practice_games that reference opponent_id retain their history unchanged.
--
-- Request records are private implementation data. All access is through
-- narrowly-scoped authenticated RPCs; the table itself is not exposed through
-- the Supabase Data API.

create table if not exists public.practice_opponent_link_requests (
  id uuid primary key default gen_random_uuid(),
  opponent_id uuid not null references public.practice_opponents(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  target_profile_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  responded_at timestamptz,
  constraint practice_opponent_link_requests_not_self
    check (requested_by <> target_profile_id)
);

create unique index if not exists practice_opponent_link_requests_one_pending_per_opponent
  on public.practice_opponent_link_requests (opponent_id)
  where status = 'pending';

create index if not exists practice_opponent_link_requests_target_pending
  on public.practice_opponent_link_requests (target_profile_id, created_at desc)
  where status = 'pending';

alter table public.practice_opponent_link_requests enable row level security;

-- Do not expose request rows directly. The RPCs below return only the fields
-- needed by the two participants and enforce auth.uid() in every operation.
revoke all on table public.practice_opponent_link_requests from public, anon, authenticated;
-- Explicitly grant only SELECT for Data API role configuration consistency.
-- There is intentionally no SELECT policy, so RLS returns no rows to clients;
-- all real access remains through the authenticated, scoped RPCs.
grant select on table public.practice_opponent_link_requests to authenticated;
-- Explicit Data API grants for authenticated callers; RLS has no policies,
-- so direct table reads/writes remain denied. All supported access is via RPC.
grant select, insert, update, delete on table public.practice_opponent_link_requests to authenticated;

create or replace function public.request_practice_opponent_link(
  p_opponent_id uuid,
  p_target_profile_id uuid
)
returns table(request_id uuid, result_status text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_owner uuid;
  v_linked_profile uuid;
  v_request_id uuid;
  v_existing_target uuid;
begin
  if (select auth.uid()) is null then
    return query select null::uuid, 'NOT_AUTHENTICATED'::text;
    return;
  end if;

  if p_target_profile_id is null or p_target_profile_id = (select auth.uid()) then
    return query select null::uuid, 'INVALID_TARGET'::text;
    return;
  end if;

  select o.created_by, o.linked_profile_id
    into v_owner, v_linked_profile
  from public.practice_opponents o
  where o.id = p_opponent_id
  for update;

  if not found then
    return query select null::uuid, 'NOT_FOUND'::text;
    return;
  end if;

  if v_owner <> (select auth.uid()) then
    return query select null::uuid, 'NOT_AUTHORIZED'::text;
    return;
  end if;

  if v_linked_profile is not null then
    return query select null::uuid, 'ALREADY_LINKED'::text;
    return;
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = p_target_profile_id
      and p.is_active is true
  ) then
    return query select null::uuid, 'TARGET_NOT_FOUND'::text;
    return;
  end if;

  update public.practice_opponent_link_requests r
  set status = 'expired', responded_at = now()
  where r.opponent_id = p_opponent_id
    and r.status = 'pending'
    and r.expires_at <= now();

  select r.id, r.target_profile_id
    into v_request_id, v_existing_target
  from public.practice_opponent_link_requests r
  where r.opponent_id = p_opponent_id
    and r.status = 'pending'
  limit 1;

  if v_request_id is not null then
    if v_existing_target = p_target_profile_id then
      return query select v_request_id, 'PENDING'::text;
    else
      return query select v_request_id, 'PENDING_EXISTS'::text;
    end if;
    return;
  end if;

  insert into public.practice_opponent_link_requests (
    opponent_id, requested_by, target_profile_id
  )
  values (p_opponent_id, (select auth.uid()), p_target_profile_id)
  returning id into v_request_id;

  return query select v_request_id, 'PENDING'::text;
end;
$function$;

create or replace function public.list_practice_opponent_link_requests()
returns table(
  request_id uuid,
  opponent_id uuid,
  opponent_name text,
  requester_id uuid,
  requester_username text,
  target_profile_id uuid,
  target_username text,
  status text,
  created_at timestamptz,
  expires_at timestamptz,
  direction text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    r.id,
    r.opponent_id,
    o.name,
    r.requested_by,
    requester.username,
    r.target_profile_id,
    target.username,
    r.status,
    r.created_at,
    r.expires_at,
    case
      when r.target_profile_id = (select auth.uid()) then 'incoming'
      else 'outgoing'
    end
  from public.practice_opponent_link_requests r
  join public.practice_opponents o on o.id = r.opponent_id
  left join public.profiles requester on requester.id = r.requested_by
  left join public.profiles target on target.id = r.target_profile_id
  where (r.requested_by = (select auth.uid())
    or r.target_profile_id = (select auth.uid()))
    and (select auth.uid()) is not null
  order by r.created_at desc
  limit 50;
$function$;

create or replace function public.respond_practice_opponent_link(
  p_request_id uuid,
  p_accept boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_opponent_id uuid;
  v_request public.practice_opponent_link_requests%rowtype;
  v_linked_profile uuid;
  v_opponent_exists boolean := false;
begin
  if (select auth.uid()) is null then
    return 'NOT_AUTHENTICATED';
  end if;

  -- Resolve the opponent, then lock it before locking the request. Request
  -- creation uses the same opponent-first lock order.
  select r.opponent_id
    into v_opponent_id
  from public.practice_opponent_link_requests r
  where r.id = p_request_id;

  if not found then
    return 'NOT_FOUND';
  end if;

  select o.linked_profile_id, true
    into v_linked_profile, v_opponent_exists
  from public.practice_opponents o
  where o.id = v_opponent_id
  for update;

  select r.*
    into v_request
  from public.practice_opponent_link_requests r
  where r.id = p_request_id
  for update;

  if not found then
    return 'NOT_FOUND';
  end if;

  if v_request.target_profile_id <> (select auth.uid()) then
    return 'NOT_AUTHORIZED';
  end if;

  if v_request.status <> 'pending' then
    return upper(v_request.status);
  end if;

  if v_request.expires_at <= now() then
    update public.practice_opponent_link_requests
    set status = 'expired', responded_at = now()
    where id = p_request_id;
    return 'EXPIRED';
  end if;

  if not v_opponent_exists or v_linked_profile is not null then
    update public.practice_opponent_link_requests
    set status = 'cancelled', responded_at = now()
    where id = p_request_id;
    if v_linked_profile = (select auth.uid()) then
      return 'ALREADY_LINKED';
    end if;
    return 'OPPONENT_UNAVAILABLE';
  end if;

  if p_accept is true then
    update public.practice_opponents
    set linked_profile_id = (select auth.uid())
    where id = v_opponent_id
      and linked_profile_id is null;

    if not found then
      update public.practice_opponent_link_requests
      set status = 'cancelled', responded_at = now()
      where id = p_request_id;
      return 'OPPONENT_UNAVAILABLE';
    end if;

    update public.practice_opponent_link_requests
    set status = 'accepted', responded_at = now()
    where id = p_request_id;
    return 'ACCEPTED';
  end if;

  update public.practice_opponent_link_requests
  set status = 'declined', responded_at = now()
  where id = p_request_id;
  return 'DECLINED';
end;
$function$;

create or replace function public.cancel_practice_opponent_link_request(
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null then
    return false;
  end if;

  update public.practice_opponent_link_requests
  set status = 'cancelled', responded_at = now()
  where id = p_request_id
    and requested_by = (select auth.uid())
    and status = 'pending';

  return found;
end;
$function$;

revoke all on function public.request_practice_opponent_link(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_practice_opponent_link_requests() from public, anon, authenticated;
revoke all on function public.respond_practice_opponent_link(uuid, boolean) from public, anon, authenticated;
revoke all on function public.cancel_practice_opponent_link_request(uuid) from public, anon, authenticated;

grant execute on function public.request_practice_opponent_link(uuid, uuid) to authenticated;
grant execute on function public.list_practice_opponent_link_requests() to authenticated;
grant execute on function public.respond_practice_opponent_link(uuid, boolean) to authenticated;
grant execute on function public.cancel_practice_opponent_link_request(uuid) to authenticated;

comment on table public.practice_opponent_link_requests is
  'Private, expiring mutual-confirmation requests to link a creator-owned guest practice opponent to an authenticated profile.';
