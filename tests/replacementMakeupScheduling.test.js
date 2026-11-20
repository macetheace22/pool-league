import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sql = fs.readFileSync(path.resolve(root, "supabase-schema-section-100-replacement-makeup-scheduling.sql"), "utf8");
const db = fs.readFileSync(path.resolve(root, "src/db.js"), "utf8");
const ui = fs.readFileSync(path.resolve(root, "src/ReplacementTeamResolution.jsx"), "utf8");

describe("Section 8.8 replacement-team makeup scheduling", () => {
  it("captures actual BYE week, opponent, date, and home/away orientation", () => {
    expect(sql).toContain("eligible_makeup_weeks");
    expect(sql).toContain("sourceByeWeekId");
    expect(sql).toContain("opponentTeamId");
    expect(sql).toContain("opponentWasHome");
    expect(sql).toContain("REPLACEMENT_MAKEUP_ELIGIBILITY_SNAPSHOT_MISSING");
  });

  it("uses IBA before/after schedule snapshots and the real schedule_weeks.week_num column", () => {
    expect(sql).toContain("iba_schedule_import_snapshots");
    expect(sql).toContain("sw.week_num = cb.week");
    expect(sql).not.toContain("sw.week = cb.week");
  });

  it("enforces the three-match cap and the Section 8.5 seven-day cutoff", () => {
    expect(sql).toContain("LEAST(v_resolution.makeup_matches_allowed, 3)");
    expect(sql).toContain("THREE_MAKEUP_LIMIT_REACHED");
    expect(sql).toContain("v_final_regular_date - 7");
    expect(sql).toContain("MAKEUP_CUTOFF_WITHIN_SEVEN_DAYS_OF_FINAL_REGULAR_SEASON");
  });

  it("requires manager authority and an applied replacement schedule", () => {
    expect(sql).toContain("public.current_role_name() <> 'manager'");
    expect(sql).toContain("REPLACEMENT_SCHEDULE_MUST_BE_APPLIED_FIRST");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.schedule_team_replacement_makeup(uuid,uuid,date)");
    expect(sql).toContain("FROM PUBLIC, anon, authenticated");
  });

  it("prevents date conflicts and team double-booking", () => {
    expect(sql).toContain("MAKEUP_DATE_CONFLICTS_WITH_REGULAR_SCHEDULE");
    expect(sql).toContain("MAKEUP_TEAM_ALREADY_SCHEDULED_ON_DATE");
  });

  it("preserves manager-created makeup fixtures when IBA replaces its schedule", () => {
    expect(db).toContain('startsWith("REPLACEMENT_MAKEUP:")');
    expect(db).toContain("special.not.like.REPLACEMENT_MAKEUP:%");
  });

  it("exposes scheduling controls and recovers schedule application from history", () => {
    expect(ui).toContain("schedule_team_replacement_makeup");
    expect(ui).toContain("scheduleApplications");
    expect(ui).toContain("eligible_makeup_weeks");
    expect(ui).toContain("Apply replacement to future schedule");
  });

  it("tracks completion through the existing completed-match archive lifecycle", () => {
    expect(sql).toContain("sync_team_replacement_makeup_match_status");
    expect(sql).toContain("NEW.state->>'schedulePairingId'");
    expect(sql).toContain("schedule_pairing_id::text = v_pairing_id");
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain("NEW.is_makeup_pending THEN 'scheduled' ELSE 'completed'");
  });
});
