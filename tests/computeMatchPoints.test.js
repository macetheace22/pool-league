import { describe, it, expect } from "vitest";
import { computeMatchPoints } from "../db.js";

// Each test hand-verifies the expected numbers against the actual formula
// in db.js (margin = target - opponent's run; add-on = margin * 3; win
// bonus = 100), not against a re-implementation of it -- the point is to
// catch a future accidental change to that formula, not to encode
// assumptions that could drift from it.

describe("computeMatchPoints", () => {
  it("masters format: winner gets add-on + 100, loser gets 0", () => {
    // Away rated 45, runs 30 -> margin 15 -> addOn 45 -> home gets 45+100=145
    const state = {
      format: "masters",
      sets: [{
        complete: true, winnerSlot: "home",
        playerHome: { num: "1", rating: 50 },
        playerAway: { num: "2", rating: 45 },
        racks: [{ home: 50, away: 30 }],
      }],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 145, awayPoints: 0 });
  });

  it("non-masters (advanced/open) format: both sides keep their run, winner also gets add-on + 100", () => {
    // Home rated 50, runs 20 -> margin 30 -> addOn 90 -> away gets 40+90+100=230
    // Home (loser) keeps its own run: 20
    const state = {
      format: "advanced",
      sets: [{
        complete: true, winnerSlot: "away",
        playerHome: { num: "1", rating: 50 },
        playerAway: { num: "2", rating: 40 },
        racks: [{ home: 20, away: 40 }],
      }],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 20, awayPoints: 230 });
  });

  it("unrated (NR, rating <= 2) player forces BOTH players to the format's fixed race target", () => {
    // Open format -> fixed target 45 for both, regardless of the rated player's real rating (50)
    // Away runs 20 -> margin against fixed 45 = 25 -> addOn 75 -> home (winner) = 45 + 75 + 100 = 220
    const state = {
      format: "open",
      sets: [{
        complete: true, winnerSlot: "home",
        playerHome: { num: "1", rating: 1 }, // NR
        playerAway: { num: "2", rating: 50 },
        racks: [{ home: 45, away: 20 }],
      }],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 220, awayPoints: 20 });
  });

  it("forfeit: receiving side gets the flat forfeit point value, forfeiting side gets 0", () => {
    const state = {
      format: "masters",
      sets: [{ complete: true, forfeited: true, forfeitedBy: "home", forfeitPoints: 100 }],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 0, awayPoints: 100 });
  });

  it("incomplete sets are ignored entirely", () => {
    const state = {
      format: "masters",
      sets: [
        { complete: false, winnerSlot: "home", playerHome: { rating: 50 }, playerAway: { rating: 50 }, racks: [{ home: 50, away: 0 }] },
      ],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 0, awayPoints: 0 });
  });

  it("a complete set with no winnerSlot (e.g. mid-correction) contributes nothing", () => {
    const state = {
      format: "masters",
      sets: [{ complete: true, winnerSlot: null, playerHome: { rating: 50 }, playerAway: { rating: 45 }, racks: [{ home: 10, away: 10 }] }],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 0, awayPoints: 0 });
  });

  it("accumulates correctly across multiple complete sets, skipping incomplete ones", () => {
    const state = {
      format: "masters",
      sets: [
        { // set 1: home wins, away rated 45 runs 30 -> margin 15 -> addOn 45 -> home 145
          complete: true, winnerSlot: "home",
          playerHome: { rating: 50 }, playerAway: { rating: 45 },
          racks: [{ home: 50, away: 30 }],
        },
        { complete: false }, // ignored
        { // set 2: away wins, home rated 50 runs 40 -> margin 10 -> addOn 30 -> away 130
          complete: true, winnerSlot: "away",
          playerHome: { rating: 50 }, playerAway: { rating: 45 },
          racks: [{ home: 40, away: 45 }],
        },
      ],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 145, awayPoints: 130 });
  });

  it("defaults to masters format when state.format is missing", () => {
    const state = {
      sets: [{
        complete: true, winnerSlot: "home",
        playerHome: { rating: 50 }, playerAway: { rating: 45 },
        racks: [{ home: 50, away: 30 }],
      }],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 145, awayPoints: 0 });
  });
});
