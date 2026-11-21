import { describe, expect, it } from "vitest";
import { canOfferGladiatorMatch, createGladiatorSet, gladiatorPlayerChoices } from "../src/gladiatorMatch.js";

const played = (num, name) => ({ num, name, rating: 70 });
const sets = [
  { setNum: 1, complete: true, winnerSlot: "home", playerHome: played("H1", "Home One"), playerAway: played("A1", "Away One") },
  { setNum: 2, complete: true, winnerSlot: "away", playerHome: played("H2", "Home Two"), playerAway: played("A2", "Away Two") },
  { setNum: 3, complete: false, playerHome: null, playerAway: null },
  { setNum: 4, complete: false, playerHome: null, playerAway: null },
  { setNum: 5, complete: false, playerHome: null, playerAway: null },
];

describe("IBA Rule 5.5 Gladiator match", () => {
  it("is offered only in postseason after at least one set and before five", () => {
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(true);
    expect(canOfferGladiatorMatch({ isPlayoff: false, sets, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets, setIdx: 0, homePoints: 200, awayPoints: 200 })).toBe(false);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets, setIdx: 5, homePoints: 200, awayPoints: 200 })).toBe(false);
  });


  it("does not offer Gladiator when one team already leads on match points", () => {
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets, setIdx: 2, homePoints: 201, awayPoints: 200 })).toBe(false);
  });

  it("requires the current set to be unplayed", () => {
    const completed = sets.map((s, i) => i === 2 ? { ...s, complete: true, winnerSlot: "home" } : s);
    const rackStarted = sets.map((s, i) => i === 2 ? { ...s, racks: [{ home: 1, away: 0 }] } : s);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: completed, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: rackStarted, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
  });


  it("requires every earlier set to be complete and no later set to have started", () => {
    const earlierIncomplete = sets.map((set, i) => i === 1 ? { ...set, complete: false } : set);
    const laterAssigned = sets.map((set, i) => i === 3 ? { ...set, playerHome: played("H4", "Home Four") } : set);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: earlierIncomplete, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: laterAssigned, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
  });

  it("allows an unplayed put-up lineup to convert to Gladiator if no rack has started", () => {
    const onePlayerPutUp = sets.map((s, i) => i === 2 ? { ...s, playerHome: played("H3", "Home Three") } : s);
    const bothPutUp = onePlayerPutUp.map((s, i) => i === 2 ? { ...s, playerAway: played("A3", "Away Three") } : s);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: onePlayerPutUp, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(true);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: bothPutUp, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(true);
    const started = onePlayerPutUp.map((s, i) => i === 2 ? { ...s, racks: [{ home: 10, away: 5 }] } : s);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: started, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
  });

  it("does not offer Gladiator if either side has no previously played player", () => {
    const missingHome = sets.map(s => ({ ...s, playerHome: null }));
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: missingHome, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
  });

  it("does not offer a second Gladiator or proceed after a prior forfeit", () => {
    const priorGladiator = sets.map((s, i) => i === 1 ? { ...s, isGladiator: true } : s);
    const priorForfeit = sets.map((s, i) => i === 1 ? { ...s, forfeited: true } : s);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: priorGladiator, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
    expect(canOfferGladiatorMatch({ isPlayoff: true, sets: priorForfeit, setIdx: 2, homePoints: 200, awayPoints: 200 })).toBe(false);
  });

  it("excludes players from completed sets that have no recorded winner", () => {
    const invalidPrior = sets.map((s, i) => i === 1 ? { ...s, winnerSlot: null } : s);
    expect(gladiatorPlayerChoices(invalidPrior, 2, "home").map(p => p.num)).toEqual(["H1"]);
  });

  it("offers only players who completed a prior non-forfeit set for that team", () => {
    expect(gladiatorPlayerChoices(sets, 2, "home").map(p => p.num)).toEqual(["H1", "H2"]);
    expect(gladiatorPlayerChoices(sets, 2, "away").map(p => p.num)).toEqual(["A1", "A2"]);
  });


  it("rejects a Gladiator player who did not play an earlier set", () => {
    expect(createGladiatorSet(sets[2], 2, played("H9", "Not Played"), played("A2", "Away Two"), sets)).toBeNull();
  });

  it("marks the selected repeat players as a separate Gladiator set", () => {
    const result = createGladiatorSet(sets[2], 2, played("H1", "Home One"), played("A2", "Away Two"), sets);
    expect(result.isGladiator).toBe(true);
    expect(result.setNum).toBe(3);
    expect(result.playerHome.num).toBe("H1");
    expect(result.playerAway.num).toBe("A2");
    expect(result.racks).toEqual([]);
    expect(result.complete).toBe(false);
    expect(createGladiatorSet(sets[2], 2, played("H3", "Never Played"), played("A2", "Away Two"), sets)).toBeNull();
  });
});
