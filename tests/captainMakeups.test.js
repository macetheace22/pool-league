import { describe, expect, it } from "vitest";
import { listCaptainPendingMakeups } from "../src/captainMakeups.js";

describe("listCaptainPendingMakeups", () => {
  const teamA = { team: { id: "a" }, myCompleted: [
    { id: "a-pending", is_makeup_pending: true, created_at: "2026-11-10T12:00:00Z" },
    { id: "a-done", is_makeup_pending: false, created_at: "2026-11-11T12:00:00Z" },
  ] };
  const teamB = { team: { id: "b" }, myCompleted: [
    { id: "b-pending", is_makeup_pending: true, created_at: "2026-11-12T12:00:00Z" },
  ] };
  const teamC = { team: { id: "c" }, myCompleted: [
    { id: "c-pending", is_makeup_pending: true, created_at: "2026-11-13T12:00:00Z" },
  ] };

  it("aggregates pending matches across all teams the profile captains", () => {
    expect(listCaptainPendingMakeups([teamA, teamB, teamC], ["a", "b"]).map(x => x.match.id))
      .toEqual(["b-pending", "a-pending"]);
  });

  it("does not require the captain to be a player on the team overview", () => {
    expect(listCaptainPendingMakeups([teamC], ["c"]).map(x => x.match.id))
      .toEqual(["c-pending"]);
  });

  it("excludes completed matches and teams the profile does not captain", () => {
    expect(listCaptainPendingMakeups([teamA, teamB], ["a"]).map(x => x.match.id))
      .toEqual(["a-pending"]);
  });
});


describe("liveSetDisposition", () => {
  it("distinguishes forfeits, pending makeups, unplayed, and in-progress sets", async () => {
    const { liveSetDisposition } = await import("../src/liveSetDisposition.js");
    expect(liveSetDisposition({ forfeited: true, forfeitPoints: 125 }, true)).toBe("FORFEIT · 125pt");
    expect(liveSetDisposition({ complete: false, racks: [] }, true)).toBe("AWAITING MAKEUP");
    expect(liveSetDisposition({ complete: false, racks: [] }, false)).toBe("UNPLAYED");
    expect(liveSetDisposition({ complete: false, racks: [{ home: 10, away: 5 }] }, false)).toBe("IN PROGRESS");
    expect(liveSetDisposition({ complete: true, racks: [{ home: 50, away: 20 }] }, false)).toBeNull();
  });
});
