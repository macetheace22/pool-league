import { describe, expect, it } from "vitest";
import { buildDivisionMvpTieBreakAudit } from "../src/divisionMvpTieBreak.js";

const officialMvp = [
  { num: "11111", name: "Player One", teamNum: "A", mvpRanking: 1200, position: 1 },
  { num: "22222", name: "Player Two", teamNum: "B", mvpRanking: 1200, position: 2 },
  { num: "33333", name: "Player Three", teamNum: "C", mvpRanking: 1100, position: 3 },
];
const schedule = [{
  date: "9/1/2026", pairings: [{
    id: "pair-1", homeTeamId: "team-a", awayTeamId: "team-b",
  }],
}];
const match = (sets, format = "open") => ({
  team_home_id: "team-a", team_away_id: "team-b", format,
  state: { schedulePairingId: "pair-1", format, sets },
});
const set = (home, away, racks, winnerSlot = "home") => ({
  complete: true, winnerSlot, playerHome: home, playerAway: away,
  racks: racks.map(([h, a]) => ({ home: h, away: a })),
});

describe("Division MVP Rule 5.5 tie-break audit", () => {
  it("does not run unless the top official IBA MVP ranking is tied", () => {
    expect(buildDivisionMvpTieBreakAudit({
      officialMvp: [officialMvp[0], { ...officialMvp[1], mvpRanking: 1199 }],
    })).toEqual([]);
  });

  it("uses individual format-scored head-to-head points, not MVP bonuses", () => {
    const rows = buildDivisionMvpTieBreakAudit({
      officialMvp,
      schedule,
      matches: [match([set(
        { num: "11111", rating: 40 },
        { num: "22222", rating: 35 },
        [[20, 10], [25, 10]],
        "home",
      )])],
    });
    expect(rows[0].outcome).toBe("head-to-head-points");
    expect(rows[0].players.map(player => player.headToHeadPoints)).toEqual([165, 20]);
  });

  it("uses historical ratings of regular-season opponents and requires a 5-point gap", () => {
    const matches = [
      match([set({ num: "11111", rating: 40 }, { num: "44444", rating: 50 }, [[10, 10]], "home")]),
      {
        team_home_id: "team-c", team_away_id: "team-b", format: "open",
        state: { schedulePairingId: "pair-2", format: "open", sets: [
          set({ num: "55555", rating: 40 }, { num: "22222", rating: 45 }, [[10, 10]], "home"),
        ] },
      },
    ];
    const result = buildDivisionMvpTieBreakAudit({
      officialMvp,
      schedule: [
        ...schedule,
        { date: "9/8/2026", pairings: [{ id: "pair-2", homeTeamId: "team-c", awayTeamId: "team-b" }] },
      ],
      matches,
    });
    expect(result[0].players[0].averageOpponentRating).toBe(50);
    expect(result[0].players[1].averageOpponentRating).toBe(40);
    expect(result[0].outcome).toBe("opponent-rating-average");
  });

  it("does not treat missing opponent ratings as zero or use playoff matches", () => {
    const result = buildDivisionMvpTieBreakAudit({
      officialMvp,
      schedule: [
        ...schedule,
        { date: "9/15/2026", isPlayoff: true, pairings: [{ id: "pair-playoff", homeTeamId: "team-a", awayTeamId: "team-b" }] },
      ],
      matches: [
        match([set({ num: "11111", rating: 40 }, { num: "44444", rating: null }, [[10, 10]])]),
        {
          team_home_id: "team-a", team_away_id: "team-b",
          state: { schedulePairingId: "pair-playoff", isPlayoff: true, sets: [
            set({ num: "11111", rating: 40 }, { num: "22222", rating: 40 }, [[10, 10]]),
          ] },
        },
      ],
    });
    expect(result[0].players[0].averageOpponentRating).toBeNull();
    expect(result[0].outcome).toBe("single-set-playoff-required");
  });

  it("requires the single-set playoff when neither numeric tie-break resolves the tie", () => {
    const result = buildDivisionMvpTieBreakAudit({
      officialMvp,
      schedule,
      matches: [match([set(
        { num: "11111", rating: 40 },
        { num: "22222", rating: 40 },
        [[10, 10]],
        "home",
      )])],
    });
    expect(result[0].outcome).toBe("single-set-playoff-required");
  });
});
