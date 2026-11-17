import { describe, expect, it } from "vitest";
import { compareIbaSchedules, validateIbaScheduleSnapshot } from "../src/ibaScheduleComparison";

const teams = [
  { id: "team-a", team_num: "15101", name: "Alpha" },
  { id: "team-b", team_num: "15102", name: "Bravo" },
  { id: "team-c", team_num: "15103", name: "Charlie" },
  { id: "team-d", team_num: "15104", name: "Delta" },
];
const week = (date, pairings, number = 1) => ({ week: number, date, pairings });
const saved = weeks => ({ teams, weeks });
const official = weeks => ({ hasSchedule: true, teams, weeks });

describe("read-only IBA schedule comparison", () => {
  it("reports no changes when dates and matchups are equivalent", () => {
    const result = compareIbaSchedules({
      saved: saved([week("9/9/2026", [{ home: 1, away: 2 }])]),
      official: official([week("2026-09-09", [{ home: 1, away: 2 }])]),
    });
    expect(result.status).toBe("no_changes");
    expect(result.changes).toEqual([]);
  });

  it("reports a scheduled date change", () => {
    const result = compareIbaSchedules({
      saved: saved([week("9/9/2026", [{ home: 1, away: 2 }])]),
      official: official([week("9/16/2026", [{ home: 1, away: 2 }])]),
    });
    expect(result.changes).toContainEqual({
      type: "date_changed", week: 1, from: "9/9/2026", to: "9/16/2026",
    });
    expect(result.summary.dateChanges).toBe(1);
  });

  it("reports team additions, removals, and team detail changes", () => {
    const result = compareIbaSchedules({
      saved: {
        teams: [
          { id: "team-a", teamNum: "15101", name: "Alpha", venue: "Club" },
          { id: "team-b", teamNum: "15102", name: "Beta", venue: "Club" },
          { id: "team-c", teamNum: "15103", name: "Gamma", venue: "Club" },
        ],
        weeks: [week("9/9/2026", [{ home: 1, away: 2 }])],
      },
      official: {
        hasSchedule: true,
        teams: [
          { teamNum: "15101", name: "Alpha Renamed", venue: "New Hall" },
          { teamNum: "15103", name: "Gamma", venue: "Club" },
          { teamNum: "15104", name: "Delta", venue: "Club" },
        ],
        weeks: [week("9/9/2026", [{ home: 1, away: 2 }])],
      },
    });
    expect(result.changes).toContainEqual(expect.objectContaining({ type: "team_added", teamNum: "15104" }));
    expect(result.changes).toContainEqual(expect.objectContaining({ type: "team_removed", teamNum: "15102" }));
    expect(result.changes).toContainEqual(expect.objectContaining({
      type: "team_details_changed", teamNum: "15101", fromName: "Alpha", toName: "Alpha Renamed",
    }));
    expect(result.summary.teamDetailsChanged).toBe(1);
  });

  it("reports added and removed matchups", () => {
    const result = compareIbaSchedules({
      saved: saved([week("9/9/2026", [{ home: 1, away: 2 }])]),
      official: official([week("9/9/2026", [{ home: 1, away: 3 }, { home: 2, away: 3 }])]),
    });
    expect(result.changes).toContainEqual({
      type: "matchup_changed", week: 1, homeTeamNum: "15101",
      fromAwayTeamNum: "15102", toAwayTeamNum: "15103",
    });
    expect(result.changes).toContainEqual({
      type: "matchup_added", week: 1, homeTeamNum: "15102", awayTeamNum: "15103",
    });
    expect(result.summary.changed).toBe(1);
    expect(result.summary.added).toBe(1);
  });

  it("recognizes a TBA resolution when the saved schedule explicitly retains TBA", () => {
    const result = compareIbaSchedules({
      saved: saved([week("9/9/2026", [{ home: 1, away: null }])]),
      official: official([week("9/9/2026", [{ home: 1, away: 2 }])]),
    });
    expect(result.changes).toContainEqual({
      type: "tba_resolved", week: 1, homeTeamNum: "15101",
      fromAwayTeamNum: null, toAwayTeamNum: "15102",
    });
    expect(result.summary.tbaResolutions).toBe(1);
  });

  it("reports added and removed weeks", () => {
    const result = compareIbaSchedules({
      saved: saved([
        week("9/9/2026", [{ home: 1, away: 2 }], 1),
        week("9/16/2026", [{ home: 1, away: 2 }], 2),
      ]),
      official: official([
        week("9/16/2026", [{ home: 1, away: 2 }], 2),
        week("9/23/2026", [{ home: 2, away: 3 }], 3),
      ]),
    });
    expect(result.changes.map(change => change.type)).toEqual(["week_added", "week_removed"]);
  });

  it("does not report changes from a failed or incomplete IBA retrieval", () => {
    const result = compareIbaSchedules({
      saved: saved([week("9/9/2026", [{ home: 1, away: 2 }])]),
      official: official([week("9/9/2026", [{ home: 1, away: 3 }])]),
      errors: [{ day: "Wednesday", error: "IBA timed out" }],
    });
    expect(result.status).toBe("incomplete");
    expect(result.changes).toEqual([]);
    expect(result.reason).toMatch(/errors/i);
  });

  it("treats an empty official schedule as incomplete rather than a mass removal", () => {
    const result = compareIbaSchedules({
      saved: saved([week("9/9/2026", [{ home: 1, away: 2 }])]),
      official: { hasSchedule: false, teams, weeks: [] },
    });
    expect(result.status).toBe("incomplete");
    expect(result.changes).toEqual([]);
  });
  it("recognizes a preserved TBD code resolving to a real team", () => {
    const result = compareIbaSchedules({
      saved: saved([week("9/9/2026", [{ home: 1, away: null, awayTbdCode: "15110" }])]),
      official: official([week("9/9/2026", [{ home: 1, away: 4 }])]),
    });
    expect(result.changes).toContainEqual({
      type: "tba_resolved", week: 1, homeTeamNum: "15101",
      fromAwayTeamNum: "15110", toAwayTeamNum: "15104",
    });
    expect(result.summary.tbaResolutions).toBe(1);
  });

  it("recognizes a TBD code remaining unresolved without reporting a change", () => {
    const result = compareIbaSchedules({
      saved: saved([week("9/9/2026", [{ home: 1, away: null, awayTbdCode: "15110" }])]),
      official: official([week("9/9/2026", [{ home: 1, away: null, awayTbdCode: "15110" }])]),
    });
    expect(result.status).toBe("no_changes");
    expect(result.changes).toEqual([]);
  });

});
