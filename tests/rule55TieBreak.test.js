import { describe, expect, it } from "vitest";
import { buildRule55TieBreakAudit } from "../src/rule55TieBreak.js";

const baseTeams = [
  { teamId: "a", name: "A", position: 1, totalPoints: 100 },
  { teamId: "b", name: "B", position: 2, totalPoints: 100 },
  { teamId: "c", name: "C", position: 3, totalPoints: 90 },
];
const schedule = [
  { week: 1, date: "9/1/2026", pairings: [{ homeTeamId: "a", awayTeamId: "b" }, { homeTeamId: "c", awayTeamId: "d" }] },
  { week: 2, date: "9/8/2026", pairings: [{ homeTeamId: "a", awayTeamId: "c" }, { homeTeamId: "b", awayTeamId: "d" }] },
];

describe("Rule 5.5 tie-break audit", () => {
  it("does not calculate tie-breaks unless official IBA points are tied", () => {
    expect(buildRule55TieBreakAudit({ officialStandings: [{...baseTeams[0]}, {...baseTeams[1], totalPoints: 99}] })).toEqual([]);
  });

  it("uses scheduled opponents and each team's imported weekly points", () => {
    const rows = buildRule55TieBreakAudit({
      officialStandings: baseTeams,
      schedule,
      standingsHistory: [
        { team_id: "a", week_key: "2026-09-01", points_last_wk: 90 },
        { team_id: "b", week_key: "2026-09-01", points_last_wk: 80 },
        { team_id: "c", week_key: "2026-09-01", points_last_wk: 55 },
        { team_id: "a", week_key: "2026-09-08", points_last_wk: 70 },
        { team_id: "b", week_key: "2026-09-08", points_last_wk: 65 },
        { team_id: "c", week_key: "2026-09-08", points_last_wk: 60 },
      ],
    });
    expect(rows.find(row => row.teamId === "a")).toMatchObject({
      headToHeadPoints: 90,
      pointsLost: 140,
      completeness: { headToHeadPoints: true, pointsLost: true },
    });
  });

  it("sums each player's latest team-specific cumulative wins once", () => {
    const rows = buildRule55TieBreakAudit({
      officialStandings: baseTeams.slice(0, 2),
      schedule: [{ week: 1, date: "9/8/2026", pairings: [{ homeTeamId: "a", awayTeamId: "b" }] }],
      counterSnapshots: [
        { team_id: "a", player_num: "11111", schedule_week_date: "2026-09-01", matches_played: 3, matches_won: 2, imported_at: "2026-09-01T00:00:00Z" },
        { team_id: "a", player_num: "11111", schedule_week_date: "2026-09-08", matches_played: 6, matches_won: 4, imported_at: "2026-09-08T00:00:00Z" },
        { team_id: "a", player_num: "22222", schedule_week_date: "2026-09-08", matches_played: 2, matches_won: 1, imported_at: "2026-09-08T00:00:00Z" },
      ],
    });
    expect(rows.find(row => row.teamId === "a").setsWon).toBe(5);
  });

  it("derives record against the immediately lower official position from weekly set-win deltas", () => {
    const rows = buildRule55TieBreakAudit({
      officialStandings: baseTeams.slice(0, 2),
      schedule: [{ week: 1, date: "9/1/2026", pairings: [{ homeTeamId: "a", awayTeamId: "b" }] }],
      counterSnapshots: [
        { team_id: "a", player_num: "11111", schedule_week_date: "2026-09-01", matches_played: 5, matches_won: 3, imported_at: "2026-09-01T00:00:00Z" },
        { team_id: "b", player_num: "22222", schedule_week_date: "2026-09-01", matches_played: 5, matches_won: 2, imported_at: "2026-09-01T00:00:00Z" },
      ],
    });
    expect(rows.find(row => row.teamId === "a").recordVsNext).toEqual({ wins: 1, losses: 0, draws: 0, matches: 1 });
  });

  it("keeps unavailable data unresolved rather than treating it as zero", () => {
    const rows = buildRule55TieBreakAudit({
      officialStandings: baseTeams.slice(0, 2),
      schedule: [{ week: 1, date: "9/1/2026", pairings: [{ homeTeamId: "a", awayTeamId: "b" }] }],
      standingsHistory: [{ team_id: "a", week_key: "2026-09-01", points_last_wk: 5 }],
      counterSnapshots: [{ team_id: "a", player_num: "11111", schedule_week_date: "2026-09-01", matches_played: null, matches_won: null, imported_at: "2026-09-01T00:00:00Z" }],
    });
    const a = rows.find(row => row.teamId === "a");
    expect(a.pointsLost).toBeNull();
    expect(a.setsWon).toBeNull();
    expect(a.recordVsNext).toBeNull();
  });
});
