-- Section 102: allow the person represented by a guest practice opponent
-- to initiate a claim with a one-time code, while requiring the record owner
-- to approve it. The guest opponent row and all historical games are retained.

alter table public.practice_opponent_link_requests
  add column if not exists link_profile_id uuid references public.profiles(id) on delete cascade;

-- Requests created by the Section 101 owner-initiated flow link the recipient.
update public.practice_opponent_link_requests
set link_profile_id = target_profile_id
where link_profile_id is null;

alter table public.practice_opponent_link_requests
  alter column link_profile_id set not null;

create table if not exists public.practice_opponent_claim_codes (
  code uuid primary key default gen_random_uuid(),
  opponent_id uuid not null references public.practice_opponents(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  redeemed_at timestamptz,
  revoked_at timestamptz
);

create index if not exists practice_opponent_claim_codes_owner_active
  on public.practice_opponent_claim_codes (opponent_id, expires_at)
  where redeemed_at is null and revoked_at is null;

alter table public.practice_opponent_claim_codes enable row level security;
revoke all on public.practice_opponent_claim_codes from public, anon, authenticated;
-- Explicit authenticated grant for Data API role consistency. There is no
-- SELECT policy, so direct reads remain blocked by RLS; RPCs are the interface.
grant select on public.practice_opponent_claim_codes to authenticated;

create or replace function public.create_practice_opponent_claim_code(
  p_opponent_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_owner uuid;
  v_linked_profile uuid;
  v_code uuid;
begin
  if (select auth.uid()) is null then
    return null;
  end if;

  select o.created_by, o.linked_profile_id
    into v_owner, v_linked_profile
  from public.practice_opponents o
  where o.id = p_opponent_id
  for update;

  if not found or v_owner <> (select auth.uid()) or v_linked_profile is not null then
    return null;
  end if;

  -- One live code per guest opponent. Reissuing invalidates prior codes.
  update public.practice_opponent_claim_codes
  set revoked_at = now()
  where opponent_id = p_opponent_id
    and redeemed_at is null
    and revoked_at is null;

  insert into public.practice_opponent_claim_codes (opponent_id, created_by)
  values (p_opponent_id, (select auth.uid()))
  returning code into v_code;

  return v_code::text;
end;
$function$;

create or replace function public.redeem_practice_opponent_claim_code(
  p_code text
)
returns table(request_id uuid, result_status text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_code public.practice_opponent_claim_codes%rowtype;
  v_owner uuid;
  v_linked_profile uuid;
  v_request_id uuid;
begin
  if (select auth.uid()) is null then
    return query select null::uuid, 'NOT_AUTHENTICATED'::text;
    return;
  end if;

  select c.*
    into v_code
  from public.practice_opponent_claim_codes c
  where c.code::text = lower(trim(p_code))
  for update;

  if not found then
    return query select null::uuid, 'INVALID_CODE'::text;
    return;
  end if;

  if v_code.created_by = (select auth.uid()) then
    return query select null::uuid, 'OWN_CODE'::text;
    return;
  end if;

  if v_code.redeemed_at is not null or v_code.revoked_at is not null then
    return query select null::uuid, 'CODE_USED'::text;
    return;
  end if;

  if v_code.expires_at <= now() then
    update public.practice_opponent_claim_codes
    set revoked_at = now()
    where code = v_code.code;
    return query select null::uuid, 'CODE_EXPIRED'::text;
    return;
  end if;

  select o.created_by, o.linked_profile_id
    into v_owner, v_linked_profile
  from public.practice_opponents o
  where o.id = v_code.opponent_id
  for update;

  if not found or v_owner <> v_code.created_by or v_linked_profile is not null then
    update public.practice_opponent_claim_codes
    set revoked_at = now()
    where code = v_code.code;
    return query select null::uuid, 'OPPONENT_UNAVAILABLE'::text;
    return;
  end if;

  update public.practice_opponent_link_requests
  set status = 'expired', responded_at = now()
  where opponent_id = v_code.opponent_id
    and status = 'pending'
    and expires_at <= now();

  if exists (
    select 1 from public.practice_opponent_link_requests r
    where r.opponent_id = v_code.opponent_id and r.status = 'pending'
  ) then
    return query select null::uuid, 'PENDING_EXISTS'::text;
    return;
  end if;

  insert into public.practice_opponent_link_requests (
    opponent_id, requested_by, target_profile_id, link_profile_id
  )
  values (
    v_code.opponent_id, (select auth.uid()), v_owner, (select auth.uid())
  )
  returning id into v_request_id;

  update public.practice_opponent_claim_codes
  set redeemed_at = now()
  where code = v_code.code;

  return query select v_request_id, 'PENDING'::text;
end;
$function$;

-- Keep the original owner-initiated flow compatible with the new explicit
-- link target column.
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
    select 1 from public.profiles p
    where p.id = p_target_profile_id and p.is_active is true
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
  where r.opponent_id = p_opponent_id and r.status = 'pending'
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
    opponent_id, requested_by, target_profile_id, link_profile_id
  )
  values (
    p_opponent_id, (select auth.uid()), p_target_profile_id, p_target_profile_id
  )
  returning id into v_request_id;

  return query select v_request_id, 'PENDING'::text;
end;
$function$;

-- The account receiving a request approves the exact profile identified by
-- link_profile_id. This covers both directions without changing ownership.
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
  v_opponent_found boolean := false;
begin
  if (select auth.uid()) is null then
    return 'NOT_AUTHENTICATED';
  end if;

  select r.opponent_id
    into v_opponent_id
  from public.practice_opponent_link_requests r
  where r.id = p_request_id;

  if not found then
    return 'NOT_FOUND';
  end if;

  select o.linked_profile_id
    into v_linked_profile
  from public.practice_opponents o
  where o.id = v_opponent_id
  for update;

  v_opponent_found := found;

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

  if not v_opponent_found or v_linked_profile is not null then
    update public.practice_opponent_link_requests
    set status = 'cancelled', responded_at = now()
    where id = p_request_id;
    return 'OPPONENT_UNAVAILABLE';
  end if;

  if p_accept is true then
    update public.practice_opponents
    set linked_profile_id = v_request.link_profile_id
    where id = v_opponent_id and linked_profile_id is null;

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

-- Section 101 already created this function with a different return shape.
-- PostgreSQL cannot change a function's OUT/RETURNS TABLE signature via
-- CREATE OR REPLACE, so explicitly drop the old zero-argument overload first.
drop function if exists public.list_practice_opponent_link_requests();

create function public.list_practice_opponent_link_requests()
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
  direction text,
  link_type text
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
    case when r.target_profile_id = (select auth.uid()) then 'incoming' else 'outgoing' end,
    case when r.link_profile_id = r.requested_by then 'claim' else 'link' end
  from public.practice_opponent_link_requests r
  join public.practice_opponents o on o.id = r.opponent_id
  left join public.profiles requester on requester.id = r.requested_by
  left join public.profiles target on target.id = r.target_profile_id
  where (r.requested_by = (select auth.uid()) or r.target_profile_id = (select auth.uid()))
    and (select auth.uid()) is not null
  order by r.created_at desc
  limit 50;
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

revoke all on function public.create_practice_opponent_claim_code(uuid) from public, anon, authenticated;
revoke all on function public.redeem_practice_opponent_claim_code(text) from public, anon, authenticated;
revoke all on function public.request_practice_opponent_link(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_practice_opponent_link_requests() from public, anon, authenticated;
revoke all on function public.respond_practice_opponent_link(uuid, boolean) from public, anon, authenticated;
revoke all on function public.cancel_practice_opponent_link_request(uuid) from public, anon, authenticated;

grant execute on function public.create_practice_opponent_claim_code(uuid) to authenticated;
grant execute on function public.redeem_practice_opponent_claim_code(text) to authenticated;
grant execute on function public.request_practice_opponent_link(uuid, uuid) to authenticated;
grant execute on function public.list_practice_opponent_link_requests() to authenticated;
grant execute on function public.respond_practice_opponent_link(uuid, boolean) to authenticated;
grant execute on function public.cancel_practice_opponent_link_request(uuid) to authenticated;
