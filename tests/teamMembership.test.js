import { describe, expect, it } from "vitest";
import { getActiveTeamIds, hasActiveTeamMembership, getCaptainTeamIds, isCaptainOfTeam, getCaptainMatchSlot } from "../src/teamMembership";

describe("team membership context", () => {
  it("returns active memberships only", () => {
    const profile = {
      team_memberships: [
        { team_id: "team-old", joined_at: "2026-01-01", ended_at: "2026-06-01" },
        { team_id: "team-current", joined_at: "2026-06-02", ended_at: null },
      ],
    };
    expect(getActiveTeamIds(profile)).toEqual(["team-current"]);
  });

  it("preserves chronological membership order", () => {
    const profile = {
      team_memberships: [
        { team_id: "team-b", joined_at: "2026-08-02", ended_at: null },
        { team_id: "team-a", joined_at: "2026-08-01", ended_at: null },
      ],
    };
    expect(getActiveTeamIds(profile)).toEqual(["team-a", "team-b"]);
  });

  it("deduplicates duplicate active rows", () => {
    const profile = {
      team_memberships: [
        { team_id: "team-a", joined_at: "2026-08-01", ended_at: null },
        { team_id: "team-a", joined_at: "2026-08-02", ended_at: null },
      ],
    };
    expect(getActiveTeamIds(profile)).toEqual(["team-a"]);
  });

  it("ignores null, missing, and ended membership records", () => {
    expect(getActiveTeamIds({
      team_memberships: [
        null,
        { team_id: null, ended_at: null },
        { team_id: "team-old", ended_at: "2026-01-01" },
      ],
    })).toEqual([]);
  });

  it("handles profiles with no membership collection", () => {
    expect(getActiveTeamIds({})).toEqual([]);
    expect(getActiveTeamIds(null)).toEqual([]);
  });

  it("checks membership without treating historical membership as current", () => {
    const profile = {
      team_memberships: [
        { team_id: "team-old", ended_at: "2026-06-01" },
        { team_id: "team-current", ended_at: null },
      ],
    };
    expect(hasActiveTeamMembership(profile, "team-current")).toBe(true);
    expect(hasActiveTeamMembership(profile, "team-old")).toBe(false);
  });

  it("does not mutate the membership array", () => {
    const memberships = [
      { team_id: "team-b", joined_at: "2026-08-02", ended_at: null },
      { team_id: "team-a", joined_at: "2026-08-01", ended_at: null },
    ];
    const original = [...memberships];
    getActiveTeamIds({ team_memberships: memberships });
    expect(memberships).toEqual(original);
  });

  it("uses a stable first team for single-team UI context", () => {
    const profile = {
      team_memberships: [
        { team_id: "team-b", joined_at: "2026-09-02", ended_at: null },
        { team_id: "team-a", joined_at: "2026-09-01", ended_at: null },
      ],
    };
    expect(getActiveTeamIds(profile)[0]).toBe("team-a");
  });
});


describe("team-specific captain context", () => {
  it("keeps captain assignments separate from all active player memberships", () => {
    const profile = {
      role: "captain",
      team_memberships: [
        { team_id: "team-a", ended_at: null },
        { team_id: "team-b", ended_at: null },
        { team_id: "team-c", ended_at: null },
      ],
      captain_team_ids: ["team-b"],
    };
    expect(getActiveTeamIds(profile)).toEqual(["team-a", "team-b", "team-c"]);
    expect(getCaptainTeamIds(profile)).toEqual(["team-b"]);
    expect(isCaptainOfTeam(profile, "team-a")).toBe(false);
    expect(isCaptainOfTeam(profile, "team-b")).toBe(true);
    expect(isCaptainOfTeam(profile, "team-c")).toBe(false);
  });

  it("supports a player who captains more than one team", () => {
    const profile = {
      role: "captain",
      team_memberships: [
        { team_id: "team-a", ended_at: null },
        { team_id: "team-b", ended_at: null },
        { team_id: "team-c", ended_at: null },
      ],
      captain_team_ids: ["team-b", "team-c", "team-b"],
    };
    expect(getActiveTeamIds(profile)).toEqual(["team-a", "team-b", "team-c"]);
    expect(getCaptainTeamIds(profile)).toEqual(["team-b", "team-c"]);
    expect(isCaptainOfTeam(profile, "team-a")).toBe(false);
    expect(isCaptainOfTeam(profile, "team-b")).toBe(true);
    expect(isCaptainOfTeam(profile, "team-c")).toBe(true);
  });

  it("does not infer captain access from a global captain role", () => {
    expect(isCaptainOfTeam({ role: "captain", team_memberships: [{team_id:"team-a"}] }, "team-a")).toBe(false);
  });

  it("does not treat historical captain IDs as current when no assignment is present", () => {
    expect(getCaptainTeamIds({ role: "player", captain_team_ids: [] })).toEqual([]);
    expect(isCaptainOfTeam({ role: "player", captain_team_ids: [] }, "team-a")).toBe(false);
  });
});


describe("captain match permissions", () => {
  const profile = {
    role: "captain",
    team_memberships: [
      { team_id: "team-a", ended_at: null },
      { team_id: "team-b", ended_at: null },
    ],
    captain_team_ids: ["team-b"],
  };
  it("does not grant captain match actions for a team where the user is only a player", () => {
    expect(getCaptainMatchSlot(profile, { team_home_id: "team-a", team_away_id: "team-c" })).toBeNull();
  });
  it("recognizes captain assignment on the home or away side", () => {
    expect(getCaptainMatchSlot(profile, { team_home_id: "team-b", team_away_id: "team-c" })).toBe("home");
    expect(getCaptainMatchSlot(profile, { team_home_id: "team-c", team_away_id: "team-b" })).toBe("away");
  });
  it("does not grant match actions for unrelated teams", () => {
    expect(getCaptainMatchSlot(profile, { team_home_id: "team-c", team_away_id: "team-d" })).toBeNull();
  });
});


describe("manager with team-specific captain assignments", () => {
  it("retains manager authority while exposing only explicitly assigned captain teams", () => {
    const profile = {
      role: "manager",
      team_memberships: [
        { team_id: "team-player", ended_at: null },
        { team_id: "team-captain", ended_at: null },
      ],
      captain_team_ids: ["team-captain"],
    };
    expect(getActiveTeamIds(profile)).toEqual(["team-player", "team-captain"]);
    expect(getCaptainTeamIds(profile)).toEqual(["team-captain"]);
    expect(isCaptainOfTeam(profile, "team-player")).toBe(false);
    expect(isCaptainOfTeam(profile, "team-captain")).toBe(true);
    // Manager-level access is determined by profile.role, not captainTeamIds.
    expect(profile.role).toBe("manager");
  });
});
