import { describe, expect, it } from "vitest";
import { buildSeasonalQualificationSnapshot, buildSeasonalSeedingInputs } from "../src/seasonalQualification";

const standings = [
  { teamId: "t1", position: 1 },
  { teamId: "t2", position: 2 },
  { teamId: "t3", position: 3 },
  { teamId: "t4", position: 4 },
  { teamId: "t5", position: 5 },
  { teamId: "t6", position: 6 },
];

describe("seasonal tournament qualification", () => {
  it("automatically qualifies first place and requires the Division Championship for positions 2-4", () => {
    const snapshot = buildSeasonalQualificationSnapshot(standings, [
      { bracket_type: "championship", round: "final", winner_team_id: "t3" },
    ]);
    expect(snapshot.championship.map(r => r.teamId)).toEqual(["t1", "t3"]);
    expect(snapshot.championship.find(r => r.teamId === "t1")?.reason).toBe("regular_season_first_place_automatic");
    expect(snapshot.championship.find(r => r.teamId === "t3")?.reason).toBe("division_champion");
    expect(snapshot.excluded.map(r => r.teamId)).toEqual(["t2", "t4", "t5", "t6"]);
  });

  it("qualifies only consolation bracket champions from positions 5 onward", () => {
    const snapshot = buildSeasonalQualificationSnapshot(standings, [
      { bracket_type: "consolation", round: "final", bracket_group: "A", winner_team_id: "t6" },
      { bracket_type: "consolation", round: "final", bracket_group: "B", winner_team_id: "t3" },
    ]);
    expect(snapshot.consolation.map(r => r.teamId)).toEqual(["t6"]);
    expect(snapshot.excluded.find(r => r.teamId === "t3")?.reason).toBe("did_not_win_division_championship");
  });

  it("does not guess winners when playoff finals are incomplete", () => {
    const snapshot = buildSeasonalQualificationSnapshot(standings, [
      { bracket_type: "championship", round: "final", winner_team_id: null },
      { bracket_type: "consolation", round: "final", bracket_group: "A", winner_team_id: null },
    ]);
    expect(snapshot.divisionChampionId).toBeNull();
    expect(snapshot.championship.map(r => r.teamId)).toEqual(["t1"]);
    expect(snapshot.consolation).toEqual([]);
  });

  it("preserves the three championship seeding categories", () => {
    const snapshot = buildSeasonalQualificationSnapshot(standings, [
      { bracket_type: "championship", round: "final", winner_team_id: "t3" },
    ]);
    const seeded = buildSeasonalSeedingInputs(snapshot);
    expect(seeded.championship).toEqual([
      expect.objectContaining({ teamId: "t1", seedCategory: "first_place_not_division_champion" }),
      expect.objectContaining({ teamId: "t3", seedCategory: "below_first_division_champion" }),
    ]);
  });

  it("does not qualify a fifth-place team merely because it won a championship bracket", () => {
    const snapshot = buildSeasonalQualificationSnapshot(standings, [
      { bracket_type: "championship", round: "final", winner_team_id: "t5" },
    ]);
    expect(snapshot.championship.map(r => r.teamId)).toEqual(["t1"]);
    expect(snapshot.consolation).toEqual([]);
  });
});
