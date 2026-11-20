import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase-schema-section-99-replacement-schedule-application.sql"),
  "utf8",
);

describe("Section 8.8 replacement schedule application contract", () => {
  it("records a durable before/after schedule application", () => {
    expect(sql).toContain("team_replacement_schedule_applications");
    expect(sql).toContain("before_snapshot");
    expect(sql).toContain("after_snapshot");
    expect(sql).toContain("changed_week_ids");
  });

  it("only replaces future regular-season dropout matchups", () => {
    expect(sql).toContain("to_date(date, 'MM/DD/YYYY') >= v_resolution.effective_date");
    expect(sql).toContain("coalesce(is_playoff,false) = false");
    expect(sql).toContain("home_team_id = v_resolution.dropout_team_id");
    expect(sql).toContain("away_team_id = v_resolution.dropout_team_id");
  });

  it("preserves BYE pairings and prevents replacement double-booking", () => {
    expect(sql).toContain("v_bye_team_id");
    expect(sql).toContain("v_replacement_already_scheduled");
    expect(sql).toContain("REPLACEMENT_TEAM_ALREADY_SCHEDULED");
  });

  it("does not modify completed match history", () => {
    expect(sql).not.toContain("update public.completed_matches");
    expect(sql).not.toContain("delete from public.completed_matches");
  });
});
