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


describe("Section 8.1 authoritative roster import", () => {
  it("uses the shared full-division planner, explicit ambiguity confirmation, and automatic routing safeguards", () => {
    const db = read("src/db.js");
    const helper = read("src/rosterReconciliation.js");
    const admin = read("src/AdminAppCore.jsx");
    const auto = read("src/ibaAutoSync.js");
    expect(db).toContain('import { buildRosterSyncPlan } from "./rosterReconciliation"');
    expect(db).toContain('supabase.rpc("sync_imported_team_rosters"');
    expect(db).toContain("weekTag?.unmatchedTeamNums");
    expect(db).toContain("weekTag?.ambiguousTeamNums");
    expect(helper).toContain("every team in this division");
    expect(helper).toContain("ambiguous team placement");
    expect(helper).toContain("team.is_bye === true");
    expect(admin).toContain("ambiguousRoster: []");
    expect(auto).toContain("unmatchedTeamNums,");
    expect(auto).toContain("ambiguousTeamNums,");
  });

  it("preserves former team affiliations independently of current roster membership", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    const db = read("src/db.js");
    expect(sql).toContain("create table if not exists public.player_team_roster_history");
    expect(sql).toContain("first_added_at timestamptz not null default now()");
    expect(sql).toContain("last_seen_at timestamptz not null default now()");
    expect(sql).toContain("grant select on public.player_team_roster_history to authenticated");
    expect(sql).toContain("from public.profile_team_memberships membership");
    expect(sql).toContain("from public.completed_matches cm");
    expect(sql).toContain("track_player_team_roster_history");
    expect(db).toContain('.from("player_team_roster_history")');
    expect(sql).not.toContain("delete from public.player_division_team_assignments");
    expect(sql).not.toContain("delete from public.completed_matches");
  });

  it("removes only players absent from a complete report and leaves unchanged roster rows intact", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    expect(sql).toContain("perform public.remove_player_from_team(v_removed.team_id, v_removed.player_num)");
    expect(sql).toContain("Keep unchanged active roster rows in place");
    expect(sql).toContain("on conflict (team_id, player_num) do nothing");
    expect(sql).not.toContain("delete from public.rosters where team_id = any(v_team_ids)");
    expect(sql).toContain("ROSTER_IMPORT_INCOMPLETE_DIVISION");
    expect(sql).toContain("coalesce(expected.is_bye, false) = false");
    expect(sql).toContain("ROSTER_IMPORT_UNKNOWN_PLAYER");
    expect(sql).toContain("ROSTER_IMPORT_PLAYER_ON_MULTIPLE_TEAMS");
  });

  it("retains Section 84 approval protection for players who have already played", () => {
    const sql = read("supabase-schema-section-84-player-transfer-approval.sql");
    expect(sql).toContain("PLAYER_TRANSFER_APPROVAL_REQUIRED");
    expect(sql).toContain("if v_has_played then");
  });

  it("enforces Week 6 captain restrictions, the six-player manual cap, eight-player structural cap, and freezes", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    expect(sql).toContain("ROSTER_CHANGES_MANAGER_ONLY");
    expect(sql).toContain("ROSTER_CHANGES_FROZEN");
    expect(sql).toContain("v_roster_limit := 6");
    expect(sql).toContain("v_roster_limit integer := 8;");
    expect(sql).toContain("ROSTER_LIMIT_EIGHT");
    expect(sql).toContain("v_last_regular_week - 3");
    expect(sql).toContain("sw.is_playoff = true");
    expect(sql).toContain("create or replace function public.can_captain_change_roster");
  });

  it("keeps the official roster authoritative while flagging restricted-period rosters above six", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    const db = read("src/db.js");
    expect(sql).toContain("'overSixTeams'");
    expect(db).toContain("rosterSyncWarnings.push");
    expect(db).toContain("restricted period");
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


describe("division trigger search path hardening", () => {
  it("pins the trigger function search_path without changing its validation", () => {
    const sql = read("supabase-schema-section-79-harden-division-context-trigger.sql");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("if new.format is null or new.day is null then");
    expect(sql).toContain("return new;");
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


describe("Section 4.5 player division transfers", () => {
  it("records durable division assignments and blocks unapproved same-division roster changes", () => {
    const sql = read("supabase-schema-section-84-player-transfer-approval.sql");
    expect(sql).toContain("player_division_team_assignments");
    expect(sql).toContain("primary key (player_num, division_id)");
    expect(sql).toContain("PLAYER_TRANSFER_APPROVAL_REQUIRED");
    expect(sql).toContain("before insert or update of team_id, player_num on public.rosters");
    expect(sql).toContain("public.rosters r");
    expect(sql).toContain("has_played boolean not null default false");
    expect(sql).toContain("track_live_match_player_participation");
    expect(sql).toContain("track_completed_match_player_participation");
    expect(sql).toContain("if v_has_played then");
    expect(sql).toContain("Before the player has participated in a set");
    expect(sql).toContain("jsonb_array_length(coalesce(v_set->'racks', '[]'::jsonb)) > 0");
  });

  it("allows only receiving-team captains to request and managers to decide transfers", () => {
    const sql = read("supabase-schema-section-84-player-transfer-approval.sql");
    expect(sql).toContain("public.is_team_captain(p_to_team_id)");
    expect(sql).toContain("public.current_role_name() <> 'manager'");
    expect(sql).toContain("status in ('pending', 'approved', 'declined')");
    expect(sql).toContain("revoke all on function public.decide_player_transfer_request(uuid, boolean) from public, anon");
    expect(sql).toContain("grant execute on function public.decide_player_transfer_request(uuid, boolean) to authenticated");
    expect(sql).toContain("update public.player_division_team_assignments");
    expect(sql).toContain("delete from public.rosters");
  });

  it("routes captain roster additions through transfer requests and exposes manager decisions", () => {
    const db = read("src/db.js");
    const admin = read("src/AdminApp.jsx");
    expect(db).toContain('supabase.rpc("create_player_transfer_request"');
    expect(db).toContain('supabase.rpc("decide_player_transfer_request"');
    expect(admin).toContain("PlayerTransferRequestsTab");
    expect(admin).toContain("receiving team");
    expect(admin).toContain("League Manager for approval");
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


describe("division trigger search path hardening", () => {
  it("pins the trigger function search_path without changing its validation", () => {
    const sql = read("supabase-schema-section-79-harden-division-context-trigger.sql");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("if new.format is null or new.day is null then");
    expect(sql).toContain("return new;");
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


describe("Section 4.5 player division transfers", () => {
  it("records durable division assignments and blocks unapproved same-division roster changes", () => {
    const sql = read("supabase-schema-section-84-player-transfer-approval.sql");
    expect(sql).toContain("player_division_team_assignments");
    expect(sql).toContain("primary key (player_num, division_id)");
    expect(sql).toContain("PLAYER_TRANSFER_APPROVAL_REQUIRED");
    expect(sql).toContain("before insert or update of team_id, player_num on public.rosters");
    expect(sql).toContain("public.rosters r");
    expect(sql).toContain("has_played boolean not null default false");
    expect(sql).toContain("track_live_match_player_participation");
    expect(sql).toContain("track_completed_match_player_participation");
    expect(sql).toContain("if v_has_played then");
    expect(sql).toContain("Before the player has participated in a set");
    expect(sql).toContain("jsonb_array_length(coalesce(v_set->'racks', '[]'::jsonb)) > 0");
  });

  it("allows only receiving-team captains to request and managers to decide transfers", () => {
    const sql = read("supabase-schema-section-84-player-transfer-approval.sql");
    expect(sql).toContain("public.is_team_captain(p_to_team_id)");
    expect(sql).toContain("public.current_role_name() <> 'manager'");
    expect(sql).toContain("status in ('pending', 'approved', 'declined')");
    expect(sql).toContain("revoke all on function public.decide_player_transfer_request(uuid, boolean) from public, anon");
    expect(sql).toContain("grant execute on function public.decide_player_transfer_request(uuid, boolean) to authenticated");
    expect(sql).toContain("update public.player_division_team_assignments");
    expect(sql).toContain("delete from public.rosters");
    expect(sql).toContain("insert into public.rosters");
  });

  it("routes captain roster additions through transfer requests and exposes manager decisions", () => {
    const db = read("src/db.js");
    const admin = read("src/AdminApp.jsx");
    expect(db).toContain('supabase.rpc("create_player_transfer_request"');
    expect(db).toContain('supabase.rpc("decide_player_transfer_request"');
    expect(admin).toContain("PlayerTransferRequestsTab");
    expect(admin).toContain("receiving team");
    expect(admin).toContain("League Manager for approval");
  });
});





