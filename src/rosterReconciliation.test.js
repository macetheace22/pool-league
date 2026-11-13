import { describe, expect, it } from "vitest";
import { buildRosterSyncPlan } from "./rosterReconciliation";

const teams = [
  { id: "team-a", team_num: "76001", division_id: "div-1", divisions: { num: 151 } },
  { id: "team-b", team_num: "76002", division_id: "div-1", divisions: { num: 151 } },
  { id: "team-c", team_num: "76003", division_id: "div-2", divisions: { num: 152 } },
];

const parsed = {
  rosters: {
    "76001": ["10001", "10002"],
    "76002": ["10003"],
    "76003": [],
  },
  ambiguousRoster: [],
};

describe("official IBA roster reconciliation planning", () => {
  it("includes every team, including an explicitly empty roster", () => {
    const result = buildRosterSyncPlan({
      parsed,
      matchedTeams: teams,
      allDivisionTeams: teams,
    });

    expect(result.completeDivisions).toEqual([
      { divisionId: "div-1", teamCount: 2 },
      { divisionId: "div-2", teamCount: 1 },
    ]);
    expect(result.rosterPayload).toEqual([
      { team_id: "team-a", player_nums: ["10001", "10002"] },
      { team_id: "team-b", player_nums: ["10003"] },
      { team_id: "team-c", player_nums: [] },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("does not reconcile a division when any configured team is missing", () => {
    const incomplete = { ...parsed, rosters: { ...parsed.rosters } };
    delete incomplete.rosters["76002"];
    const result = buildRosterSyncPlan({
      parsed: incomplete,
      matchedTeams: teams,
      allDivisionTeams: teams,
    });

    expect(result.completeDivisions).toEqual([{ divisionId: "div-2", teamCount: 1 }]);
    expect(result.rosterPayload.map(row => row.team_id)).toEqual(["team-c"]);
    expect(result.skippedDivisions).toEqual([
      expect.objectContaining({ divisionId: "div-1", reason: expect.stringMatching(/every team/i) }),
    ]);
  });

  it("does not reconcile a division with an ambiguous team number", () => {
    const result = buildRosterSyncPlan({
      parsed,
      matchedTeams: teams,
      allDivisionTeams: teams,
      ambiguousTeamNums: ["76002"],
    });

    expect(result.completeDivisions.map(row => row.divisionId)).toEqual(["div-2"]);
    expect(result.rosterPayload.map(row => row.team_id)).toEqual(["team-c"]);
  });

  it("does not reconcile a division with an ambiguous player placement", () => {
    const result = buildRosterSyncPlan({
      parsed: {
        ...parsed,
        ambiguousRoster: [{ num: "10003", guessedTeamId: "76001", candidateTeamIds: ["76001", "76002"] }],
      },
      matchedTeams: teams,
      allDivisionTeams: teams,
    });

    expect(result.completeDivisions.map(row => row.divisionId)).toEqual(["div-2"]);
    expect(result.skippedDivisions[0].reason).toMatch(/ambiguous team placement/i);
  });

  it("does not reconcile any division while a report team is unmatched", () => {
    const result = buildRosterSyncPlan({
      parsed,
      matchedTeams: teams,
      allDivisionTeams: teams,
      unmatchedTeamNums: ["76999"],
    });

    expect(result.rosterPayload).toEqual([]);
    expect(result.completeDivisions).toEqual([]);
    expect(result.warnings[0]).toMatch(/resolve the team mapping/i);
  });

  it("does not reconcile a division when a player appears on multiple teams", () => {
    const duplicate = {
      ...parsed,
      rosters: { ...parsed.rosters, "76002": ["10001", "10003"] },
    };
    const result = buildRosterSyncPlan({
      parsed: duplicate,
      matchedTeams: teams,
      allDivisionTeams: teams,
    });

    expect(result.completeDivisions.map(row => row.divisionId)).toEqual(["div-2"]);
    expect(result.skippedDivisions[0].reason).toMatch(/more than one team/i);
  });

  it("allows the same player to remain on teams in different divisions", () => {
    const crossDivision = {
      rosters: { ...parsed.rosters, "76003": ["10001"] },
      ambiguousRoster: [],
    };
    const result = buildRosterSyncPlan({
      parsed: crossDivision,
      matchedTeams: teams,
      allDivisionTeams: teams,
    });

    expect(result.completeDivisions.map(row => row.divisionId)).toEqual(["div-1", "div-2"]);
    expect(result.rosterPayload).toContainEqual({ team_id: "team-a", player_nums: ["10001", "10002"] });
    expect(result.rosterPayload).toContainEqual({ team_id: "team-c", player_nums: ["10001"] });
  });

});


it("does not require schedule BYE placeholders in the official roster PDF", () => {
  const bye = { id: "bye", team_num: "BYE", division_id: "div-1", is_bye: true };
  const result = buildRosterSyncPlan({
    parsed,
    matchedTeams: teams,
    allDivisionTeams: [...teams, bye],
  });
  expect(result.completeDivisions).toContainEqual({ divisionId: "div-1", teamCount: 2 });
  expect(result.rosterPayload.some(row => row.team_id === "bye")).toBe(false);
});
