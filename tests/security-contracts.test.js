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

describe("Section 8.1 roster history preservation", () => {
  it("includes durable 8-ball break tracking schema and explicit Data API grants", () => {
    const sql = read("supabase-schema-section-86-8ball-break-tracking.sql");
    expect(sql).toContain("is_eight_ball_break boolean not null default false");
    expect(sql).toContain("balls_made_on_break integer");
    expect(sql).toContain("balls_made_on_break >= 0 and balls_made_on_break <= 8");
    expect(sql).toContain("grant select, insert, update, delete on table public.shot_events to authenticated");
  });

  it("preserves former roster membership and reads player team history from its ledger", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    const db = read("src/db.js");
    expect(sql).toContain("create table if not exists public.player_team_roster_history");
    expect(sql).toContain("track_player_team_roster_history");
    expect(sql).toContain("first_added_at timestamptz not null default now()");
    expect(sql).toContain("last_seen_at timestamptz not null default now()");
    expect(sql).toContain("grant select on public.player_team_roster_history to authenticated");
    expect(db).toContain('.from("player_team_roster_history")');
  });
});

describe("Section 8.1 import retains official roster and player history", () => {
  it("uses the shared reconciliation RPC and does not remove unchanged roster rows", () => {
    const db = read("src/db.js");
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    expect(db).toContain('supabase.rpc("sync_imported_team_rosters"');
    expect(sql).toContain("perform public.remove_player_from_team(v_removed.team_id, v_removed.player_num)");
    expect(sql).toContain("on conflict (team_id, player_num) do nothing");
    expect(sql).not.toContain("delete from public.rosters where team_id = any(v_team_ids)");
  });

  it("keeps historical roster membership readable and independent of current roster rows", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    const db = read("src/db.js");
    expect(sql).toContain("create table if not exists public.player_team_roster_history");
    expect(sql).toContain("track_player_team_roster_history");
    expect(sql).toContain("grant select on public.player_team_roster_history to authenticated");
    expect(sql).toContain("player_division_team_assignments");
    expect(sql).not.toContain("delete from public.completed_matches");
    expect(db).toContain('.from("player_team_roster_history")');
  });
});

describe("Section 8.1 roster window and import safeguards", () => {
  it("keeps Week 6 captain lock, final-four and postseason freezes, and the restricted six-player limit", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    expect(sql).toContain("ROSTER_CHANGES_MANAGER_ONLY");
    expect(sql).toContain("ROSTER_CHANGES_FROZEN");
    expect(sql).toContain("v_roster_limit := 6");
    expect(sql).toContain("v_roster_limit integer := 8;");
    expect(sql).toContain("v_last_regular_week - 3");
    expect(sql).toContain("sw.is_playoff = true");
    expect(sql).toContain("create or replace function public.can_captain_change_roster");
    expect(sql).toContain("return false;");
  });

  it("allows the official manager import to reconcile published rosters without disabling Section 84", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    const transfer = read("supabase-schema-section-84-player-transfer-approval.sql");
    expect(sql).toContain("public.current_role_name() is distinct from 'manager'");
    expect(sql).toContain("set_config('app.official_iba_roster_import', 'true', true)");
    expect(sql).toContain("ROSTER_IMPORT_INCOMPLETE_DIVISION");
    expect(sql).toContain("coalesce(expected.is_bye, false) = false");
    expect(sql).toContain("ROSTER_IMPORT_PLAYER_ON_MULTIPLE_TEAMS");
    expect(sql).toContain("ROSTER_LIMIT_EIGHT");
    expect(sql).toContain("'overSixTeams'");
    expect(transfer).toContain("PLAYER_TRANSFER_APPROVAL_REQUIRED");
    expect(transfer).toContain("if v_has_played then");
  });
});


describe("Section 8.1 automatic roster routing and history refresh", () => {
  it("fails closed when automatic reports contain unmatched or ambiguous team numbers", () => {
    const db = read("src/db.js");
    const auto = read("src/ibaAutoSync.js");
    expect(db).toContain("weekTag?.unmatchedTeamNums");
    expect(db).toContain("weekTag?.ambiguousTeamNums");
    expect(auto).toContain("const unmatchedTeamNums = Object.keys(parsed.rosters || {}).filter");
    expect(auto).toContain("unmatchedTeamNums,");
    expect(auto).toContain("ambiguousTeamNums,");
  });

  it("backfills former affiliations from completed-match participation and refreshes current imports", () => {
    const sql = read("supabase-schema-section-85-authoritative-roster-import.sql");
    expect(sql).toContain("Completed matches recover prior team associations");
    expect(sql).toContain("cm.team_home_id");
    expect(sql).toContain("cm.team_away_id");
    expect(sql).toContain("playerHome");
    expect(sql).toContain("playerAway");
    expect(sql).toContain("Refresh the last-seen timestamp for every player");
    expect(sql).toContain("last_seen_at = greatest");
  });
});


