import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase-schema-section-99-replacement-schedule-application.sql"),
  "utf8",
);
const ui = fs.readFileSync(
  path.resolve(process.cwd(), "src/ReplacementTeamResolution.jsx"),
  "utf8",
);

describe("replacement schedule application wiring", () => {
  it("exposes the manager apply action", () => {
    expect(ui).toContain('supabase.rpc("apply_team_replacement_schedule"');
    expect(ui).toContain("Apply replacement to future schedule");
  });

  it("uses the recorded resolution id for the schedule application", () => {
    expect(ui).toContain("p_replacement_resolution_id: recordedResolutionId");
    expect(sql).toContain("p_replacement_resolution_id uuid");
  });
});
