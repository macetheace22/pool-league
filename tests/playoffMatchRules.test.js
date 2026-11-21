import { describe, expect, it } from "vitest";
import { resolveTeamMatchWinner } from "../src/playoffMatchRules.js";

describe("IBA Rule 5.5 team match dead heats", () => {
  it("uses team points when totals are not tied", () => {
    expect(resolveTeamMatchWinner({ homePoints: 501, awayPoints: 500, homeSets: 2, awaySets: 3, isPlayoff: true })).toBe("home");
    expect(resolveTeamMatchWinner({ homePoints: 499, awayPoints: 500, homeSets: 3, awaySets: 2, isPlayoff: true })).toBe("away");
  });

  it("keeps a regular-season dead heat as a tie", () => {
    expect(resolveTeamMatchWinner({ homePoints: 500, awayPoints: 500, homeSets: 3, awaySets: 2, isPlayoff: false })).toBeNull();
  });

  it("awards a postseason dead heat to the team that won three of five sets", () => {
    expect(resolveTeamMatchWinner({ homePoints: 500, awayPoints: 500, homeSets: 3, awaySets: 2, isPlayoff: true, completedSets: 5 })).toBe("home");
    expect(resolveTeamMatchWinner({ homePoints: 500, awayPoints: 500, homeSets: 2, awaySets: 3, isPlayoff: true, completedSets: 5 })).toBe("away");
  });

  it("does not apply the postseason dead-heat rule before five sets are complete", () => {
    expect(resolveTeamMatchWinner({ homePoints: 500, awayPoints: 500, homeSets: 2, awaySets: 1, isPlayoff: true, completedSets: 3 })).toBeNull();
  });


  it("treats a Gladiator set as ordinary scoring and keeps team points primary", () => {
    expect(resolveTeamMatchWinner({
      homePoints: 450, awayPoints: 470, homeSets: 2, awaySets: 1, isPlayoff: true,
      completedSets: 3,
    })).toBe("away");
  });

  it("uses the ordinary postseason dead-heat rule after five sets including a Gladiator set", () => {
    expect(resolveTeamMatchWinner({
      homePoints: 500, awayPoints: 500, homeSets: 3, awaySets: 2, isPlayoff: true,
      completedSets: 5,
    })).toBe("home");
  });


  it("uses team points over the Gladiator set winner when totals differ", () => {
    expect(resolveTeamMatchWinner({
      homePoints: 490, awayPoints: 500, homeSets: 1, awaySets: 2, isPlayoff: true,
      completedSets: 3, gladiatorSet: { isGladiator: true, complete: true, winnerSlot: "home" },
    })).toBe("away");
  });

  it("uses the Gladiator set winner only to resolve tied points before five sets", () => {
    expect(resolveTeamMatchWinner({
      homePoints: 500, awayPoints: 500, homeSets: 1, awaySets: 2, isPlayoff: true,
      completedSets: 3, gladiatorSet: { isGladiator: true, complete: true, winnerSlot: "home" },
    })).toBe("home");
  });

  it("uses the three-of-five rule instead of the Gladiator set winner after five sets", () => {
    expect(resolveTeamMatchWinner({
      homePoints: 500, awayPoints: 500, homeSets: 3, awaySets: 2, isPlayoff: true,
      completedSets: 5, gladiatorSet: { isGladiator: true, complete: true, winnerSlot: "away" },
    })).toBe("home");
  });

  it("fails closed if five completed sets do not produce a three-set winner", () => {
    expect(resolveTeamMatchWinner({ homePoints: 500, awayPoints: 500, homeSets: 2, awaySets: 2, isPlayoff: true, completedSets: 5 })).toBeNull();
  });
});
