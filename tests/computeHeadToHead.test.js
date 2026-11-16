import { describe, expect, it } from "vitest";
import { groupHeadToHeadEvents } from "../src/db.js";

describe("groupHeadToHeadEvents", () => {
  it("groups league and practice events for the same IBA opponent together", () => {
    const events = [
      { context_type: "live_match", opponent_player_num: "12345" },
      { context_type: "practice_game", opponent_player_num: "12345" },
    ];
    const groups = groupHeadToHeadEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("12345");
    expect(groups[0].events).toHaveLength(2);
  });

  it("groups manual practice opponents by saved name without merging different guests", () => {
    const events = [
      { context_type: "practice_game", context_id: "game-1", opponent_player_num: null },
      { context_type: "practice_game", context_id: "game-2", opponent_player_num: null },
      { context_type: "practice_game", context_id: "game-3", opponent_player_num: null },
    ];
    const groups = groupHeadToHeadEvents(events, {
      "game-1": "Alex",
      "game-2": " alex ",
      "game-3": "Jordan",
    });
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.key === "manual:alex").events).toHaveLength(2);
    expect(groups.find(group => group.key === "manual:jordan").manualName).toBe("Jordan");
  });

  it("keeps practice events without a player number or saved name in an unknown bucket", () => {
    const groups = groupHeadToHeadEvents([
      { context_type: "practice_game", context_id: "game-1", opponent_player_num: null },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("unknown");
  });
  it("excludes solo skills-and-drills sessions from opponent comparisons", () => {
    const events = [
      { context_type: "practice_game", context_id: "drill-1", opponent_player_num: null },
      { context_type: "practice_game", context_id: "opponent-1", opponent_player_num: null },
    ];
    const groups = groupHeadToHeadEvents(events, { "opponent-1": "Alex" }, ["drill-1"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("manual:alex");
  });

});