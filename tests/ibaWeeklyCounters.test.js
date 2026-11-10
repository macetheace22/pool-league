import { describe, expect, it } from "vitest";
import { buildIbaPlayerWeeklyCounterRows } from "../src/db";

const metadata = {
  "division-1": {
    seasonId: "season-1",
    reportWeek: 6,
    scheduleWeekDate: "2026-10-09",
    reportPrintedOnDate: "2026-10-09",
    contentSha256: "a".repeat(64),
    source: "automatic",
  },
};

describe("IBA weekly team counter snapshots", () => {
  it("persists team-specific counters for a multi-team player", () => {
    const parsed = {
      rosters: { "15101": ["12345"], "15102": ["12345"] },
      registry: {
        "12345": {
          num: "12345",
          teamCounters: {
            "15101": { matchesPlayed: 4, matchesWon: 2 },
            "15102": { matchesPlayed: 7, matchesWon: 3 },
          },
        },
      },
    };
    const teams = [
      { id: "team-a", division_id: "division-1", team_num: "15101", divisions: { seasons: { id: "season-1" } } },
      { id: "team-b", division_id: "division-1", team_num: "15102", divisions: { seasons: { id: "season-1" } } },
    ];

    expect(buildIbaPlayerWeeklyCounterRows(parsed, teams, metadata)).toEqual([
      expect.objectContaining({
        team_id: "team-a", team_num: "15101", player_num: "12345",
        matches_played: 4, matches_won: 2, report_week: 6,
      }),
      expect.objectContaining({
        team_id: "team-b", team_num: "15102", player_num: "12345",
        matches_played: 7, matches_won: 3, report_week: 6,
      }),
    ]);
  });

  it("preserves nulls for rows with unreadable counters once the division has counter data", () => {
    const parsed = {
      rosters: { "15101": ["12345", "23456"] },
      registry: {
        "12345": { num: "12345", matchesPlayed: 4, matchesWon: 2 },
        "23456": { num: "23456", matchesPlayed: null, matchesWon: null },
      },
    };
    const rows = buildIbaPlayerWeeklyCounterRows(
      parsed,
      [{ id: "team-a", division_id: "division-1", team_num: "15101", divisions: { seasons: { id: "season-1" } } }],
      metadata,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.player_num === "23456")).toMatchObject({
      matches_played: null, matches_won: null,
    });
  });

  it("does not create a match-counter snapshot when the report has no Play/Win values", () => {
    const parsed = {
      rosters: { "15101": ["12345"] },
      registry: { "12345": { num: "12345", matchesPlayed: null, matchesWon: null } },
    };
    expect(buildIbaPlayerWeeklyCounterRows(
      parsed,
      [{ id: "team-a", division_id: "division-1", team_num: "15101", divisions: { seasons: { id: "season-1" } } }],
      metadata,
    )).toEqual([]);
  });

  it("uses division-specific report weeks for a manual multi-division paste", () => {
    const parsed = {
      rosters: { "15101": ["12345"] },
      registry: { "12345": { num: "12345", matchesPlayed: 4, matchesWon: 2 } },
    };
    const defaults = {
      seasonId: "season-1",
      reportWeeksByDivision: { "151": { weekNumber: 9 } },
      reportPrintedOnDate: "2026-10-30",
      contentSha256: "b".repeat(64),
      source: "manual",
    };
    const rows = buildIbaPlayerWeeklyCounterRows(
      parsed,
      [{ id: "team-a", division_id: "division-1", team_num: "15101", divisions: { num: "151", seasons: { id: "season-1" } } }],
      {},
      defaults,
    );
    expect(rows[0]).toMatchObject({ report_week: 9, source: "manual", report_printed_on_date: "2026-10-30" });
  });

  it("rejects impossible counters rather than persisting them", () => {
    const parsed = {
      rosters: { "15101": ["12345"] },
      registry: { "12345": { num: "12345", matchesPlayed: 2, matchesWon: 3 } },
    };
    expect(() => buildIbaPlayerWeeklyCounterRows(
      parsed,
      [{ id: "team-a", division_id: "division-1", team_num: "15101", divisions: { seasons: { id: "season-1" } } }],
      metadata,
    )).toThrow(/Invalid IBA match counters/);
  });
});
