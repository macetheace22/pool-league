import { describe, expect, it } from "vitest";
import { extractIbaReportWeek, extractIbaReportWeeksByDivision, parseLeagueRoster, parsePlayoffEligibilityRoster } from "./ibaParsers";

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
    ].join("\n");
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


describe("playoff roster eligibility parsing", () => {
  const report = `Division Playoffs - Roster and Handicap Report
For Week: 17
Ratings current as of: 11/02/26
Rate Num Elig Name
Team 85382 North Stars
45 12345 E Jane Doe
52 23456 T John Smith
`;

  it("recognizes the playoff roster layout and extracts ratings plus eligibility", () => {
    const parsed = parseLeagueRoster(report);
    expect(parsed.eligibilityRows).toHaveLength(2);
    expect(parsed.registry["12345"]).toMatchObject({ rating: 45, name: "Jane Doe" });
    expect(parsed.registry["23456"]).toMatchObject({ rating: 52, name: "John Smith" });
    expect(parsed.eligibilityRows.map(row => row.eligCode)).toEqual(["E", "T"]);
    expect(parsed.eligibilityAsOfDate).toBe("2026-11-02");
    expect(parsed.registry["34567"].matchesPlayed).toBeUndefined();
    expect(parsed.registry["12345"].matchesWon).toBeNull();
  });

  it("fails closed when the eligibility date is missing or invalid", () => {
    const parsed = parsePlayoffEligibilityRoster(report.replace("11/02/26", "not printed"));
    expect(parsed.eligibilityRows).toHaveLength(2);
    expect(parsed.eligibilityAsOfDate).toBeNull();
    expect(parsed.eligibilityParseError).toMatch(/date could not be read/i);
  });

  it("does not classify a standard weekly roster as an eligibility report", () => {
    expect(parsePlayoffEligibilityRoster("Rate Num Play Win Name")).toBeNull();
  });
});


describe("playoff eligibility roster parsing", () => {
  const playoffRoster = [
    "Division Playoffs - Roster and Handicap Report",
    "For Week: 18",
    "Ratings current as of: 11/08/26",
    "Rate Num Elig Name",
    "Team 12345 North Stars",
    "70 34567 E Alex Player",
    "62 45678 T Sam Player",
  ].join("\n");

  it("extracts ratings and official eligibility codes from the playoff roster layout", () => {
    const parsed = parsePlayoffEligibilityRoster(playoffRoster);
    expect(parsed.eligibilityWeek).toBe(18);
    expect(parsed.eligibilityAsOfDate).toBe("2026-11-08");
    expect(parsed.eligibilityRows).toEqual([
      { teamNum: "12345", teamName: "North Stars", num: "34567", name: "Alex Player", nickname: "", eligCode: "E" },
      { teamNum: "12345", teamName: "North Stars", num: "45678", name: "Sam Player", nickname: "", eligCode: "T" },
    ]);
    expect(parsed.registry["34567"].rating).toBe(70);
    expect(parsed.registry["45678"].rating).toBe(62);
    expect(parsed.registry["12345"].matchesPlayed).toBeUndefined();
    expect(parseLeagueRoster(playoffRoster).eligibilityRows).toHaveLength(2);
  });

  it("does not produce eligibility rows when the as-of date is invalid", () => {
    const parsed = parsePlayoffEligibilityRoster(playoffRoster.replace("11/08/26", "02/31/26"));
    expect(parsed.eligibilityRows).toHaveLength(2);
    expect(parsed.eligibilityAsOfDate).toBeNull();
    expect(parsed.eligibilityParseError).toMatch(/as-of date could not be read/i);
  });

  it("does not classify a regular weekly roster as a playoff eligibility report", () => {
    expect(parsePlayoffEligibilityRoster("For Week: 18\\nRate Num Play Win Name")).toBeNull();
  });
});
