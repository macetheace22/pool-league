import { describe, expect, it } from "vitest";
import { buildSeasonalByePlan, classifyChampionshipSeed, classifyConsolationSeed } from "../src/seasonalTournamentSeeding";

describe("Section 5.4 seasonal tournament seeding", () => {
  it("classifies the three Championship categories", () => {
    expect(classifyChampionshipSeed({ divisionFinishPosition: 1, divisionChampion: true })).toBe("first_place_and_division_champion");
    expect(classifyChampionshipSeed({ divisionFinishPosition: 1, divisionChampion: false })).toBe("first_place_not_division_champion");
    expect(classifyChampionshipSeed({ divisionFinishPosition: 3, divisionChampion: true })).toBe("below_first_division_champion");
    expect(classifyChampionshipSeed({ divisionFinishPosition: 3, divisionChampion: false })).toBeNull();
  });
  it("classifies Consolation champions by bye history", () => {
    expect(classifyConsolationSeed({ consolationChampion: true, receivedBye: false })).toBe("consolation_champion_back_to_back_wins");
    expect(classifyConsolationSeed({ consolationChampion: true, receivedBye: true })).toBe("consolation_champion_after_bye");
    expect(classifyConsolationSeed({ consolationChampion: true })).toBe("consolation_champion_history_unverified");
    expect(classifyConsolationSeed({ consolationChampion: false })).toBeNull();
  });
  it("calculates field-size byes but does not break an unstated within-category tie", () => {
    const teams = Array.from({ length: 6 }, (_, i) => ({ teamId: "t" + (i + 1), seedCategory: "first_place_and_division_champion" }));
    const plan = buildSeasonalByePlan("championship", teams);
    expect(plan.bracketSize).toBe(8);
    expect(plan.byeCount).toBe(2);
    expect(plan.awardedTeamIds).toEqual([]);
    expect(plan.pendingTeamIds).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(plan.unresolvedByes).toBe(2);
    expect(plan.requiresReview).toBe(true);
  });
  it("holds a category tied at the bye cutoff for review", () => {
    const teams = [
      { teamId: "a", seedCategory: "first_place_and_division_champion" },
      { teamId: "b", seedCategory: "first_place_not_division_champion" },
      { teamId: "c", seedCategory: "first_place_not_division_champion" },
      { teamId: "d", seedCategory: "first_place_not_division_champion" },
      { teamId: "e", seedCategory: "below_first_division_champion" },
    ];
    const plan = buildSeasonalByePlan("championship", teams);
    expect(plan.byeCount).toBe(3);
    expect(plan.awardedTeamIds).toEqual(["a"]);
    expect(plan.pendingTeamIds).toEqual(["b", "c", "d"]);
    expect(plan.requiresReview).toBe(true);
  });
  it("uses explicit trusted byeRank to resolve a cutoff tie", () => {
    const teams = [
      { teamId: "a", seedCategory: "first_place_and_division_champion" },
      { teamId: "b", seedCategory: "first_place_not_division_champion", byeRank: 2 },
      { teamId: "c", seedCategory: "first_place_not_division_champion", byeRank: 1 },
      { teamId: "d", seedCategory: "first_place_not_division_champion", byeRank: 3 },
      { teamId: "e", seedCategory: "below_first_division_champion" },
    ];
    const plan = buildSeasonalByePlan("championship", teams);
    expect(plan.awardedTeamIds).toEqual(["a", "c", "b"]);
    // The third category is lower priority and the bye count is already filled.
    expect(plan.nonByeTeamIds).toEqual(["d", "e"]);
    expect(plan.pendingTeamIds).toEqual([]);
    expect(plan.requiresReview).toBe(false);
  });
  it("prioritizes back-to-back Consolation champions but holds their internal tie for review", () => {
    const teams = [
      { teamId: "bye-winner", seedCategory: "consolation_champion_after_bye" },
      { teamId: "two-wins", seedCategory: "consolation_champion_back_to_back_wins" },
      { teamId: "two-wins-2", seedCategory: "consolation_champion_back_to_back_wins" },
    ];
    const plan = buildSeasonalByePlan("consolation", teams);
    expect(plan.byeCount).toBe(1);
    expect(plan.awardedTeamIds).toEqual([]);
    expect(plan.pendingTeamIds).toEqual(["two-wins", "two-wins-2"]);
    expect(plan.nonByeTeamIds).toEqual(["bye-winner"]);
    expect(plan.requiresReview).toBe(true);
  });
});
