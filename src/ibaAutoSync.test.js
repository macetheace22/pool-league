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
    { id: "division-151", num: 151, name: "TCB Masters" },
    { id: "division-152", num: 152, name: "North Masters" },
  ],
};

const report = {
  key: "mast-wed-div",
  reportType: "div",
  status: "ok",
  source: "manual",
  sha256: "a".repeat(64),
  text: "Fall Season 2026 Week 17\n151 TCB Masters\nFor week: 17\n",
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
