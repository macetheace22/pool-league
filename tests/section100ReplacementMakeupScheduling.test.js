import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = file => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
const sql = read("supabase-schema-section-100-replacement-makeup-scheduling.sql");
const ui = read("src/ReplacementTeamResolution.jsx");
const db = read("src/db.js");

describe("Section 8.8 replacement-team makeup scheduling contract", () => {
  it("stores immutable source BYE week and opponent details", () => {
    expect(sql).toContain("eligible_makeup_weeks jsonb");
    expect(sql).toContain("sourceByeWeekId");
    expect(sql).toContain("opponentTeamId");
    expect(sql).toContain("opponentWasHome");
    expect(sql).toContain("REPLACEMENT_MAKEUP_ELIGIBILITY_SNAPSHOT_MISSING");
  });

  it("limits scheduled makeups to the recorded entitlement and three matches", () => {
    expect(sql).toContain("LEAST(v_resolution.makeup_matches_allowed, 3)");
    expect(sql).toContain("THREE_MAKEUP_LIMIT_REACHED");
    expect(sql).toContain("UNIQUE (replacement_resolution_id, source_bye_week_id)");
    expect(sql).toContain("MAKEUP_WEEK_NOT_ELIGIBLE");
  });

  it("schedules only manager-approved makeups after the replacement schedule is applied", () => {
    expect(sql).toContain("REPLACEMENT_SCHEDULE_MUST_BE_APPLIED_FIRST");
    expect(sql).toContain("current_role_name() <> 'manager'");
    expect(sql).toContain("MAKEUP_DATE_MUST_NOT_BE_IN_THE_PAST");
    expect(sql).toContain("MAKEUP_CUTOFF_WITHIN_SEVEN_DAYS_OF_FINAL_REGULAR_SEASON");
    expect(sql).toContain("MAKEUP_TEAM_ALREADY_SCHEDULED_ON_DATE");
  });

  it("creates normal schedule pairings so existing live scoring can score the makeup", () => {
    expect(sql).toContain("INSERT INTO public.schedule_weeks");
    expect(sql).toContain("INSERT INTO public.schedule_pairings");
    expect(sql).toContain("schedule_pairing_id uuid NOT NULL UNIQUE");
    expect(sql).toContain("sync_team_replacement_makeup_match_status");
    expect(sql).toContain("NEW.state->>'schedulePairingId'");
  });

  it("keeps manager-created makeup weeks when a new IBA schedule is imported", () => {
    expect(db).toContain('special.startsWith("REPLACEMENT_MAKEUP:")');
    expect(db).toContain("special.not.like.REPLACEMENT_MAKEUP:%");
  });

  it("exposes manager controls for scheduling each entitled makeup", () => {
    expect(ui).toContain("schedule_team_replacement_makeup");
    expect(ui).toContain("Schedule makeup");
    expect(ui).toContain("eligible_makeup_weeks");
    expect(ui).toContain("makeup_matches_used");
  });

  it("does not alter imported official standings or historical completed matches", () => {
    expect(sql).not.toContain("UPDATE public.standings_adjustments");
    expect(sql).not.toContain("DELETE FROM public.completed_matches");
    expect(sql).not.toContain("UPDATE public.completed_matches");
  });
});