describe("Section 8.3 illegal substitution decision path", () => {
  it("records the manager decision and preserves the existing five-set forfeit model", () => {
    const db = read("src/db.js");
    const admin = read("src/AdminApp.jsx");
    expect(db).toContain("applyIllegalSubstitutionDecision");
    expect(db).toContain("section_8_3_illegal_substitution");
    expect(db).toContain("five_set_forfeit");
    expect(db).toContain("buildFullMatchForfeitSets");
    expect(db).toContain("computeMatchPoints(nextState)");
    expect(admin).toContain("Illegal Substitution");
    expect(admin).toContain("League Management decision");
    expect(admin).toContain("accept_result");
    expect(admin).toContain("five_set_forfeit");
  });
});


describe("Practice data persistence", () => {
  it("stores practice configuration in typed columns rather than target_config JSON", () => {
    const practice = read("src/Practice.jsx");
    const sql = read("supabase-schema-practice-data.sql");

    expect(practice).toContain("my_target:");
    expect(practice).toContain("opponent_target:");
    expect(practice).toContain("target_games:");
    expect(practice).toContain("table_size_feet:");
    expect(practice).not.toContain("target_config:");

    expect(sql).toContain("add column if not exists my_target integer");
    expect(sql).toContain("add column if not exists opponent_target integer");
    expect(sql).toContain("add column if not exists target_games integer");
    expect(sql).toContain("add column if not exists table_size_feet numeric(4,1)");
    expect(sql).toContain("update public.practice_games");
    expect(sql).toContain("set target_config = '{}'::jsonb");
  });

  it("uses the supported 7/8/9-foot practice table-size options", () => {
    const practice = read("src/Practice.jsx");
    expect(practice).toContain('<option value="7">7 feet</option>');
    expect(practice).toContain('<option value="8">8 feet</option>');
    expect(practice).toContain('<option value="9">9 feet</option>');
    expect(practice).toContain("Select the table size");
    expect(practice).not.toContain('step="0.1"');
  });
});


describe("Practice game result persistence", () => {
  it("stores individual results relationally and synchronizes session totals", () => {
    const practice = read("src/Practice.jsx");
    const db = read("src/db.js");
    const sql = read("supabase-schema-practice-game-results.sql");
    expect(practice).toContain("db.recordPracticeGameResult");
    expect(practice).toContain("db.undoLastPracticeGameResult");
    expect(practice).toContain("db.listPracticeGameResults");
    expect(practice).toContain("Record Rack Win");
    expect(practice).not.toContain("game_log:");
    expect(practice).toContain("function practiceSessionSnapshot(session)");
    expect(practice).toContain("gameLog, myScore, opponentScore, myPts, oppPts, winner, completedAt");
    expect(db).toContain('from("practice_game_results")');
    expect(db).toContain("record_practice_game_result");
    expect(db).toContain("undo_last_practice_game_result");
    expect(sql).toContain("create table if not exists public.practice_game_results");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("grant select, insert, update, delete on public.practice_game_results to authenticated");
    expect(sql).toContain("create or replace function public.record_practice_game_result");
    expect(sql).toContain("create or replace function public.undo_last_practice_game_result");
    expect(sql).toContain("drop column if exists game_log");
  });
  it("records point scores for 8-ball and one winner-only row per other rack", () => {
    const practice = read("src/Practice.jsx");
    expect(practice).toContain("Number.isInteger(my)");
    expect(practice).toContain('saveGameResult({ myPoints: my, oppPoints: opp');
    expect(practice).toContain('saveGameResult({ gameWinner: who })');
  });
});


describe("Practice active-session finalization", () => {
  it("finishes an active practice through the database instead of discarding it", () => {
    const active = read("src/ActiveSessionContext.jsx");
    const db = read("src/db.js");
    const sql = read("supabase-schema-practice-game-results.sql");
    expect(active).toContain('db.finishPracticeGame(gameId)');
    expect(active).toContain("Any recorded games and scores will be saved");
    expect(active).not.toContain("unsaved score will be discarded");
    expect(db).toContain('supabase.rpc("finish_practice_game"');
    expect(sql).toContain("create or replace function public.finish_practice_game(p_practice_game_id uuid)");
    expect(sql).toContain("completed_at = coalesce(completed_at, now())");
    expect(sql).toContain("revoke all on function public.finish_practice_game(uuid) from public, anon");
    expect(sql).toContain("grant execute on function public.finish_practice_game(uuid) to authenticated");
  });

  it("guards result writes against same-render rapid repeats", () => {
    const practice = read("src/Practice.jsx");
    expect(practice).toContain("const savingResultRef = useRef(false);");
    expect(practice).toContain("if (savingResultRef.current) return;");
    expect(practice).toContain("savingResultRef.current = true;");
    expect(practice).toContain("savingResultRef.current = false;");
  });
});


