import { describe, it, expect } from "vitest";
import { computeMvp } from "../db.js";

describe("computeMvp", () => {
  it("masters format: winner's mvpRanking = points + 200, loser's = 0 - 200", () => {
    const matches = [{
      state: {
        format: "masters",
        sets: [{
          complete: true, winnerSlot: "home",
          playerHome: { num: "1", name: "Alice", rating: 50 },
          playerAway: { num: "2", name: "Bob", rating: 45 },
          racks: [{ home: 50, away: 30 }], // away margin 15 -> addOn 45 -> Alice pointsScored 145
        }],
      },
    }];
    const mvp = computeMvp(matches, []);
    const alice = mvp.find(p => p.num === "1");
    const bob = mvp.find(p => p.num === "2");
    expect(alice).toMatchObject({ wins: 1, losses: 0, pointsScored: 145, mvpRanking: 345 });
    expect(bob).toMatchObject({ wins: 0, losses: 1, pointsScored: 0, mvpRanking: -200 });
  });

  it("non-masters format: the loser keeps their own run as pointsScored instead of 0", () => {
    const matches = [{
      state: {
        format: "advanced",
        sets: [{
          complete: true, winnerSlot: "away",
          playerHome: { num: "1", name: "Alice", rating: 50 },
          playerAway: { num: "2", name: "Bob", rating: 40 },
          racks: [{ home: 20, away: 40 }], // home margin 30 -> addOn 90 -> Bob pointsScored 230
        }],
      },
    }];
    const mvp = computeMvp(matches, []);
    const alice = mvp.find(p => p.num === "1");
    const bob = mvp.find(p => p.num === "2");
    expect(bob).toMatchObject({ wins: 1, losses: 0, pointsScored: 230, mvpRanking: 430 });
    expect(alice).toMatchObject({ wins: 0, losses: 1, pointsScored: 20, mvpRanking: -180 });
  });

  it("forfeit win earns its flat point value with NO +200 win bonus", () => {
    const matches = [{
      state: {
        format: "masters",
        sets: [{
          complete: true, forfeited: true, forfeitedBy: "away", forfeitPoints: 100,
          playerHome: { num: "1", name: "Alice" }, playerAway: { num: "2", name: "Bob" },
        }],
      },
    }];
    const mvp = computeMvp(matches, []);
    const alice = mvp.find(p => p.num === "1"); // away forfeited -> home (Alice) receives
    const bob = mvp.find(p => p.num === "2");
    expect(alice).toMatchObject({ wins: 1, forfeitWins: 1, pointsScored: 100, mvpRanking: 100 });
    expect(bob).toMatchObject({ losses: 1, mvpRanking: -200 });
  });

  it("unrated (NR) player forces both to the fixed race target, same as computeMatchPoints", () => {
    const matches = [{
      state: {
        format: "open",
        sets: [{
          complete: true, winnerSlot: "home",
          playerHome: { num: "1", name: "Alice", rating: 1 }, // NR
          playerAway: { num: "2", name: "Bob", rating: 50 },
          racks: [{ home: 45, away: 20 }], // fixed target 45 both sides -> away margin 25 -> addOn 75 -> Alice pointsScored 220
        }],
      },
    }];
    const mvp = computeMvp(matches, []);
    expect(mvp.find(p => p.num === "1").pointsScored).toBe(220);
  });

  it("imported weeks trust the report's own pre-computed mvp_ranking_points rather than recomputing", () => {
    const adjustments = [{ player_num: "9", player_name: "Carol", wins: 3, losses: 1, total_points: 500, mvp_ranking_points: 800 }];
    const mvp = computeMvp([], adjustments);
    const carol = mvp.find(p => p.num === "9");
    expect(carol).toMatchObject({ wins: 3, losses: 1, sets: 4, pointsScored: 500, mvpRanking: 800 });
  });

  it("an unmatched imported player (no player_num) still shows up, keyed by a synthetic manual: name", () => {
    const adjustments = [{ player_num: null, player_name: "Mystery Player", wins: 1, losses: 0, total_points: 150, mvp_ranking_points: 350 }];
    const mvp = computeMvp([], adjustments);
    expect(mvp).toHaveLength(1);
    expect(mvp[0].num).toBe("manual:Mystery Player");
  });

  it("results are sorted by mvpRanking descending", () => {
    const adjustments = [
      { player_num: "1", player_name: "Low", wins: 0, losses: 1, total_points: 0, mvp_ranking_points: -200 },
      { player_num: "2", player_name: "High", wins: 1, losses: 0, total_points: 300, mvp_ranking_points: 500 },
    ];
    const mvp = computeMvp([], adjustments);
    expect(mvp[0].num).toBe("2");
    expect(mvp[1].num).toBe("1");
  });

  it("incomplete sets are ignored entirely", () => {
    const matches = [{
      state: {
        format: "masters",
        sets: [{ complete: false, winnerSlot: "home", playerHome: { num: "1", name: "A" }, playerAway: { num: "2", name: "B" }, racks: [] }],
      },
    }];
    expect(computeMvp(matches, [])).toHaveLength(0);
  });
});
