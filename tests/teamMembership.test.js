import { describe, expect, it } from "vitest";
import { getActiveTeamIds, hasActiveTeamMembership } from "../src/teamMembership";

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
