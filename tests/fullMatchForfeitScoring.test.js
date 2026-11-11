import { describe, expect, it } from "vitest";
import { computeMatchPoints } from "../src/db.js";

function fiveForfeitedSets(forfeitingSide) {
  const receivingSide = forfeitingSide === "home" ? "away" : "home";
  return Array.from({ length: 5 }, (_, index) => {
    const forfeitingPlayer = { num: String(index + 1), rating: 70 };
    const receivingPlayer = { num: String(index + 6), rating: 50 };
    return {
      setNum: index + 1,
      complete: true,
      winnerSlot: receivingSide,
      playerHome: forfeitingSide === "home" ? forfeitingPlayer : receivingPlayer,
      playerAway: forfeitingSide === "away" ? forfeitingPlayer : receivingPlayer,
      racks: [],
      forfeited: true,
      forfeitedBy: forfeitingSide,
      forfeitPoints: 150,
    };
  });
}

describe("Rule 6.5 full-team-match forfeits", () => {
  it.each(["home", "away"])(
    "awards exactly zero team points to the %s team when it forfeits the entire match",
    (forfeitingSide) => {
      const state = {
        format: "advanced",
        fullMatchForfeit: { forfeitingSide },
        sets: fiveForfeitedSets(forfeitingSide),
      };
      const result = computeMatchPoints(state);

      if (forfeitingSide === "home") {
        // Home's 350 rating would normally incur a 125-point penalty.
        // The full-match-forfeit rule overrides it; away receives 750 set
        // points plus its 75-point team rating bonus.
        expect(result).toEqual({ homePoints: 0, awayPoints: 825 });
      } else {
        expect(result).toEqual({ homePoints: 825, awayPoints: 0 });
      }
    }
  );

  it("retains the Section 6.4 over-limit penalty for separately forfeited individual sets", () => {
    const state = {
      format: "advanced",
      // Deliberately no fullMatchForfeit marker: these are individual set
      // forfeits, not a whole-team-match forfeit under Section 6.5.
      sets: fiveForfeitedSets("home"),
    };

    expect(computeMatchPoints(state)).toEqual({
      homePoints: -125,
      awayPoints: 825,
    });
  });
});
