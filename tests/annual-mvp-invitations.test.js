import { describe, expect, it } from "vitest";
import { buildAnnualMvpTournamentInvitations } from "../src/annualMvpInvitations.js";

const division = (id, format, standings, extra = {}) => ({
  division: { id, format, name: `${format} ${id}` },
  standings,
  ...extra,
});
const player = (num, position, name = `Player ${num}`) => ({
  num: String(num), position, name, weekKey: "2026-11-20",
});

describe("Annual MVP Tournament invitations", () => {
  it("invites only the top 15 official positions from each division", () => {
    const rows = Array.from({ length: 16 }, (_, index) => player(index + 1, index + 1));
    const result = buildAnnualMvpTournamentInvitations([division("o1", "Open", rows)]);
    expect(result.invitationsByFormat.Open).toHaveLength(15);
    expect(result.invitationsByFormat.Open.map(row => row.position)).not.toContain(16);
  });

  it("assigns a player qualifying in multiple formats only to the highest format", () => {
    const result = buildAnnualMvpTournamentInvitations([
      division("o1", "Open", [player(123, 2)]),
      division("a1", "Advanced", [player(123, 7)]),
      division("m1", "Masters", [player(456, 1)]),
    ]);
    expect(result.invitationsByFormat.Open).toHaveLength(0);
    expect(result.invitationsByFormat.Advanced).toHaveLength(1);
    expect(result.invitationsByFormat.Advanced[0]).toMatchObject({ playerNum: "123", eligibleFormat: "Advanced", alsoQualifiedIn: ["Open"] });
    expect(result.invitationsByFormat.Masters).toHaveLength(1);
    expect(result.crossFormatResolutions).toHaveLength(1);
  });

  it("assigns a player qualifying in Advanced and Masters to Masters only", () => {
    const result = buildAnnualMvpTournamentInvitations([
      division("a1", "Advanced", [player(789, 1)]),
      division("m1", "Masters", [player(789, 15)]),
    ]);
    expect(result.invitationsByFormat.Advanced).toHaveLength(0);
    expect(result.invitationsByFormat.Masters).toHaveLength(1);
    expect(result.invitationsByFormat.Masters[0].alsoQualifiedIn).toEqual(["Advanced"]);
  });

  it("combines same-format qualifications into one invitation while retaining all divisions", () => {
    const result = buildAnnualMvpTournamentInvitations([
      division("o1", "Open", [player(123, 5)]),
      division("o2", "Open", [player(123, 3)]),
    ]);
    expect(result.invitationsByFormat.Open).toHaveLength(1);
    expect(result.invitationsByFormat.Open[0].position).toBe(3);
    expect(result.invitationsByFormat.Open[0].qualifyingDivisions).toHaveLength(2);
  });

  it("marks the snapshot incomplete when any division lacks valid official standings", () => {
    const result = buildAnnualMvpTournamentInvitations([
      division("o1", "Open", [player(123, 1)]),
      division("a1", "Advanced", [], { error: "Mixed report weeks." }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.divisionIssues).toEqual([expect.objectContaining({ divisionId: "a1", issue: "Mixed report weeks." })]);
  });

  it("holds unlinked identities for manager review instead of guessing across formats", () => {
    const result = buildAnnualMvpTournamentInvitations([
      division("o1", "Open", [{ ...player(0, 1), num: "manual:Player 0" }]),
    ]);
    expect(result.invitationsByFormat.Open).toHaveLength(0);
    expect(result.identityReview).toHaveLength(1);
    expect(result.complete).toBe(false);
  });
});
