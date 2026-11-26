import { describe, expect, it } from "vitest";
import { buildRecentActivity } from "../src/Dashboard";

describe("Recent Activity feed", () => {
  it("combines league matches and Practice sessions in newest-first order", () => {
    const items = buildRecentActivity([
      { team: { id: "team-a", name: "Team A" }, myCompleted: [
        { id: "match-1", division_id: "division-a", team_home_id: "team-a", team_home_points: 8, team_away_points: 4, team_away_name: "Team B", confirmed_at: "2026-10-02T20:00:00Z", week_date: "10/2/2026" },
      ] },
    ], [
      { id: "practice-1", opponent_name: "Jordan", played_at: "2026-10-03T20:00:00Z", winner: "me" },
    ]);
    expect(items.map(item => item.key)).toEqual(["practice:practice-1", "league:match-1:team-a"]);
    expect(items[0]).toMatchObject({ title: "Practice vs Jordan", resultLabel: "Won" });
    expect(items[1]).toMatchObject({ title: "vs Team B", typeLabel: "League", divisionId: "division-a", resultLabel: "8 – 4" });
  });

  it("uses the signed-in player's team perspective for away matches", () => {
    const [item] = buildRecentActivity([
      { team: { id: "team-away", name: "Away Team" }, myCompleted: [
        { id: "match-2", team_home_id: "team-home", team_away_id: "team-away", team_home_points: 2, team_away_points: 7, team_home_name: "Home Team", team_away_name: "Away Team", confirmed_at: "2026-10-01T20:00:00Z" },
      ] },
    ], []);
    expect(item).toMatchObject({ title: "vs Home Team", resultLabel: "7 – 2" });
  });

  it("marks Practice activity with its play type", () => {
    const [item] = buildRecentActivity([], [
      { id: "practice-3", opponent_name: "Alex", played_at: "2026-10-04T20:00:00Z", winner: "opponent" },
    ]);
    expect(item).toMatchObject({ type: "practice", typeLabel: "Practice", title: "Practice vs Alex" });
  });

  it("includes completed Skills & Drills sessions without an opponent name", () => {
    const [item] = buildRecentActivity([], [
      { id: "practice-2", practice_type: "skills_drills", played_at: "2026-10-01T20:00:00Z", winner: null },
    ]);
    expect(item).toMatchObject({ title: "Skills & Drills", resultLabel: "Completed" });
  });
});
