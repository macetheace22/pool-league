import { describe, expect, it } from "vitest";
import { buildPracticeOpponentShortcuts } from "../src/practiceOpponentShortcuts";

describe("buildPracticeOpponentShortcuts", () => {
  it("includes league players from completed Practice history and deduplicates by player number", () => {
    const shortcuts = buildPracticeOpponentShortcuts([
      { id: "old", practice_type: "opponent", opponent_player_num: "33159", opponent_name: "Jason P.", opponent_rating: 5, completed_at: "2026-10-01" },
      { id: "new", practice_type: "opponent", opponent_player_num: "33159", opponent_name: "Jason Phad", opponent_rating: 6, completed_at: "2026-10-12" },
      { id: "other", practice_type: "opponent", opponent_player_num: "44120", opponent_name: "Alex Pool", completed_at: "2026-10-10" },
    ]);
    expect(shortcuts).toEqual([
      expect.objectContaining({ key: "player:33159", type: "player", num: "33159", name: "Jason Phad", rating: 6 }),
      expect.objectContaining({ key: "player:44120", type: "player", num: "44120", name: "Alex Pool" }),
    ]);
  });

  it("uses the linked-game owner as the prior league opponent", () => {
    const shortcuts = buildPracticeOpponentShortcuts([
      {
        practice_type: "opponent",
        viewer_perspective: "linked",
        owner_player_num: "33159",
        owner_display_name: "Jason Phad",
        my_rating: 6,
      },
    ]);
    expect(shortcuts).toEqual([
      expect.objectContaining({ key: "player:33159", num: "33159", name: "Jason Phad", rating: 6 }),
    ]);
  });

  it("keeps manually entered and linked guest opponents available without duplicating them", () => {
    const shortcuts = buildPracticeOpponentShortcuts([], [
      { id: "guest-1", name: "Taylor Guest" },
      { id: "guest-2", name: "Sam Guest", display_name: "Sam G.", linked_profile_id: "profile-2" },
      { id: "guest-1", name: "Duplicate Taylor" },
    ]);
    expect(shortcuts).toEqual([
      expect.objectContaining({ key: "manual:guest-1", type: "manual", name: "Taylor Guest" }),
      expect.objectContaining({ key: "manual:guest-2", type: "manual", name: "Sam G.", linked_profile_id: "profile-2" }),
    ]);
  });

  it("does not add skills-and-drills sessions or games without a league player number", () => {
    const shortcuts = buildPracticeOpponentShortcuts([
      { practice_type: "skills_drills", opponent_player_num: "33159" },
      { practice_type: "opponent", opponent_player_num: null, opponent_name: "Guest only" },
    ]);
    expect(shortcuts).toEqual([]);
  });
});
