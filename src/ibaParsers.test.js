import { describe, expect, it } from "vitest";
import { extractIbaReportWeek, extractIbaReportWeeksByDivision } from "./ibaParsers";

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


describe("extractIbaReportWeeksByDivision", () => {
  it("keeps different weeks attached to their own division sections", () => {
    const text = [
      "Division 151 TCB Masters",
      "For week: 17",
      "Team data...",
      "Division 152 North Masters",
      "For week: 16",
      "Team data...",
    ].join("\n");
    const result = extractIbaReportWeeksByDivision(text);
    expect(result.hasDivisionSections).toBe(true);
    expect(result.byDivision["151"]).toMatchObject({ weekNumber: 17, divisionLabel: "TCB Masters" });
    expect(result.byDivision["152"]).toMatchObject({ weekNumber: 16, divisionLabel: "North Masters" });
    expect(result.reportWeek).toMatchObject({ weekNumber: null, ambiguous: true });
  });

  it("recognizes IBA division headers that include a hash marker", () => {
    const text = [
      "Division #151 TCB Masters",
      "For week: 17",
      "Team data...",
      "Division #152 North Masters",
      "For week: 16",
      "Team data...",
    ].join("\\n");
    const result = extractIbaReportWeeksByDivision(text);
    expect(result.hasDivisionSections).toBe(true);
    expect(result.byDivision["151"]).toMatchObject({ weekNumber: 17, divisionLabel: "TCB Masters" });
    expect(result.byDivision["152"]).toMatchObject({ weekNumber: 16, divisionLabel: "North Masters" });
  });
  it("reports missing week metadata for a division rather than borrowing another division's week", () => {
    const text = [
      "Division 151 TCB Masters",
      "For week: 17",
      "Team data...",
      "Division 152 North Masters",
      "Team data...",
    ].join("\n");
    const result = extractIbaReportWeeksByDivision(text);
    expect(result.byDivision["151"]).toMatchObject({ weekNumber: 17, missing: false });
    expect(result.byDivision["152"]).toMatchObject({ weekNumber: null, missing: true });
  });
});
