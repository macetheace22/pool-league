-- Section 55: restrict anonymous access to RPCs that are not part of signup.
--
-- The following functions are used by authenticated app flows and/or RLS
-- policies. Anonymous callers do not need to invoke them directly. Keep
-- authenticated execution because the app and policies rely on these helpers.
--
-- Intentionally leave anonymous execution enabled for the signup/bootstrap
-- RPCs is_bootstrap_needed(), is_username_taken(text), and
-- validate_invite_code(text).

revoke execute on function public.can_write_practice_shot_event(uuid, text) from public, anon;
grant execute on function public.can_write_practice_shot_event(uuid, text) to authenticated;

revoke execute on function public.can_write_unavailability(uuid, text) from public, anon;
grant execute on function public.can_write_unavailability(uuid, text) to authenticated;

revoke execute on function public.current_role_name() from public, anon;
grant execute on function public.current_role_name() to authenticated;

revoke execute on function public.is_on_team(uuid) from public, anon;
grant execute on function public.is_on_team(uuid) to authenticated;

revoke execute on function public.is_team_captain(uuid) from public, anon;
grant execute on function public.is_team_captain(uuid) to authenticated;

revoke execute on function public.is_team_member(uuid) from public, anon;
grant execute on function public.is_team_member(uuid) to authenticated;

revoke execute on function public.list_linked_player_nums(text[]) from public, anon;
grant execute on function public.list_linked_player_nums(text[]) to authenticated;

revoke execute on function public.list_user_last_sign_ins() from public, anon;
grant execute on function public.list_user_last_sign_ins() to authenticated;

revoke execute on function public.reopen_match_for_editing(uuid) from public, anon;
grant execute on function public.reopen_match_for_editing(uuid) to authenticated;

revoke execute on function public.search_profiles_by_username(text) from public, anon;
grant execute on function public.search_profiles_by_username(text) to authenticated;

revoke execute on function public.set_own_player_number(text) from public, anon;
grant execute on function public.set_own_player_number(text) to authenticated;

-- Legacy RPC retained for compatibility for now; its body checks manager role.
-- Anonymous callers have no reason to invoke it.
revoke execute on function public.set_team_captain(uuid, uuid) from public, anon;
grant execute on function public.set_team_captain(uuid, uuid) to authenticated;

-- Verification after applying:
-- Every function above should report anon_exec=false and authenticated_exec=true.
-- The signup/bootstrap RPCs named in the header should remain anon_exec=true.
