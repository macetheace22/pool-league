-- Section 54: guard administrative RPCs and protect captain contact details
--
-- This is a separate, reviewable migration. It does not run automatically
-- when merged. Apply through Supabase SQL Editor after reviewing.
--
-- Critical: deactivate_stale_users previously had no role check while being
-- executable by anon and authenticated users. Any caller could deactivate
-- every profile whose last sign-in / creation was older than 18 months.
-- Keep the manager workflow, but enforce it inside the SECURITY DEFINER RPC
-- and remove anonymous/public direct execution.
create or replace function public.deactivate_stale_users()
returns void
language plpgsql
security definer
set search_path = 'public'
as $function$
begin
  if public.current_role_name() is distinct from 'manager' then
    raise exception 'MANAGER_ONLY';
  end if;

  update public.profiles p
  set is_active = false
  from auth.users u
  where p.id = u.id
    and p.is_active = true
    and coalesce(u.last_sign_in_at, p.created_at) < now() - interval '18 months';
end;
$function$;

revoke execute on function public.deactivate_stale_users() from public;
revoke execute on function public.deactivate_stale_users() from anon;
grant execute on function public.deactivate_stale_users() to authenticated;

-- Captain phone numbers are returned by this function for the manager's
-- Manage App Access UI. Non-managers should not be able to enumerate them.
create or replace function public.list_team_captains()
returns table(team_id uuid, profile_id uuid, username text, phone_number text)
language plpgsql
stable
security definer
set search_path = 'public'
as $function$
begin
  if public.current_role_name() is distinct from 'manager' then
    return;
  end if;

  return query
    select t.id, p.id, p.username, p.phone_number
    from public.teams t
    join public.profiles p on p.id = t.captain_profile_id
    where t.captain_profile_id is not null
      and p.is_active;
end;
$function$;

revoke execute on function public.list_team_captains() from public;
revoke execute on function public.list_team_captains() from anon;
grant execute on function public.list_team_captains() to authenticated;
