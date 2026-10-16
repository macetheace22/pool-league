import { describe, expect, it } from "vitest";
import { extractIbaReportWeek } from "./ibaParsers";

describe("extractIbaReportWeek", () => {
  it.each([
    ["For week: 17", 17],
    ["For Week: 17", 17],
    ["Week 17", 17],
    ["Week: 17", 17],
    ["Roster report\nFor week: 17\nDivision 151", 17],
    ["MVP report\nFor week: 17\nWeek 17", 17],
  ])("extracts week %i from %s", (text, expectedWeek) => {
    expect(extractIbaReportWeek(text)).toMatchObject({
      weekNumber: expectedWeek,
      weekNumbers: [expectedWeek],
      missing: false,
      ambiguous: false,
    });
  });

  it("flags multiple distinct week numbers instead of guessing", () => {
    expect(extractIbaReportWeek("Division A\nWeek 16\nDivision B\nFor week: 17")).toMatchObject({
      weekNumber: null,
      weekNumbers: [16, 17],
      missing: false,
      ambiguous: true,
    });
  });

  it("flags reports where no explicit week label is present", () => {
    expect(extractIbaReportWeek("Fall Season 2026\nTeam Standings")).toMatchObject({
      weekNumber: null,
      weekNumbers: [],
      missing: true,
      ambiguous: false,
    });
  });
});
