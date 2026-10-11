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
