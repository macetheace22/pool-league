import { describe, expect, it } from "vitest";
import { computeMatchPoints } from "../src/db.js";

describe("Gladiator match scoring", () => {
  it("suppresses positive rating bonuses when the Gladiator set ends the match before remaining sets", () => {
    const playerHome = { num: "1", rating: 50 };
    const playerAway = { num: "2", rating: 50 };
    const state = {
      format: "open",
      sets: [
        { complete: true, winnerSlot: "home", playerHome, playerAway, racks: [{ home: 45, away: 30 }] },
        { complete: true, winnerSlot: "away", isGladiator: true, playerHome, playerAway, racks: [{ home: 30, away: 45 }] },
        ...Array.from({ length: 3 }, (_, index) => ({ setNum: index + 3, complete: false, winnerSlot: null, playerHome: null, playerAway: null, racks: [] })),
      ],
    };
    expect(computeMatchPoints(state)).toEqual({ homePoints: 175, awayPoints: 175 });
  });
});