describe("practice session rating retention and discard", () => {
  it("preserves the saved player rating when returning to practice setup", () => {
    const practice = read("src/Practice.jsx");
    expect(practice).toContain('session.myRating != null && session.myRating !== ""');
    expect(practice).toContain("setSession(current => current?.myRating != null && current.myRating !== \"\"");
  });

  it("discards only the authenticated owner's practice game and its dependent shot and result rows", () => {
    const sql = read("supabase-schema-section-87-discard-practice-game.sql");
    const db = read("src/db.js");
    const practice = read("src/Practice.jsx");
    expect(sql).toContain("if v_created_by is distinct from auth.uid()");
    expect(sql).toContain("delete from public.shot_events");
    expect(sql).toContain("context_type = 'practice_game'");
    expect(sql).toContain("delete from public.practice_game_results");
    expect(sql).toContain("delete from public.practice_games");
    expect(sql).toContain("grant execute on function public.discard_practice_game(uuid) to authenticated");
    expect(db).toContain('supabase.rpc("discard_practice_game"');
    expect(practice).toContain('if (phase === "skillsplay")');
    expect(practice).toContain("Discard Practice");
    expect(practice).toContain("window.confirm");
  });
});


describe("IBA schedule TBD participant readback", () => {
  it("preserves both home-side and away-side TBD codes when loading saved schedules", () => {
    const db = read("src/db.js");
    const listSchedule = db.slice(db.indexOf("export async function listSchedule"), db.indexOf("// parsedWeeks:", db.indexOf("export async function listSchedule")));
    expect(listSchedule).toContain("homeTbdCode: p.home_tbd_code ?? null");
    expect(listSchedule).toContain("awayTbdCode: p.away_tbd_code ?? null");
  });
});


describe("league player identity claim onboarding", () => {
  it("explains that existing roster players should claim their canonical player identity", () => {
    const auth = read("src/AuthContext.jsx");
    const admin = read("src/AdminApp.jsx");
    const db = read("src/db.js");
    expect(auth).toContain("Ask your team captain for a player-specific code before registering.");
    expect(auth).toContain("don't create a second player entry");
    expect(auth).toContain("redeem it later in Profile");
    expect(auth).toContain("your team captain or a league manager gives you a player-specific code");
    expect(admin).toContain("This is your league-wide player identity");
    expect(admin).toContain("Redeem Player Invite Code");
    expect(admin).toContain("it does not create a new player record");
    expect(admin).toContain("account not linked");
    expect(admin).toContain("generate a player-specific invite code and share it with them");
    expect(db).toContain("Ask your captain to verify that the roster entry is correct.");
    expect(db).toContain("league manager will need to resolve that exceptional conflict");
  });

  it("keeps player identity claiming on the existing player-specific invite RPC", () => {
    const db = read("src/db.js");
    expect(db).toContain('supabase.rpc("claim_invite_code", { p_code: code })');
    expect(db).toContain("PLAYER_ALREADY_CLAIMED");
    expect(db).toContain("PLAYER_NUMBER_ALREADY_LINKED");
  });
});

