import { describe, expect, it } from "vitest";
import { reversePracticeWinner, toLinkedPracticeGame, toPracticeResultPerspective } from "../src/practiceHistory";

describe("linked practice history perspective", () => {
  it("reverses the session result and identifies the original creator as the opponent", () => {
    const source = { id: "game-1", created_by: "owner-id", opponent_name: "Old guest label", my_score: 5, opponent_score: 3, winner: "me" };
    const linked = toLinkedPracticeGame(source, { username: "OwnerName", player_num: "12345" });
    expect(linked).toMatchObject({ viewer_perspective: "linked", owner_profile_id: "owner-id", owner_username: "OwnerName", owner_player_num: "12345", opponent_name: "OwnerName", my_score: 3, opponent_score: 5, winner: "opponent" });
    expect(source).toEqual({ id: "game-1", created_by: "owner-id", opponent_name: "Old guest label", my_score: 5, opponent_score: 3, winner: "me" });
  });
  it("reverses individual game points and winner only for the linked viewer", () => {
    const source = { my_points: 42, opponent_points: 58, winner: "opponent" };
    expect(toPracticeResultPerspective(source, true)).toEqual({ my_points: 58, opponent_points: 42, winner: "me" });
    expect(toPracticeResultPerspective(source, false)).toBe(source);
  });
  it("reverses winners without changing unknown or empty values", () => {
    expect(reversePracticeWinner("me")).toBe("opponent");
    expect(reversePracticeWinner("opponent")).toBe("me");
    expect(reversePracticeWinner(null)).toBe(null);
  });
  it("keeps source rows immutable when owner details are unavailable", () => {
    const source = { created_by: "owner-id", opponent_name: "Guest", my_score: 4, opponent_score: 2, winner: "me" };
    expect(toLinkedPracticeGame(source, {})).toMatchObject({ opponent_name: "Guest", my_score: 2, opponent_score: 4, winner: "opponent" });
    expect(source).toMatchObject({ my_score: 4, opponent_score: 2, winner: "me" });
  });
});
