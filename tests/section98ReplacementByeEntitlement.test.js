import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase-schema-section-98-replacement-bye-entitlement.sql"),
  "utf8",
);

describe("Section 8.8 replacement bye entitlement contract", () => {
  it("uses schedule import history rather than the live dropout pairing query", () => {
    expect(sql).toContain("iba_schedule_import_snapshots");
    expect(sql).toContain("before_snap.import_id = after_snap.import_id");
    expect(sql).toContain("before_snap.phase = 'before'");
    expect(sql).toContain("after_snap.phase = 'after'");
  });

  it("requires a real dropout matchup to become a BYE against the same opponent", () => {
    expect(sql).toContain("bp.pairing->>'homeTeamId' = v_dropout_team_id::text");
    expect(sql).toContain("bp.pairing->>'awayTeamId' = v_dropout_team_id::text");
    expect(sql).toContain("ap.pairing->>'awayTeamId' = v_bye_team_id::text");
    expect(sql).toContain("ap.pairing->>'homeTeamId' = v_bye_team_id::text");
    expect(sql).toContain("ap.pairing->>'homeTbdCode' = 'BYE'");
    expect(sql).toContain("ap.pairing->>'awayTbdCode' = 'BYE'");
  });

  it("caps the returned entitlement at three weeks", () => {
    expect(sql).toContain("least(v_week_count, 3)");
    expect(sql).toContain("WHERE ord <= 3");
  });
});
