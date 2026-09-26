import { describe, it, expect } from "vitest";
import { computeStandings } from "../src/db.js";

describe("computeStandings", () => {
  it("computes wins/losses/sets/points for both teams from a single match", () => {
    const matches = [{
      team_home_id: "t1", team_home_name: "Team A",
      team_away_id: "t2", team_away_name: "Team B",
      team_home_total: 3, team_away_total: 2,
      team_home_points: 500, team_away_points: 400,
      is_makeup_pending: false,
    }];
    const standings = computeStandings(matches, []);
    const a = standings.find(s => s.teamId === "t1");
    const b = standings.find(s => s.teamId === "t2");
    expect(a).toMatchObject({ wins: 1, losses: 0, setsFor: 3, setsAgainst: 2, totalPoints: 500, setsPlayed: 5, pointsPerSet: 100 });
    expect(b).toMatchObject({ wins: 0, losses: 1, setsFor: 2, setsAgainst: 3, totalPoints: 400, setsPlayed: 5, pointsPerSet: 80 });
  });

  it("ranks by totalPoints descending, not by win/loss record", () => {
    const matches = [
      { team_home_id: "t1", team_home_name: "A", team_away_id: "t2", team_away_name: "B",
        team_home_total: 2, team_away_total: 3, team_home_points: 600, team_away_points: 300, is_makeup_pending: false },
    ];
    const standings = computeStandings(matches, []);
    // t1 lost the match (2-3 sets) but has more points -- should rank first
    expect(standings[0].teamId).toBe("t1");
    expect(standings[0].wins).toBe(0);
    expect(standings[0].losses).toBe(1);
    expect(standings[1].teamId).toBe("t2");
  });

  it("a makeup-pending match still registers both teams but contributes zero to wins/losses/sets/points", () => {
    const matches = [{
      team_home_id: "t1", team_home_name: "A", team_away_id: "t2", team_away_name: "B",
      team_home_total: null, team_away_total: null, team_home_points: null, team_away_points: null,
      is_makeup_pending: true,
    }];
    const standings = computeStandings(matches, []);
    expect(standings).toHaveLength(2);
    for (const row of standings) {
      expect(row).toMatchObject({ wins: 0, losses: 0, setsFor: 0, setsAgainst: 0, totalPoints: 0, setsPlayed: 0 });
    }
  });

  it("imported standings_adjustments add additively on top of real matches, keyed by team_id", () => {
    const matches = [{
      team_home_id: "t1", team_home_name: "A", team_away_id: "t2", team_away_name: "B",
      team_home_total: 3, team_away_total: 2, team_home_points: 500, team_away_points: 400, is_makeup_pending: false,
    }];
    const adjustments = [{ team_id: "t1", team_name: "A", wins: 2, losses: 1, sets_for: 10, sets_against: 5, total_points: 300, sets_played: 15 }];
    const standings = computeStandings(matches, adjustments);
    const a = standings.find(s => s.teamId === "t1");
    // real match (1 win, 3 setsFor, 500 pts) + imported (2 wins, 10 setsFor, 300 pts) summed
    expect(a).toMatchObject({ wins: 3, losses: 1, setsFor: 13, setsAgainst: 7, totalPoints: 800, setsPlayed: 20 });
  });

  it("an unmatched imported team (no team_id) still shows up, keyed by a synthetic manual: name", () => {
    const adjustments = [{ team_id: null, team_name: "Mystery Team", wins: 1, losses: 0, sets_for: 3, sets_against: 1, total_points: 200, sets_played: 4 }];
    const standings = computeStandings([], adjustments);
    expect(standings).toHaveLength(1);
    expect(standings[0].teamId).toBe("manual:Mystery Team");
    expect(standings[0].name).toBe("Mystery Team");
  });

  it("pointsPerSet is 0 (not NaN/Infinity) when a team has zero sets played", () => {
    const adjustments = [{ team_id: "t1", team_name: "A", wins: 0, losses: 0, sets_for: 0, sets_against: 0, total_points: 0, sets_played: 0 }];
    const standings = computeStandings([], adjustments);
    expect(standings[0].pointsPerSet).toBe(0);
  });

  it("a match missing either team id is skipped entirely (never crashes, never partially bumps a team)", () => {
    const matches = [{ team_home_id: null, team_away_id: "t2", team_home_total: 3, team_away_total: 1, is_makeup_pending: false }];
    const standings = computeStandings(matches, []);
    expect(standings).toHaveLength(0);
  });
});
