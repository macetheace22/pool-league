import { describe, expect, it } from "vitest";
import { createIbaScheduleRetrievalId, fingerprintIbaScheduleSnapshot, serializeIbaScheduleSnapshot } from "../src/ibaScheduleConfirmation";

describe("IBA schedule snapshot confirmation primitives", () => {
  const base = {
    teams: [
      { teamNum: "15101", name: "Alpha", venue: "Hall" },
      { teamNum: "15102", name: "Bravo", venue: "Club" },
    ],
    weeks: [
      { week: 2, date: "9/16/2026", pairings: [{ home: 1, away: 2 }] },
      { week: 1, date: "9/9/2026", pairings: [{ home: 2, away: null, awayTbdCode: "15103" }] },
    ],
  };

  it("produces stable serialization when week rows arrive in a different order", () => {
    expect(serializeIbaScheduleSnapshot(base)).toBe(
      serializeIbaScheduleSnapshot({ ...base, weeks: [...base.weeks].reverse() }),
    );
  });

  it("ignores matchup row ordering while retaining home/away orientation", () => {
    const pairings = [{ home: 1, away: 2 }, { home: 2, away: null, awayTbdCode: "15103" }];
    const ordered = {
      ...base,
      weeks: [{ ...base.weeks[0], pairings }, base.weeks[1]],
    };
    const reversed = {
      ...base,
      weeks: [{ ...base.weeks[0], pairings: [...pairings].reverse() }, base.weeks[1]],
    };
    expect(serializeIbaScheduleSnapshot(ordered)).toBe(serializeIbaScheduleSnapshot(reversed));
    expect(fingerprintIbaScheduleSnapshot(base)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves team order because IBA matchup values are positional", () => {
    expect(serializeIbaScheduleSnapshot(base)).not.toBe(
      serializeIbaScheduleSnapshot({ ...base, teams: [...base.teams].reverse() }),
    );
  });

  it("changes when a matchup, date, TBD code, or team detail changes", () => {
    const original = serializeIbaScheduleSnapshot(base);
    expect(serializeIbaScheduleSnapshot({
      ...base,
      weeks: [{ ...base.weeks[0], pairings: [{ home: 1, away: 1 }] }, base.weeks[1]],
    })).not.toBe(original);
    expect(serializeIbaScheduleSnapshot({
      ...base,
      teams: [{ ...base.teams[0], venue: "New Hall" }, base.teams[1]],
    })).not.toBe(original);
  });

  it("creates a distinct retrieval identifier for each check", () => {
    const first = createIbaScheduleRetrievalId();
    const second = createIbaScheduleRetrievalId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).not.toBe(first);
  });

  it("rejects a missing snapshot", () => {
    expect(() => serializeIbaScheduleSnapshot(null)).toThrow(/required/i);
  });
});
