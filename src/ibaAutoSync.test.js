import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  listSeasons: vi.fn(),
  listTeams: vi.fn(),
  listSchedule: vi.fn(),
  listIbaReportImportHistory: vi.fn(),
  listActiveTeamsByNumbers: vi.fn(),
  recordIbaReportImportHistory: vi.fn(),
  bulkImportPlayers: vi.fn(),
  importStandingsForWeek: vi.fn(),
  importMvpForWeek: vi.fn(),
}));

import * as db from "./db";
import { validateIbaReports, importIbaReports, scopeIbaReportsToSeason } from "./ibaAutoSync";

const season = {
  id: "season-1",
  format: "Masters",
  day: "Wednesday",
  divisions: [
    { id: "division-151", num: 151, name: "TCB Masters", format: "Masters", day: "Wednesday" },
    { id: "division-152", num: 152, name: "North Masters", format: "Masters", day: "Wednesday" },
  ],
};

const report = {
  key: "mastweddiv",
  leagueType: "mast",
  day: "wed",
  reportType: "div",
  status: "ok",
  source: "manual",
  sha256: "a".repeat(64),
  text: "Fall Season 2026 Week 17\n151 TCB Masters\nFor week: 17\n15001\\tTeam One\\t10\\t100\\t5\n",
  detectedRows: 12,
};

describe("season-wide IBA report scoping", () => {
  it("includes every matching format/day and supports one-category review", () => {
    const multiContextSeason = {
      ...season,
      divisions: [
        { id: "masters-wed-151", num: 151, format: "Masters", day: "Wednesday" },
        { id: "advanced-fri-287", num: 287, format: "Advanced", day: "Friday" },
      ],
    };
    const reports = [
      { key: "mastwedrost", reportType: "rost", leagueType: "mast", day: "wed" },
      { key: "mastweddiv", reportType: "div", leagueType: "mast", day: "wed" },
      { key: "advfrimvp", reportType: "mvp", leagueType: "adv", day: "fri" },
      { key: "openmonrost", reportType: "rost", leagueType: "open", day: "mon" },
    ];

    expect(scopeIbaReportsToSeason(reports, multiContextSeason).map(item => item.key))
      .toEqual(["mastwedrost", "mastweddiv", "advfrimvp"]);
    expect(scopeIbaReportsToSeason(reports, multiContextSeason, "rost").map(item => item.key))
      .toEqual(["mastwedrost"]);
    expect(scopeIbaReportsToSeason(reports, multiContextSeason, "mvp").map(item => item.key))
      .toEqual(["advfrimvp"]);
  });

  it("does not use legacy season context when divisions are present", () => {
    const seasonWithUnmatchedDivisions = {
      ...season,
      format: "Masters",
      day: "Wednesday",
      divisions: [{ id: "advanced-fri", num: 287, format: "Advanced", day: "Friday" }],
    };
    const report = { reportType: "rost", leagueType: "mast", day: "wed" };
    expect(scopeIbaReportsToSeason([report], seasonWithUnmatchedDivisions)).toEqual([]);
  });
});

