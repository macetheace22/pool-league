-- Section 111: accept Supabase's OTP authentication_method for the verified
-- one-time magic-link flow used by manager impersonation.
-- Apply after Section 110. This replaces only the Auth access-token hook function.

begin;

create or replace function public.manager_impersonation_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_auth_session_id uuid;
  v_session public.manager_impersonation_sessions%rowtype;
  v_pending public.manager_impersonation_pending_sessions%rowtype;
  v_claims jsonb;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_auth_session_id := (event -> 'claims' ->> 'session_id')::uuid;
  v_claims := event -> 'claims';

  if v_user_id is null or v_auth_session_id is null then
    return jsonb_build_object('claims', v_claims);
  end if;

  -- Keep the signed impersonation claims on every token refresh. An ended or
  -- expired impersonation session must not silently become a normal target session.
  select *
    into v_session
    from public.manager_impersonation_sessions
   where auth_session_id = v_auth_session_id
     and target_profile_id = v_user_id;

  if found then
    if v_session.ended_at is not null or v_session.expires_at <= now() then
      raise exception 'This manager impersonation session has ended or expired';
    end if;
    if not exists (
      select 1 from public.profiles
       where id = v_session.manager_profile_id
         and role = 'manager'
         and is_active
    ) or not exists (
      select 1 from public.profiles
       where id = v_session.target_profile_id
         and is_active
    ) then
      raise exception 'The manager or target account is no longer active for impersonation';
    end if;
  else
    -- Only the server-issued, one-time magic-link/OTP verification flow may create a session.
    -- The pending row remains target-specific, short-lived, and single-use.
    if event ->> 'authentication_method' not in ('magiclink', 'otp') then
      return jsonb_build_object('claims', v_claims);
    end if;

    with candidate as (
      select id
        from public.manager_impersonation_pending_sessions
       where target_profile_id = v_user_id
         and consumed_at is null
         and expires_at > now()
       order by created_at desc
       limit 1
       for update skip locked
    )
    update public.manager_impersonation_pending_sessions p
       set consumed_at = now()
      from candidate c
     where p.id = c.id
    returning p.* into v_pending;

    if not found then
      return jsonb_build_object('claims', v_claims);
    end if;

    if not exists (
      select 1 from public.profiles
       where id = v_pending.manager_profile_id
         and role = 'manager'
         and is_active
    ) or not exists (
      select 1 from public.profiles
       where id = v_pending.target_profile_id
         and is_active
    ) then
      raise exception 'The manager or target account is no longer active for impersonation';
    end if;

    insert into public.manager_impersonation_sessions (
      auth_session_id, manager_profile_id, target_profile_id, mode, expires_at
    ) values (
      v_auth_session_id, v_pending.manager_profile_id, v_pending.target_profile_id,
      v_pending.mode, now() + interval '8 hours'
    )
    returning * into v_session;

    insert into public.manager_impersonation_events (
      manager_profile_id, target_profile_id, impersonation_session_id, mode, event_type
    ) values (
      v_session.manager_profile_id, v_session.target_profile_id, v_session.id,
      v_session.mode, 'started'
    );
  end if;

  v_claims := jsonb_set(v_claims, '{manager_impersonator_id}', to_jsonb(v_session.manager_profile_id::text), true);
  v_claims := jsonb_set(v_claims, '{manager_impersonation_mode}', to_jsonb(v_session.mode), true);
  v_claims := jsonb_set(v_claims, '{manager_impersonation_session_id}', to_jsonb(v_session.id::text), true);

  return jsonb_build_object('claims', v_claims);
end;
$$;

revoke all on function public.manager_impersonation_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.manager_impersonation_access_token_hook(jsonb) to supabase_auth_admin;

commit;
