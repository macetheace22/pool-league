-- Section 53: restrict direct execution of trigger/event-trigger functions
--
-- These functions are designed to run only through database triggers. They
-- are not application RPCs. Removing direct EXECUTE does not stop PostgreSQL
-- from invoking them when their attached trigger/event trigger fires.
--
-- SECURITY DEFINER trigger functions should not be exposed as callable RPC
-- endpoints to anon or authenticated clients.

revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;

revoke execute on function public.protect_profile_privilege_columns() from public;
revoke execute on function public.protect_profile_privilege_columns() from anon;
revoke execute on function public.protect_profile_privilege_columns() from authenticated;

revoke execute on function public.sync_player_email() from public;
revoke execute on function public.sync_player_email() from anon;
revoke execute on function public.sync_player_email() from authenticated;

revoke execute on function public.track_captaincy_history() from public;
revoke execute on function public.track_captaincy_history() from anon;
revoke execute on function public.track_captaincy_history() from authenticated;

revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.rls_auto_enable() from anon;
revoke execute on function public.rls_auto_enable() from authenticated;