describe("mapped IBA report validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.listSeasons.mockResolvedValue([season]);
    db.listTeams.mockImplementation(async divisionId => {
      if (divisionId === "division-151" || divisionId === "masters-wed-151") return [{ teamNum: "15001" }];
      if (divisionId === "division-152") return [{ teamNum: "15002" }];
      if (divisionId === "division-287") return [{ teamNum: "28701" }];
      if (divisionId === "advanced-wed-151") return [{ teamNum: "15001" }];
      return [];
    });
    db.listSchedule.mockResolvedValue([{ week: 17, date: "10/09/2026" }]);
    db.listIbaReportImportHistory.mockResolvedValue({ data: [], error: null });
  });

  it("preflights only the explicitly selected division", async () => {
    const result = await validateIbaReports([report], season, { divisionId: "division-151" });

    expect(result.canImport).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      divisionId: "division-151",
      divisionNum: "151",
      reportType: "div",
      status: "ready",
      weekNumber: 17,
    });
    expect(db.listTeams).toHaveBeenCalledTimes(1);
    expect(db.listTeams).toHaveBeenCalledWith("division-151");
    expect(db.listIbaReportImportHistory).toHaveBeenCalledWith("season-1", "division-151");
  });


  it("validates each report only against divisions with the same format and day", async () => {
    const multiContextSeason = {
      ...season,
      divisions: [
        ...season.divisions,
        { id: "division-287", num: 287, name: "Advanced Wednesday", format: "Advanced", day: "Wednesday" },
      ],
    };
    const mastersReport = {
      ...report,
      text: "Fall Season 2026 Week 17\n151 TCB Masters\nFor week: 17\n152 North Masters\nFor week: 17\n15001\tTeam One\t10\t100\t5\n15002\tTeam Two\t12\t110\t6\n",
    };
    const advancedReport = {
      ...report,
      key: "advweddiv",
      leagueType: "adv",
      day: "wed",
      text: "Fall Season 2026 Week 17\n287 Advanced Wednesday\nFor week: 17\n28701\tAdvanced Team\t10\t100\t5\n",
    };
    const result = await validateIbaReports([mastersReport, advancedReport], multiContextSeason);

    expect(result.canImport).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.filter(check => check.reportKey === mastersReport.key).map(check => check.divisionId))
      .toEqual(["division-151", "division-152"]);
    expect(result.checks.filter(check => check.reportKey === advancedReport.key).map(check => check.divisionId))
      .toEqual(["division-287"]);
  });

  it("allows missing PDFs in independent contexts when the available reports validate", async () => {
    const multiContextSeason = {
      ...season,
      divisions: [
        ...season.divisions,
        { id: "division-287", num: 287, name: "Advanced Wednesday", format: "Advanced", day: "Wednesday" },
      ],
    };
    const mastersReport = {
      ...report,
      text: "Fall Season 2026 Week 17\\n151 TCB Masters\\nFor week: 17\\n152 North Masters\\nFor week: 17\\n15001\\tTeam One\\t10\\t100\\t5\\n",
    };
    const missingAdvancedReport = {
      key: "advweddiv",
      leagueType: "adv",
      day: "wed",
      reportType: "div",
      status: "missing",
      message: "Not published",
    };

    const result = await validateIbaReports([mastersReport, missingAdvancedReport], multiContextSeason);

    expect(result.canImport).toBe(true);
    expect(result.checks.map(check => check.divisionId)).toEqual(["division-151", "division-152"]);
    expect(result.reportFailures).toMatchObject([{ reportType: "div", status: "missing", reason: "Not published" }]);
  });

  it("blocks a fetch/extraction error rather than treating it like a missing PDF", async () => {
    const failedReport = {
      key: "mastwedmvp",
      leagueType: "mast",
      day: "wed",
      reportType: "mvp",
      status: "error",
      message: "IBA request timed out",
    };

    const result = await validateIbaReports([report, failedReport], season);

    expect(result.canImport).toBe(false);
    expect(result.reportFailures).toContainEqual({
      reportType: "mvp",
      status: "error",
      reason: "IBA request timed out",
    });
  });

  it("blocks a division with no matching rows even when another division in the PDF has data", async () => {
    const mastersReport = {
      ...report,
      text: "Fall Season 2026 Week 17\n151 TCB Masters\nFor week: 17\n152 North Masters\nFor week: 17\n15001\tTeam One\t10\t100\t5\n",
    };

    const result = await validateIbaReports([mastersReport], season);

    expect(result.canImport).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.find(check => check.divisionId === "division-151"))
      .toMatchObject({ status: "ready", parsedRowCount: 1 });
    expect(result.checks.find(check => check.divisionId === "division-152"))
      .toMatchObject({ status: "blocked_zero_rows", parsedRowCount: 0, reason: expect.stringMatching(/zero records for this division/i) });
  });

  it("keeps repeated division numbers isolated by format and day", async () => {
    const repeatedNumberSeason = {
      ...season,
      divisions: [
        { id: "masters-wed-151", num: 151, name: "Masters Wednesday", format: "Masters", day: "Wednesday" },
        { id: "advanced-wed-151", num: 151, name: "Advanced Wednesday", format: "Advanced", day: "Wednesday" },
      ],
    };
    const result = await validateIbaReports([report], repeatedNumberSeason);

    expect(result.canImport).toBe(true);
    expect(result.checks.map(check => check.divisionId)).toEqual(["masters-wed-151"]);
  });

  it("blocks a report that parses to zero rows", async () => {
    const emptyReport = { ...report, text: "Fall Season 2026 Week 17\\n151 TCB Masters\\nFor week: 17\\n" };
    const result = await validateIbaReports([emptyReport], season);

    expect(result.canImport).toBe(false);
    expect(result.checks[0].status).toBe("blocked_zero_rows");
    expect(result.checks[0].reason).toMatch(/zero records/i);
  });

  it("rejects a division that does not belong to the selected season", async () => {
    await expect(
      validateIbaReports([report], season, { divisionId: "division-not-in-season" }),
    ).rejects.toThrow("does not belong to this season");

    expect(db.listTeams).not.toHaveBeenCalled();
    expect(db.listIbaReportImportHistory).not.toHaveBeenCalled();
  });

  it("fails closed before any writes when preflight is not approved", async () => {
    await expect(importIbaReports([report], season, [], { canImport: false }))
      .rejects.toThrow("complete the per-division validation");

    expect(db.bulkImportPlayers).not.toHaveBeenCalled();
    expect(db.importStandingsForWeek).not.toHaveBeenCalled();
    expect(db.importMvpForWeek).not.toHaveBeenCalled();
    expect(db.recordIbaReportImportHistory).not.toHaveBeenCalled();
  });
});
