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
import { validateIbaReports, importIbaReports } from "./ibaAutoSync";

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

describe("mapped IBA report validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.listSeasons.mockResolvedValue([season]);
    db.listTeams.mockResolvedValue([]);
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
      text: "Fall Season 2026 Week 17\n151 TCB Masters\nFor week: 17\n152 North Masters\nFor week: 17\n",
    };
    const advancedReport = {
      ...report,
      key: "advweddiv",
      leagueType: "adv",
      day: "wed",
      text: "Fall Season 2026 Week 17\n287 Advanced Wednesday\nFor week: 17\n",
    };
    const result = await validateIbaReports([mastersReport, advancedReport], multiContextSeason);

    expect(result.canImport).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.filter(check => check.reportKey === mastersReport.key).map(check => check.divisionId))
      .toEqual(["division-151", "division-152"]);
    expect(result.checks.filter(check => check.reportKey === advancedReport.key).map(check => check.divisionId))
      .toEqual(["division-287"]);
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
