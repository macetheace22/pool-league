import { describe, expect, it } from "vitest";
import { eligibilityByPlayerNum, latestPlayoffEligibilityRows } from "./playoffEligibility";

const row = (player_num, week_key, elig_code = "E") => ({
  player_num, week_key, elig_code, label: `As of ${week_key}`,
});

describe("official playoff eligibility snapshots", () => {
  it("uses only rows from the latest division-wide snapshot", () => {
    const rows = [
      row("12345", "2026-10-01", "E"),
      row("23456", "2026-10-01", "T"),
      row("12345", "2026-10-15", "A"),
    ];
    expect(latestPlayoffEligibilityRows(rows)).toEqual([rows[2]]);
    expect(eligibilityByPlayerNum(rows)).toEqual({
      "12345": { code: "A", weekKey: "2026-10-15", label: "As of 2026-10-15" },
    });
  });

  it("does not trust undated legacy rows or invalid date keys", () => {
    const rows = [
      row("12345", "week-17", "E"),
      row("23456", "2026-02-30", "T"),
    ];
    expect(latestPlayoffEligibilityRows(rows)).toEqual([]);
    expect(eligibilityByPlayerNum(rows)).toEqual({});
  });

  it("keeps unmatched report rows visible in the snapshot but never maps them to a player", () => {
    const rows = [
      { ...row(null, "2026-10-15", "T"), player_name: "Unmatched Player" },
      row("12345", "2026-10-15", "E"),
    ];
    expect(latestPlayoffEligibilityRows(rows)).toHaveLength(2);
    expect(eligibilityByPlayerNum(rows)).toEqual({
      "12345": { code: "E", weekKey: "2026-10-15", label: "As of 2026-10-15" },
    });
  });

  it("returns no trusted codes when the latest report has no linked players", () => {
    const rows = [
      row("12345", "2026-10-01", "E"),
      { ...row(null, "2026-10-15", "T"), player_name: "Unknown" },
    ];
    expect(eligibilityByPlayerNum(rows)).toEqual({});
  });
});
