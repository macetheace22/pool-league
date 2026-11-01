import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

describe("security migration contracts", () => {
  it("limits own-team removal to the authenticated manager and only ends their active membership", () => {
    const sql = read("supabase-schema-section-56-remove-own-team-membership.sql");
    expect(sql).toContain("auth.uid() is null");
    expect(sql).toContain("public.current_role_name() is distinct from 'manager'");
    expect(sql).toContain("where profile_id = auth.uid()");
    expect(sql).toContain("and ended_at is null");
    expect(sql).toContain("set ended_at = now()");
    expect(sql).toContain("revoke execute on function public.remove_own_team_membership(uuid) from public, anon");
    expect(sql).toContain("grant execute on function public.remove_own_team_membership(uuid) to authenticated");
    expect(sql.toLowerCase()).not.toContain("delete from public.rosters");
    expect(sql.toLowerCase()).not.toContain("delete from public.profile_team_memberships");
    expect(sql.toLowerCase()).not.toContain("update public.teams");
    expect(sql.toLowerCase()).not.toContain("update public.profiles");
  });

  it("keeps non-signup security-definer RPCs off the anonymous role", () => {
    const sql = read("supabase-schema-section-55-restrict-anonymous-rpc-execution.sql");
    for (const signature of [
      "can_write_practice_shot_event(uuid, text)",
      "can_write_unavailability(uuid, text)",
      "current_role_name()",
      "is_on_team(uuid)",
      "is_team_captain(uuid)",
      "is_team_member(uuid)",
      "list_linked_player_nums(text[])",
      "list_user_last_sign_ins()",
      "reopen_match_for_editing(uuid)",
      "search_profiles_by_username(text)",
      "set_own_player_number(text)",
      "set_team_captain(uuid, uuid)",
    ]) {
      expect(sql).toContain(`revoke execute on function public.${signature} from public, anon`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
    for (const publicFlow of ["is_bootstrap_needed()", "is_username_taken(text)", "validate_invite_code(text)"]) {
      expect(sql).toContain(publicFlow);
    }
  });
  it("wires profile team removal to the guarded RPC and hides it from non-managers", () => {
    const admin = read("src/AdminApp.jsx");
    const db = read("src/db.js");
    expect(admin).toContain('profile.role === "manager" && (');
    expect(admin).toContain('onClick={() => removeOwnTeam(m)}');
    expect(admin).toContain('db.removeOwnTeamMembership(membership.team_id)');
    expect(admin).toContain('window.confirm');
    expect(db).toContain('supabase.rpc("remove_own_team_membership", { p_team_id: teamId })');
  });
});


describe("manager and captain role separation", () => {
  it("preserves manager authority when captain assignments are added or claimed", () => {
    const sql = read("supabase-schema-section-77-preserve-manager-role-during-captain-assignment.sql");
    expect(sql).toContain("set role = case when role = 'manager' then 'manager' else 'captain' end");
    expect(sql).toContain("set role = case when role = 'manager' then 'manager' else 'captain' end,");
    expect(sql).toContain("public.assign_team_captain(p_team_id, p_profile_id)");
    expect(sql).toContain("public.remove_team_captain(p_team_id, v_current_captain)");
    expect(sql).toContain("revoke all on function public.set_team_captain(uuid, uuid) from public, anon");
    expect(sql).toContain("public.teams");
    expect(sql).toContain("where captain_profile_id = p_profile_id");
    expect(sql).toContain("perform public.remove_team_captain(v_team_id, p_profile_id)");
    expect(sql).toContain("revoke all on function public.assign_team_captain(uuid, uuid) from public, anon");
    expect(sql).toContain("grant execute on function public.claim_invite_code(text) to authenticated");
    expect(sql).toContain("perform set_config('app.bypass_privilege_check', 'true', true)");
    expect(sql).toContain("for update");
  });
});


describe("captain navigation follows team assignments", () => {
  it("shows Manage My Team to a manager or player with an explicit captain assignment", () => {
    const shell = read("src/Shell.jsx");
    expect(shell).toContain('item.key === "myteam"');
    expect(shell).toContain("(profile.captain_team_ids ?? []).length > 0");
  });
});


describe("player identity linking requires trusted invites", () => {
  it("does not accept user-editable player numbers at registration", () => {
    const auth = read("src/AuthContext.jsx");
    expect(auth).not.toContain("player_num: playerNum.trim()");
    expect(auth).toContain("invite_code: code.trim()");
  });
  it("limits direct player-number corrections to managers", () => {
    const migration = read("supabase-schema-section-78-protect-player-number-linking.sql");
    expect(migration).toContain("raw_user_meta_data->>'invite_code'");
    expect(migration).not.toContain("raw_user_meta_data->>'player_num'");
    expect(migration).toContain("pg_advisory_xact_lock(118004, 1)");
    expect(migration).toContain("for update");
    expect(migration).toContain("PLAYER_NUMBER_REQUIRES_MANAGER_OR_INVITE");
    expect(migration).toContain("new.player_num := old.player_num");
    expect(migration).toContain("set_config('app.bypass_privilege_check', 'true', true)");
    expect(migration).toContain("create or replace function public.remove_player_from_team");
    expect(migration).toContain("if v_invite.code is not null then");
    const admin = read("src/AdminApp.jsx");
    expect(admin).toContain('profile.role === "manager" ? (');
  });
});


describe("RLS auth.uid initplan optimization", () => {
  it("uses scalar subqueries for auth.uid() in the affected policies", () => {
    const sql = read("supabase-schema-section-80-optimize-rls-auth-initplans.sql");
    expect((sql.match(/\(select auth\.uid\(\)\)/g) || []).length).toBeGreaterThanOrEqual(9);
    expect(sql).toContain('drop policy if exists "read own profile"');
    expect(sql).toContain('drop policy if exists "log or manage own shot events"');
    expect(sql).toContain("public.can_write_practice_shot_event(context_id, player_num)");
  });
});
