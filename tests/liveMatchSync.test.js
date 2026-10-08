import { describe, expect, it } from "vitest";
import { liveRevision, mergeLiveMatchState } from "../src/liveMatchSync";

describe("live match synchronization", () => {
  it("defaults missing revisions to zero", () => {
    expect(liveRevision({})).toBe(0);
    expect(liveRevision({ _revision: 3 })).toBe(3);
    expect(liveRevision({ _revision: -1 })).toBe(0);
  });

  it("preserves a remote-only change", () => {
    const base = { phase: "live", confirmedHome: false };
    const local = { ...base, confirmedHome: true };
    const remote = { ...base, confirmedAway: true };
    expect(mergeLiveMatchState(base, local, remote)).toEqual({
      phase: "live", confirmedHome: true, confirmedAway: true, _revision: 0,
    });
  });

  it("preserves independent rack appends from both scorers", () => {
    const base = { sets: [{ racks: [{ home: 5, away: 0 }] }] };
    const local = { sets: [{ racks: [{ home: 5, away: 0 }, { home: 4, away: 1 }] }] };
    const remote = { sets: [{ racks: [{ home: 5, away: 0 }, { home: 2, away: 3 }] }] };
    expect(mergeLiveMatchState(base, local, remote).sets[0].racks).toHaveLength(3);
  });

  it("uses the local value when both sides edited the same scalar", () => {
    const base = { phase: "live" };
    const local = { phase: "confirm" };
    const remote = { phase: "archived" };
    expect(mergeLiveMatchState(base, local, remote).phase).toBe("confirm");
  });

  it("uses the latest remote revision after a merge", () => {
    expect(mergeLiveMatchState({x:1}, {x:2}, {_revision: 7, x:3})._revision).toBe(7);
  });
});