describe("Section 101 practice opponent identity confirmation", () => {
  it("keeps practice opponent link requests private and requires recipient confirmation", () => {
    const sql = read("supabase-schema-section-101-practice-opponent-link-requests.sql");
    expect(sql).toContain("create table if not exists public.practice_opponent_link_requests");
    expect(sql).toContain("alter table public.practice_opponent_link_requests enable row level security");
    expect(sql).toContain("revoke all on public.practice_opponent_link_requests from public, anon, authenticated");
    expect(sql).toContain("grant select on public.practice_opponent_link_requests to authenticated");
    expect(sql).not.toContain("grant select, insert, update, delete on public.practice_opponent_link_requests");
    expect(sql).toContain("if v_owner <> (select auth.uid()) then");
    expect(sql).toContain("create unique index if not exists practice_opponent_link_requests_one_pending_per_opponent");
    expect(sql).toContain("r.requested_by = (select auth.uid())");
    expect(sql).toContain("r.target_profile_id = (select auth.uid())");
    expect(sql).toContain("if v_request.target_profile_id <> (select auth.uid()) then");
    expect(sql).toContain("set linked_profile_id = (select auth.uid())");
    expect(sql).toContain("set status = 'accepted', responded_at = now()");
    expect(sql).toContain("set status = 'declined', responded_at = now()");
    expect(sql).toContain("set status = 'cancelled', responded_at = now()");
    expect(sql).toContain("interval '30 days'");
    for (const signature of [
      "request_practice_opponent_link(uuid, uuid)",
      "list_practice_opponent_link_requests()",
      "respond_practice_opponent_link(uuid, boolean)",
      "cancel_practice_opponent_link_request(uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
  });

  it("uses request, response, and cancellation RPCs instead of direct opponent linking", () => {
    const db = read("src/db.js");
    const practice = read("src/Practice.jsx");
    const admin = read("src/AdminApp.jsx");
    expect(db).toContain('supabase.rpc("request_practice_opponent_link"');
    expect(db).toContain('supabase.rpc("list_practice_opponent_link_requests_with_names")');
    expect(db).toContain('supabase.rpc("respond_practice_opponent_link"');
    expect(db).toContain('supabase.rpc("cancel_practice_opponent_link_request"');
    expect(db).not.toContain("export async function linkPracticeOpponent(");
    expect(practice).toContain("they must confirm before your practice history is linked.");
    expect(admin).toContain("Pending Practice Identity Requests");
    expect(admin).toContain("respondToPracticeLinkRequest(request.request_id,true)");
    expect(admin).toContain("respondToPracticeLinkRequest(request.request_id,false)");
    expect(admin).toContain("cancelPracticeLinkRequest(request.request_id)");
  });
});


describe("Section 102 practice opponent claim codes", () => {
  it("creates expiring one-time claim codes and requires owner approval", () => {
    const sql = read("supabase-schema-section-102-practice-opponent-claim-codes.sql");
    expect(sql).toContain("create table if not exists public.practice_opponent_claim_codes");
    expect(sql).toContain("expires_at timestamptz not null default (now() + interval '7 days')");
    expect(sql).toContain("redeemed_at timestamptz");
    expect(sql).toContain("revoked_at timestamptz");
    expect(sql).toContain("revoke all on public.practice_opponent_claim_codes from public, anon, authenticated");
    expect(sql).toContain("grant select on public.practice_opponent_claim_codes to authenticated");
    expect(sql).toContain("where c.code::text = lower(trim(p_code))");
    expect(sql).toContain("set redeemed_at = now()");
    expect(sql).toContain("values (\n    v_code.opponent_id, (select auth.uid()), v_owner, (select auth.uid())");
    expect(sql).toContain("v_request.link_profile_id");
    expect(sql).toContain("if v_request.target_profile_id <> (select auth.uid()) then");
    expect(sql).toContain("case when r.link_profile_id = r.requested_by then 'claim' else 'link' end");
    for (const signature of [
      "create_practice_opponent_claim_code(uuid)",
      "redeem_practice_opponent_claim_code(text)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
  });

  it("exposes claim-code APIs in Profile while keeping opponent-specific code generation in Practice", () => {
    const db = read("src/db.js");
    const practice = read("src/Practice.jsx");
    const admin = read("src/AdminApp.jsx");
    expect(db).toContain('supabase.rpc("create_practice_opponent_claim_code"');
    expect(db).toContain('supabase.rpc("redeem_practice_opponent_claim_code"');
    expect(admin).toContain("Claim a Practice Identity");
    expect(admin).toContain("The owner must approve before the practice history is linked.");
    expect(practice).toContain("generateClaimCode(o.opponentId)");
    expect(admin).toContain('request.link_type === "claim"');
    expect(admin).toContain("respondToPracticeLinkRequest(request.request_id,true)");
  });
});


describe("Section 103 linked practice history read access", () => {
  it("adds read-only access for linked practice identities without expanding write ownership", () => {
    const sql = read("supabase-schema-section-103-linked-practice-history.sql");
    expect(sql).toContain('drop policy if exists "read linked practice opponents"');
    expect(sql).toContain('create policy "read linked practice opponents"');
    expect(sql).toContain('drop policy if exists "read linked practice games"');
    expect(sql).toContain('create policy "read linked practice games"');
    expect(sql).toContain('drop policy if exists "read linked practice game results"');
    expect(sql).toContain('create policy "read linked practice game results"');
    expect(sql).toContain('drop policy if exists "read linked practice shot events"');
    expect(sql).toContain('create policy "read linked practice shot events"');
    expect(sql).toContain("linked_profile_id = (select auth.uid())");
    expect(sql).toContain("context_type = 'practice_game'");
  });

  it("includes linked opponents and linked historical games in the Practice data layer", () => {
    const db = read("src/db.js");
    expect(db).toContain('supabase.rpc("list_my_practice_opponents_with_names")');
    expect(db).toContain('.eq("linked_profile_id", profileId)');
    expect(db).toContain('.in("opponent_id", linkedOpponentIds)');
    expect(db).toContain("const byId = new Map()");
    expect(db).not.toContain('.eq("created_by", profileId)\n    .or("winner.not.is.null,completed_at.not.is.null")');
  });
});


describe("Section 105 account full names and identity validation", () => {
  it("requires first and last name at signup and validates player invite names before account creation", () => {
    const auth = read("src/AuthContext.jsx");
    const sql = read("supabase-schema-section-105-account-full-names-and-identity-validation.sql");
    expect(auth).toContain("First and last name are required.");
    expect(auth).toContain("first_name: firstName.trim(), last_name: lastName.trim()");
    expect(auth).toContain("verify that your first and last name match the IBA player record");
    expect(sql).toContain("alter table public.profiles");
    expect(sql).toContain("add column if not exists first_name text");
    expect(sql).toContain("add column if not exists last_name text");
    expect(sql).toContain("PLAYER_NAME_MISMATCH");
    expect(sql).toContain("before insert or update of first_name, last_name, player_num");
  });

  it("enforces the canonical IBA name when a player number is attached to a profile", () => {
    const sql = read("supabase-schema-section-105-account-full-names-and-identity-validation.sql");
    expect(sql).toContain("before insert or update of first_name, last_name, player_num");
    expect(sql).toContain("from public.players player");
    expect(sql).toContain("v_account_name_normalized is distinct from v_iba_name_normalized");
    expect(sql).toContain("revoke all on function public.validate_profile_full_name() from public, anon, authenticated");
  });

  it("keeps practice identity mutual confirmation and requires both accounts to have full names", () => {
    const sql = read("supabase-schema-section-105-account-full-names-and-identity-validation.sql");
    const practice = read("src/Practice.jsx");
    const admin = read("src/AdminApp.jsx");
    expect(sql).toContain("public.validate_practice_opponent_link_names()");
    expect(sql).toContain("PRACTICE_LINK_FULL_NAME_REQUIRED");
    expect(sql).toContain("before insert or update of linked_profile_id");
    expect(sql).toContain("request.target_profile_id = (select auth.uid())");
    expect(sql).toContain("PRACTICE_LINK_CONFIRMATION_REQUIRED");
    expect(sql).toContain("set status = 'accepted', responded_at = now()");
    expect(sql).toContain("create or replace function public.search_profiles_for_practice_link(p_query text)");
    expect(sql).toContain("public.list_practice_opponent_link_requests_with_names()");
    expect(admin).toContain("request.requester_full_name");
    expect(admin).toContain("request.target_full_name");
    expect(admin).toContain("Both accounts must have first and last names saved in Profile");
    expect(practice).toContain("p.full_name");
    expect(practice).toContain("they must confirm before your practice history is linked.");
  });

  it("uses full names for both sides of linked practice history without rewriting saved games", () => {
    const sql = read("supabase-schema-section-105-account-full-names-and-identity-validation.sql");
    const db = read("src/db.js");
    const admin = read("src/AdminApp.jsx");
    expect(sql).toContain("public.list_linked_practice_game_owners");
    expect(sql).toContain("public.list_linked_practice_opponent_names");
    expect(db).toContain('supabase.rpc("list_linked_practice_opponent_names"');
    expect(db).toContain('"list_linked_practice_game_owners"');
    expect(db).toContain("opponent_name: linkedName");
    expect(db).toContain('return "FULL_NAME_REQUIRED"');
    expect(admin).toContain("respondToPracticeLinkRequest(request.request_id,true)");
    expect(db).not.toContain(".update({ opponent_name:");
  });

  it("lets existing users complete their profile name and handles server-side name mismatch", () => {
    const admin = read("src/AdminApp.jsx");
    const db = read("src/db.js");
    expect(admin).toContain("Save Full Name");
    expect(admin).toContain("db.updateOwnFullName(profile.id, firstName.trim(), lastName.trim())");
    expect(admin).toContain("PLAYER_NAME_MISMATCH");
    expect(db).toContain("first_name: firstName, last_name: lastName");
  });
});

describe("full-name player lookup and empty stats cards", () => {
  it("searches and displays players by their full canonical IBA name", () => {
    const admin = read("src/AdminApp.jsx");
    const db = read("src/db.js");
    expect(db).toContain('.select("num, name, nickname")');
    expect(db).toContain('.ilike("name", `%${query.trim()}%`)');
    expect(admin).toContain("Search by first or last name…");
    expect(admin).toContain("{p.name}{p.nickname ? ` \"${p.nickname}\"` : \"\"}");
  });

  it("places Practice identity claim and request management in My Profile", () => {
    const practice = read("src/Practice.jsx");
    const admin = read("src/AdminApp.jsx");
    expect(practice).not.toContain("Claim a Practice Identity");
    expect(practice).not.toContain("Practice Identity Requests");
    expect(practice).toContain('to="/me">My Profile</Link>');
    expect(admin).toContain("Identity &amp; Connections");
    expect(admin).toContain("db.redeemPracticeOpponentClaimCode(practiceClaimCode)");
    expect(admin).toContain("db.respondPracticeOpponentLink(requestId, accept)");
    expect(admin).toContain("db.cancelPracticeOpponentLinkRequest(requestId)");
    expect(practice).not.toContain('> · Linked</span>');
  });

  it("uses linked account full names in the People you've played before shortcuts", () => {
    const practice = read("src/Practice.jsx");
    const db = read("src/db.js");
    const sql = read("supabase-schema-section-106-practice-opponent-shortcut-names.sql");
    expect(db).toContain('supabase.rpc("list_my_practice_opponents_with_names")');
    expect(practice).toContain("buildPracticeOpponentShortcuts(history, myOpponents)");
    expect(practice).toContain("{o.name}");
    expect(practice).toContain("pickPreviousOpponent(o)");
    expect(sql).toContain("public.list_my_practice_opponents_with_names()");
    expect(sql).toContain("opponent.linked_profile_id = (select auth.uid())");
    expect(sql).toContain("grant execute on function public.list_my_practice_opponents_with_names() to authenticated");
  });

  it("does not render empty Track a Rack or unavailable Tournament Statistics cards", () => {
    const admin = read("src/AdminApp.jsx");
    expect(admin).not.toContain("No Track a Rack shots have been recorded yet for this play type.");
    expect(admin).not.toContain("Tournament tracking is not available yet.");
    expect(admin).toContain("{rawEvents && (");
  });
});


describe("manual Practice opponent full names", () => {
  it("stores both entered name parts and carries the full name into the session", () => {
    const practice = read("src/Practice.jsx");
    const db = read("src/db.js");
    expect(practice).toContain("db.findOrCreatePracticeOpponent(profile.id, manualFirstName, manualLastName)");
    expect(practice).toContain("disabled={!manualFirstName.trim()||!manualLastName.trim()||saving}");
    expect(db).toContain("export async function findOrCreatePracticeOpponent(profileId, firstName, lastName)");
    expect(db).toContain("const fullName = [trimmedFirstName, trimmedLastName].filter(Boolean).join(\" \")");
    expect(practice).toContain("opponentName: o.name");
  });

  it("lets users correct older manual opponent names and historical Practice labels", () => {
    const practice = read("src/Practice.jsx");
    const db = read("src/db.js");
    const sql = read("supabase-schema-section-107-edit-manual-practice-opponent-full-names.sql");
    expect(practice).toContain("beginEditOpponent");
    expect(practice).toContain("db.updatePracticeOpponentName(editingOpponentId, editFirstName, editLastName)");
    expect(db).toContain('supabase.rpc("update_my_practice_opponent_name"');
    expect(sql).toContain("security invoker");
    expect(sql).toContain("and created_by = (select auth.uid())");
    expect(sql).toContain("set opponent_name = v_full_name");
    expect(sql).toContain("grant execute on function public.update_my_practice_opponent_name(uuid, text, text) to authenticated");
  });
});

describe("Section 102 seasonal tournament bracket persistence", () => {
  it("creates separate season-wide tournament, entry, and match records with RLS and manager-only confirmation", () => {
    const sql = read("supabase-schema-section-102-seasonal-tournament-brackets.sql");
    expect(sql).toContain("create table if not exists public.seasonal_tournaments");
    expect(sql).toContain("create table if not exists public.seasonal_tournament_entries");
    expect(sql).toContain("create table if not exists public.seasonal_tournament_matches");
    expect(sql).toContain("alter table public.seasonal_tournaments enable row level security");
    expect(sql).toContain("alter table public.seasonal_tournament_entries enable row level security");
    expect(sql).toContain("alter table public.seasonal_tournament_matches enable row level security");
    expect(sql).toContain("revoke all on public.seasonal_tournaments from public, anon, authenticated");
    expect(sql).toContain("grant select on public.seasonal_tournaments to authenticated");
    expect(sql).toContain("public.current_role_name()) is distinct from 'manager'");
    expect(sql).toContain("grant execute on function public.create_seasonal_tournament(uuid, text, jsonb, jsonb, uuid)");
    expect(sql).toContain("to authenticated;");
    expect(sql).toContain("TOURNAMENT_ALREADY_EXISTS");
    expect(sql).toContain("FIRST_ROUND_ENTRIES_MUST_APPEAR_EXACTLY_ONCE");
  });

  it("uses the confirmed bracket builder and RPC rather than mutating division playoff records", () => {
    const db = read("src/db.js");
    const seeding = read("src/seasonalTournamentSeeding.js");
    const admin = read("src/AdminApp.jsx");
    expect(db).toContain("buildSeasonalTournamentBracket(tournamentType, orderedTeams)");
    expect(db).toContain('supabase.rpc("create_seasonal_tournament"');
    expect(db).toContain('supabase.from("seasonal_tournament_matches")');
    expect(admin).toContain("Confirm & Create Bracket");
    expect(admin).toContain("db.createSeasonalTournament(seasonId, type, drafts[type])");
    expect(seeding).toContain("export function buildSeasonalTournamentBracket");
    expect(admin).toContain("seedCategorySource: \"manager_verified\"");
  });
});


describe("seasonal tournament bracket security contracts", () => {
  it("uses invoker permissions and manager-only row policies for seasonal bracket writes", () => {
    const sql = read("supabase-schema-section-102-seasonal-tournament-brackets.sql");
    expect(sql).toContain("alter table public.seasonal_tournaments enable row level security");
    expect(sql).toContain("alter table public.seasonal_tournament_entries enable row level security");
    expect(sql).toContain("alter table public.seasonal_tournament_matches enable row level security");
    expect(sql).toContain("security invoker");
    expect(sql).not.toContain("security definer");
    expect(sql).toContain("revoke all on function public.create_seasonal_tournament");
    expect(sql).toContain("grant execute on function public.create_seasonal_tournament");
    expect(sql).toContain("seasonal_tournaments_manager_insert");
    expect(sql).toContain("seasonal_tournament_entries_manager_insert");
    expect(sql).toContain("seasonal_tournament_matches_manager_insert");
    expect(sql).toContain("confirmed_by = (select auth.uid())");
    expect(sql).toContain("CHAMPION_CANNOT_BE_PRESELECTED");
    expect(sql).toContain("TOURNAMENT_ALREADY_EXISTS");
    expect(sql).toContain("FIRST_ROUND_ENTRIES_MUST_APPEAR_EXACTLY_ONCE");
  });

  it("keeps seasonal bracket creation read/write operations behind the manager review workflow", () => {
    const db = read("src/db.js");
    const admin = read("src/AdminApp.jsx");
    expect(db).toContain('supabase.rpc("create_seasonal_tournament"');
    expect(db).toContain('supabase.from("seasonal_tournament_entries")');
    expect(db).toContain('supabase.from("seasonal_tournament_matches")');
    expect(admin).toContain("Confirm & Create Bracket");
    expect(admin).toContain("db.createSeasonalTournament(seasonId, type, drafts[type])");
    expect(admin).toContain("The saved seed order and bracket are retained");
  });
});


describe("Section 103 seasonal tournament source invalidation", () => {
  it("flags unfinished seasonal brackets for manager review when official standings or playoff records change", () => {
    const sql = read("supabase-schema-section-103-invalidate-seasonal-tournaments-on-source-change.sql");
    expect(sql).toContain("status in ('confirmed', 'in_progress', 'needs_review', 'completed', 'cancelled')");
    expect(sql).toContain("review_required_at");
    expect(sql).toContain("review_reason");
    expect(sql).toContain("after insert or update or delete on public.playoff_matches");
    expect(sql).toContain("after insert or update or delete on public.standings_adjustments");
    expect(sql).toContain("status in ('confirmed', 'in_progress')");
    expect(sql).toContain("security definer");
    expect(sql).toContain("create policy seasonal_tournaments_manager_update");
    expect(sql).toContain("grant update (status, review_required_at, review_reason)");
  });

  it("does not rewrite or delete saved seasonal tournament matches during invalidation", () => {
    const sql = read("supabase-schema-section-103-invalidate-seasonal-tournaments-on-source-change.sql");
    expect(sql).not.toMatch(/update public\\.seasonal_tournament_matches/i);
    expect(sql).not.toMatch(/delete from public\\.seasonal_tournament_matches/i);
    const admin = read("src/AdminApp.jsx");
    expect(admin).toContain("Manager review required");
    expect(admin).toContain("The saved bracket and all recorded results remain unchanged");
    expect(admin).toContain("Reconciliation must be explicitly approved by the manager");
  });

  it("uses the canonical playoff match records regardless of whether results were imported or live-scored", () => {
    const db = read("src/db.js");
    expect(db).toContain('supabase.from("playoff_matches").update({ winner_team_id: winnerTeamId, winner_seed: winnerSeed })');
    expect(db).toContain("advancePlayoffBracket(schedulePairingId, winnerTeamId)");
    expect(db).toContain('supabase.from("completed_matches").insert(row)');
  });
});


describe("Section 104 manager-approved seasonal tournament reconciliation", () => {
  it("requires a manager and a flagged tournament before reconciling", () => {
    const sql = read("supabase-schema-section-104-manager-approved-seasonal-tournament-reconciliation.sql");
    expect(sql).toContain("public.reconcile_seasonal_tournament");
    expect(sql).toContain("public.current_role_name()) is distinct from 'manager'");
    expect(sql).toContain("TOURNAMENT_DOES_NOT_REQUIRE_REVIEW");
    expect(sql).toContain("NO_QUALIFIED_TEAMS");
    expect(sql).toContain("grant execute on function public.reconcile_seasonal_tournament(uuid, jsonb, jsonb)");
  });

  it("preserves completed and in-progress matches and rejects incompatible historical changes", () => {
    const sql = read("supabase-schema-section-104-manager-approved-seasonal-tournament-reconciliation.sql");
    expect(sql).toContain("status in ('completed', 'in_progress')");
    expect(sql).toContain("RECORDED_MATCH_PARTICIPANTS_CHANGED");
    expect(sql).toContain("QUALIFIED_ENTRIES_CHANGED_AFTER_RESULTS_RECORDED");
    expect(sql).toContain("RECORDED_WINNER_CONFLICTS_WITH_PROPOSED_BRACKET");
    expect(sql).toContain("saved.status not in ('completed', 'in_progress')");
    expect(sql).toContain("review_required_at = null");
  });

  it("uses a transactional RPC and an explicit manager approval in the admin review", () => {
    const db = read("src/db.js");
    const admin = read("src/AdminApp.jsx");
    expect(db).toContain('supabase.rpc("reconcile_seasonal_tournament"');
    expect(db).toContain("export async function reconcileSeasonalTournament");
    expect(admin).toContain("Approve & Reconcile Bracket");
    expect(admin).toContain("window.confirm(");
    expect(admin).toContain("db.reconcileSeasonalTournament(saved.id, type, drafts[type])");
    expect(admin).toContain("Completed and in-progress matches and their results will be preserved");
    expect(admin).toContain("plan?.requiresReview");
  });
});


describe("unfinished Practice session recovery query", () => {
  it("orders unfinished practice games by the existing played_at column", () => {
    const db = read("src/db.js");
    const start = db.indexOf("export async function listMyUnfinishedPracticeGames");
    const end = db.indexOf("\n}\n", start);
    const query = db.slice(start, end);
    expect(query).toContain('.order("played_at", { ascending: false })');
    expect(query).not.toContain('.order("created_at"');
  });
});


describe("Section 108 shared Practice sessions", () => {
  it("shares only newly created opponent sessions with a confirmed linked account", () => {
    const sql = read("supabase-schema-section-108-shared-practice-sessions.sql");
    expect(sql).toContain("add column if not exists shared_with_profile_id");
    expect(sql).toContain("new.shared_with_profile_id := null");
    expect(sql).toContain("public.practice_opponents");
    expect(sql).toContain("join public.profiles profile on profile.id = opponent.linked_profile_id");
    expect(sql).not.toContain("profile.player_num = new.opponent_player_num");
    expect(sql).toContain("new.created_by is distinct from (select auth.uid())");
    expect(sql).toContain("create policy \"read shared practice games\"");
    expect(sql).toContain("create policy \"read shared practice game results\"");
  });

  it("allows both session participants to record and undo results without exposing creator-oriented scores", () => {
    const sql = read("supabase-schema-section-108-shared-practice-sessions.sql");
    expect(sql).toContain("shared_with_profile_id = (select auth.uid())");
    expect(sql).toContain("v_is_shared_viewer := v_parent.created_by <> (select auth.uid())");
    expect(sql).toContain("v_my_points := p_opponent_points");
    expect(sql).toContain("v_winner := case when v_winner = 'me' then 'opponent' else 'me' end");
    expect(sql).toContain("create or replace function public.undo_last_practice_game_result");
    expect(sql).toContain("create or replace function public.finish_practice_game");
    expect(sql).toContain("revoke all on function public.record_practice_game_result");
    expect(sql).toContain("grant execute on function public.record_practice_game_result");
  });

  it("keeps discard and existing private practice sessions creator-owned", () => {
    const sql = read("supabase-schema-section-108-shared-practice-sessions.sql");
    expect(sql).not.toContain("create policy \"delete shared practice games\"");
    expect(sql).toContain("new.shared_with_profile_id := null");
    expect(sql).toContain("protect_practice_game_shared_participant");
    expect(sql).toContain("Practice session ownership and sharing cannot be changed after creation");
    const db = read("src/db.js");
    expect(db).toContain('.eq("created_by", profileId).select().single()');
    expect(db).toContain('supabase.rpc("discard_practice_game"');
  });

  it("lists shared unfinished and completed sessions for the invited participant and reverses their perspective", () => {
    const db = read("src/db.js");
    const practice = read("src/Practice.jsx");
    const history = read("src/practiceHistory.js");
    expect(db).toContain('shared_with_profile_id.eq.${profileId}');
    expect(db).toContain('.eq("shared_with_profile_id", profileId)');
    expect(db).toContain("toLinkedPracticeGame(game");
    expect(history).toContain("my_score: game.opponent_score");
    expect(history).toContain("opponent_player_num: owner.player_num");
    expect(practice).toContain("viewerIsSharedParticipant");
    expect(practice).toContain('session.viewerPerspective === "shared" ? "linked" : "creator"');
    expect(practice).toContain("await db.finishPracticeGame(session.gameId)");
  });

  it("backfills only unfinished sessions with an already confirmed opponent identity", () => {
    const sql = read("supabase-schema-section-109-backfill-confirmed-unfinished-practice-sharing.sql");
    expect(sql).toContain("game.shared_with_profile_id is null");
    expect(sql).toContain("game.completed_at is null");
    expect(sql).toContain("game.winner is null");
    expect(sql).toContain("game.opponent_id = opponent.id");
    expect(sql).toContain("opponent.linked_profile_id is not null");
    expect(sql).toContain("game.created_by = opponent.created_by");
  });
  it("keeps manager impersonation server-authorized, mode-aware, and audited", () => {
    const auth = read("src/AuthContext.jsx");
    const client = read("src/supabaseClient.js");
    const admin = read("src/AdminApp.jsx");
    const fn = read("supabase/functions/manager-impersonate/index.ts");
    const sql = read("supabase-schema-section-110-manager-impersonation-audit.sql");
    expect(auth).toContain('body: { targetUserId: targetProfile.id, mode }');
    expect(auth).toContain('supabase.auth.verifyOtp({');
    expect(auth).toContain('claims.manager_impersonation_mode !== mode');
    expect(auth).toContain('body: { action: "end" }');
    expect(client).toContain('storageKey: \'iba-manager-impersonation-auth\'');
    expect(admin).toContain('startMimic(u, "read_only")');
    expect(admin).toContain('startMimic(u, "update")');
    expect(fn).toContain('manager.role !== "manager"');
    expect(fn).toContain('target.is_active');
    expect(fn).toContain('admin.auth.admin.generateLink');
    expect(fn).toContain('manager_impersonation_pending_sessions');
    expect(fn).toContain('pendingError?.code === "23505"');
    expect(fn).toContain('manager_impersonation_sessions');
    expect(fn).toContain('getClaims(token)');
    expect(fn).toContain('event_type: "ended"');
    expect(fn).not.toContain('SUPABASE_SERVICE_ROLE_KEY", token');
    expect(sql).toContain("alter table public.manager_impersonation_events enable row level security");
    expect(sql).toContain("revoke all on public.manager_impersonation_events from public, anon, authenticated");
    expect(sql).toContain("manager_impersonation_access_token_hook");
    expect(sql).toContain("create unique index if not exists manager_impersonation_pending_target_idx");
    expect(sql).toContain("prevent_read_only_impersonation_writes");
    expect(sql).toContain("manager_impersonation_read_only_guard before insert or update or delete");
    expect(sql).toContain("create event trigger manager_impersonation_attach_guard");
  });

});