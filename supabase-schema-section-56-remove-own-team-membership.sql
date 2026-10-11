-- Section 56: self-service removal of a manager's own team membership.
--
-- This is intentionally narrower than remove_player_from_team(): it does not
-- remove a player from the team's roster, change captain assignments, or
-- delete history. It only ends the authenticated manager's own active
-- profile_team_memberships row. This matches the Profile -> My Teams UI.
create or replace function public.remove_own_team_membership(p_team_id uuid)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path = 'public'
as $function$
begin
  if auth.uid() is null then
    return query select false, 'AUTH_REQUIRED'; return;
  end if;

  if public.current_role_name() is distinct from 'manager' then
    return query select false, 'MANAGER_ONLY'; return;
  end if;

  if p_team_id is null then
    return query select false, 'TEAM_REQUIRED'; return;
  end if;

  update public.profile_team_memberships
  set ended_at = now()
  where profile_id = auth.uid()
    and team_id = p_team_id
    and ended_at is null;

  if not found then
    return query select false, 'MEMBERSHIP_NOT_FOUND'; return;
  end if;

  return query select true, null::text;
end;
$function$;

revoke execute on function public.remove_own_team_membership(uuid) from public, anon;
grant execute on function public.remove_own_team_membership(uuid) to authenticated;

-- Post-apply verification:
-- select has_function_privilege('anon', 'public.remove_own_team_membership(uuid)', 'EXECUTE') as anon_exec,
--        has_function_privilege('authenticated', 'public.remove_own_team_membership(uuid)', 'EXECUTE') as authenticated_exec;
-- Expected: false, true.
