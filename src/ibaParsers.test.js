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
    expect(parsed.eligibilityWeek).toBe(17);
    expect(parsed.registry["12345"]).toMatchObject({ rating: 45, name: "Jane Doe" });
    expect(parsed.registry["23456"]).toMatchObject({ rating: 52, name: "John Smith" });
    expect(parsed.eligibilityRows.map(row => row.eligCode)).toEqual(["E", "T"]);
    expect(parsed.eligibilityAsOfDate).toBe("2026-11-02");
    expect(parsed.registry["12345"].matchesPlayed).toBeUndefined();
    expect(parsed.registry["12345"].matchesWon).toBeUndefined();
  });

  it("fails closed when the eligibility date is missing or invalid", () => {
    const parsed = parsePlayoffEligibilityRoster(report.replace("11/02/26", "not printed"));
    expect(parsed.eligibilityRows).toHaveLength(2);
    expect(parsed.eligibilityAsOfDate).toBeNull();
    expect(parsed.eligibilityParseError).toMatch(/date could not be read/i);
  });

  it("fails closed when repeated report sections disagree on the as-of date", () => {
    const conflicting = report.replace("For Week: 17", "For Week: 17\nRatings current as of: 11/03/26");
    const parsed = parsePlayoffEligibilityRoster(conflicting);
    expect(parsed.eligibilityAsOfDate).toBeNull();
    expect(parsed.eligibilityParseError).toMatch(/date could not be read/i);
  });

  it("does not classify a standard weekly roster as an eligibility report", () => {
    expect(parsePlayoffEligibilityRoster("Rate Num Play Win Name")).toBeNull();
  });

  it("parses a playoff roster when PDF text is flattened onto one line", () => {
    const flattened = "Division Playoffs - Roster and Handicap Report For Week: 17 Ratings current as of: 11/02/26 Rate Num Elig Name Team 85382 North Stars 45 12345 E Jane Doe 52 23456 T John Smith";
    const parsed = parseLeagueRoster(flattened);
    expect(parsed.eligibilityRows).toHaveLength(2);
    expect(parsed.teams["85382"].name).toBe("North Stars");
    expect(parsed.eligibilityRows.map(row => row.eligCode)).toEqual(["E", "T"]);
  });

  it("retains eligibility for NR players without inventing a numeric rating", () => {
    const reportWithNr = report.replace("52 23456 T John Smith", "NR 23456 T John Smith");
    const parsed = parseLeagueRoster(reportWithNr);
    expect(parsed.eligibilityRows.find(row => row.num === "23456")?.eligCode).toBe("T");
    expect(parsed.registry["23456"].rating).toBeNull();
    expect(parsed.needsRating).toContainEqual(expect.objectContaining({ num: "23456" }));
  });

  it("routes flattened multi-team rows to the matching team columns", () => {
    const flattened = "Division Playoffs - Roster and Handicap Report For Week: 17 Ratings current as of: 11/02/26 Rate Num Elig Name Team 76001 Team A Team 76002 Team B 40 12345 E Alex One 41 23456 E Sam Two 42 34567 T Pat Three 43 45678 A Kim Four";
    const parsed = parseLeagueRoster(flattened);
    expect(parsed.rosters["76001"]).toEqual(["12345", "34567"]);
    expect(parsed.rosters["76002"]).toEqual(["23456", "45678"]);
  });

  it("does not shift players into the wrong team when a column has no row", () => {
    const header = "Team 76001 Alpha         Team 76002 Beta         Team 76003 Gamma";
    const playerLine = " ".repeat(25) + "40 12345 E Sam Two" + " ".repeat(8) + "42 34567 T Pat Three";
    const parsed = parseLeagueRoster([
      "Division Playoffs - Roster and Handicap Report",
      "For Week: 19",
      "Ratings current as of: 05/13/26",
      "Rate Num Elig Name",
      header,
      playerLine,
    ].join("\\n"));
    expect(parsed.rosters["76001"]).toEqual([]);
    expect(parsed.rosters["76002"]).toEqual(["12345"]);
    expect(parsed.rosters["76003"]).toEqual(["34567"]);
  });

  it("parses IBA multi-column team IDs containing letters", () => {
    const multiColumn = [
      "Division Playoffs - Roster and Handicap Report",
      "For Week: 19",
      "Ratings current as of: 05/13/26",
      "Team 76B01 Eliminators Team 76B02 No esQusEs Team 76B03 9 Inch Rails",
      "Rate Num Elig Name Rate Num Elig Name Rate Num Elig Name",
      "47 19537 E Kruger, Bruce 97 01855 E Byrne, Randy 50 37760 E Robeck, Paul",
      "49 00658 T Jarvis, Al 86 25046 A Boone, James 63 03294 S Johnson, Phil",
    ].join("\n");
    const parsed = parseLeagueRoster(multiColumn);
    expect(parsed.rosters["76B01"]).toEqual(["19537", "00658"]);
    expect(parsed.rosters["76B02"]).toEqual(["01855", "25046"]);
    expect(parsed.rosters["76B03"]).toEqual(["37760", "03294"]);
    expect(parsed.eligibilityRows.map(row => row.eligCode)).toEqual(["E", "E", "E", "T", "A", "S"]);
  });
});

