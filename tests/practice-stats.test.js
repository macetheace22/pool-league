import { describe, expect, it } from "vitest";
import { filterPracticeGamesByType, matchesPracticeGameType } from "../src/practiceStats.js";

const games = [
  { id: "8a", game_type: "8ball", practice_type: "opponent", winner: "me" },
  { id: "9a", game_type: "9ball", practice_type: "opponent", winner: "opponent" },
  { id: "10a", game_type: "10ball", practice_type: "opponent", winner: "me" },
  { id: "ua", game_type: "ultimate", practice_type: "opponent", winner: "opponent" },
  { id: "sd", game_type: null, practice_type: "skills_drills", winner: null },
];

describe("Practice game-type stats filter", () => {
  it("selects all game types by default and excludes Skills & Drills", () => {
    expect(filterPracticeGamesByType(games, ["8ball", "9ball", "10ball", "ultimate"]).map(game => game.id))
      .toEqual(["8a", "9a", "10a", "ua"]);
  });

  it.each(["8ball", "9ball", "10ball", "ultimate"])(
    "filters Practice results to only selected %s", gameType => {
      expect(filterPracticeGamesByType(games, [gameType]).map(game => game.game_type)).toEqual([gameType]);
    }
  );

  it("supports combinations and an empty selection", () => {
    expect(filterPracticeGamesByType(games, ["8ball", "9ball"]).map(game => game.id)).toEqual(["8a", "9a"]);
    expect(filterPracticeGamesByType(games, []).map(game => game.id)).toEqual([]);
  });

  it("does not apply the Practice-only filter to League shot events", () => {
    expect(matchesPracticeGameType({ context_type: "live_match", game_type: "9ball" }, ["8ball"])).toBe(true);
    expect(matchesPracticeGameType({ context_type: "practice_game", game_type: "9ball" }, ["8ball"])).toBe(false);
    expect(matchesPracticeGameType({ context_type: "practice_game", game_type: "8ball" }, ["8ball"])).toBe(true);
  });
});
