import { describe, expect, it } from "vitest";
import { toDisplaySets } from "../src/Scoresheet.jsx";

describe("Section 6.11 scoresheet identifiers", () => {
  it("preserves player numbers from live-match state", () => {
    const match = { state: { sets: [{ setNum: 1, complete: true, playerHome: { num: "12345", name: "Home", rating: 50 }, playerAway: { num: "67890", name: "Away", rating: 55 }, racks: [{ home: 50, away: 10, innings: 3, safetyHome: 1, safetyAway: 0 }], winnerSlot: "home" }] } };
    const [set] = toDisplaySets(match);
    expect(set.playerA.num).toBe("12345");
    expect(set.playerB.num).toBe("67890");
  });

  it("preserves per-game innings for the optional completed Scoresheet row", () => {
    const match = { state: { sets: [{
      setNum: 1, complete: true,
      playerHome: { num: "12345", name: "Home", rating: 50 },
      playerAway: { num: "67890", name: "Away", rating: 55 },
      racks: [
        { home: 50, away: 10, innings: 3 },
        { home: 25, away: 40, innings: 5 },
      ],
      winnerSlot: "home",
    }] } };
    const [set] = toDisplaySets(match);
    expect(set.racks.map(rack => rack.innings)).toEqual([3, 5]);
    expect(set.totalInnings).toBe(8);
  });

  it("retains every set and distinguishes final forfeits from unplayed sets", () => {
    const match = { state: { sets: [
      { setNum: 1, complete: true, playerHome: { name: "Home", num: "1", rating: 50 }, playerAway: { name: "Away", num: "2", rating: 55 }, racks: [{ home: 50, away: 20 }], winnerSlot: "home" },
      { setNum: 2, complete: true, forfeited: true, forfeitedBy: "away", forfeitPoints: 125, playerHome: { name: "Home 2", num: "3", rating: 50 }, playerAway: { name: "Away 2", num: "4", rating: 55 }, winnerSlot: "home" },
      { setNum: 3, complete: false, playerHome: null, playerAway: null, racks: [] },
    ] } };
    const sets = toDisplaySets(match);
    expect(sets).toHaveLength(3);
    expect(sets.map(set => set.status)).toEqual(["played", "forfeited", "unplayed"]);
    expect(sets[1].forfeitedBy).toBe("away");
    expect(sets[2].winnerSide).toBeNull();
  });

  it("labels unfinished sets as awaiting makeup while the match is pending", () => {
    const match = { is_makeup_pending: true, state: { sets: [
      { setNum: 1, complete: true, playerHome: { name: "Home", rating: 50 }, playerAway: { name: "Away", rating: 55 }, racks: [{ home: 50, away: 20 }], winnerSlot: "home" },
      { setNum: 2, complete: false, playerHome: null, playerAway: null, racks: [] },
    ] } };
    const sets = toDisplaySets(match);
    expect(sets.map(set => set.status)).toEqual(["played", "makeup-pending"]);
  });

  it("preserves player numbers on forfeited completed sets", () => {
    const match = { state: { sets: [{
      setNum: 1, complete: true, forfeited: true,
      playerHome: { num: "12345", name: "Home", rating: 50 },
      playerAway: { num: "67890", name: "Away", rating: 55 },
      winnerSlot: "away",
    }] } };
    const [set] = toDisplaySets(match);
    expect(set.playerA.num).toBe("12345");
    expect(set.playerB.num).toBe("67890");
    expect(set.forfeited).toBe(true);
  });
});
