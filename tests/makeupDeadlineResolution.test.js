import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("Section 8.5 makeup deadline workflow contract", () => {
  it("keeps the deterministic cutoff and manager-only decision in the agreed scope", () => {
    const rules = read("src/makeupDeadlineRules.js");
    const sql = read("supabase-schema-section-93-makeup-deadline-resolution.sql");
    const page = read("src/MakeupDeadlineReview.jsx");
    const resolution = read("src/makeupDeadlineResolution.js");
    expect(rules).toContain("seven days");
    expect(rules).toContain("no_agreement");
    expect(rules).toContain("team_responsible");
    expect(sql).toContain("current_role_name() <> 'manager'");
    expect(sql).toContain("MAKEUP_DEADLINE_NOT_REACHED");
    expect(sql).toContain("neither side earns standings points");
    expect(sql).toContain("p_responsible_side");
    expect(sql).not.toContain("base_forfeit_points");
    expect(resolution).toContain("buildFullMatchForfeitSets");
    expect(resolution).toContain("computeMatchPoints");
    expect(page).toContain("League Management decision only.");
    expect(page).toContain("No agreement");
    expect(page).toContain("responsible");
  });

  it("does not implement the five-day League Office notice rule or automated responsibility inference", () => {
    const sql = read("supabase-schema-section-93-makeup-deadline-resolution.sql");
    expect(sql).not.toContain("5-day");
    expect(sql).not.toContain("reasonable effort");
    expect(sql).not.toContain("auto");
  });
});
