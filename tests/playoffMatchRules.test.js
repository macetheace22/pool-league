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


  it("uses the completed Gladiator set winner as the sudden-death match winner", () => {
    expect(resolveTeamMatchWinner({
      homePoints: 450, awayPoints: 470, homeSets: 1, awaySets: 2, isPlayoff: true,
      completedSets: 3, gladiatorSet: { isGladiator: true, complete: true, winnerSlot: "home" },
    })).toBe("home");
  });


  it("does not apply a Gladiator winner to a regular-season match", () => {
    expect(resolveTeamMatchWinner({
      homePoints: 450, awayPoints: 470, homeSets: 1, awaySets: 2, isPlayoff: false,
      completedSets: 3, gladiatorSet: { isGladiator: true, complete: true, winnerSlot: "home" },
    })).toBe("away");
  });

  it("does not treat an unfinished Gladiator set as a match winner", () => {
    expect(resolveTeamMatchWinner({
      homePoints: 450, awayPoints: 470, homeSets: 1, awaySets: 2, isPlayoff: true,
      completedSets: 3, gladiatorSet: { isGladiator: true, complete: false, winnerSlot: "home" },
    })).toBe("away");
  });

  it("fails closed if five completed sets do not produce a three-set winner", () => {
    expect(resolveTeamMatchWinner({ homePoints: 500, awayPoints: 500, homeSets: 2, awaySets: 2, isPlayoff: true, completedSets: 5 })).toBeNull();
  });
});
