import { describe, expect, it } from "vitest";
import { buildCompletedMatchRow, shouldAdvanceBracketOnArchive } from "../src/db.js";

const baseState = {
  schedulePairingId: "pair-123",
  seasonId: "season-2026",
  seasonLabel: "Summer 2026",
  weekNum: 4,
  weekDate: "07/15/2026",
  venue: "Pullman Club",
  format: "masters",
  teamHome: { id: "team-home", name: "Home Team" },
  teamAway: { id: "team-away", name: "Away Team" },
  sets: [{
    setNum: 1,
    complete: true,
    winnerSlot: "home",
    playerHome: { num: "1", rating: 50 },
    playerAway: { num: "2", rating: 45 },
    racks: [{ home: 50, away: 30 }],
  }],
};

describe("completed match archive transformation", () => {
  it("builds a normal live archive with full season/division/team/pairing linkage", () => {
    const row = buildCompletedMatchRow(baseState, "division-1");
    expect(row).toMatchObject({
      division_id: "division-1",
      season_id: "season-2026",
      season_label: "Summer 2026",
      week_num: 4,
      week_date: "07/15/2026",
      venue: "Pullman Club",
      format: "masters",
      team_home_id: "team-home",
      team_away_id: "team-away",
      team_home_name: "Home Team",
      team_away_name: "Away Team",
      team_home_total: 1,
      team_away_total: 0,
      team_home_points: 145,
      team_away_points: 0,
      source: "live",
      is_makeup_pending: false,
    });
    expect(row.state).toBe(baseState);
    expect(row.state.schedulePairingId).toBe("pair-123");
  });

  it("marks an untouched confirmed makeup as pending without inventing a 0-0 result", () => {
    const state = {
      ...baseState,
      makeup: { confirmedHome: true, confirmedAway: true },
      sets: baseState.sets.map(s => ({ ...s, complete: false, winnerSlot: null, racks: [] })),
    };
    const row = buildCompletedMatchRow(state, "division-1");
    expect(row.is_makeup_pending).toBe(true);
    expect(row.team_home_total).toBeNull();
    expect(row.team_away_total).toBeNull();
    expect(row.team_home_points).toBeNull();
    expect(row.team_away_points).toBeNull();
  });

  it("preserves the score already played in a partial makeup", () => {
    const state = {
      ...baseState,
      makeup: { confirmedHome: true, confirmedAway: true },
      sets: [
        ...baseState.sets,
        { setNum: 2, complete: false, winnerSlot: null, playerHome: null, playerAway: null, racks: [] },
      ],
    };
    const row = buildCompletedMatchRow(state, "division-1");
    expect(row.is_makeup_pending).toBe(true);
    expect(row.team_home_total).toBe(1);
    expect(row.team_away_total).toBe(0);
    expect(row.team_home_points).toBe(145);
    expect(row.team_away_points).toBe(0);
  });

  it("keeps the same archive transformation when resuming a makeup", () => {
    const state = { ...baseState, resumingMatchId: "completed-123", makeup: null };
    const row = buildCompletedMatchRow(state, "division-1");
    expect(state.resumingMatchId).toBe("completed-123");
    expect(row.state.resumingMatchId).toBe("completed-123");
    expect(row.source).toBe("live");
    expect(row.is_makeup_pending).toBe(false);
  });

  it("does not mutate the live state while building the archive row", () => {
    const state = {
      ...baseState,
      makeup: { confirmedHome: true, confirmedAway: true },
      sets: baseState.sets.map(s => ({ ...s, complete: false, winnerSlot: null, racks: [] })),
    };
    const snapshot = JSON.stringify(state);
    buildCompletedMatchRow(state, "division-1");
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("archive idempotency and playoff advancement decisions", () => {
  it("advances for a newly archived final match", () => {
    expect(shouldAdvanceBracketOnArchive({ outcome: "created", isPending: false })).toBe(true);
  });

  it("does not advance for a newly archived pending makeup", () => {
    expect(shouldAdvanceBracketOnArchive({ outcome: "created", isPending: true })).toBe(false);
  });

  it("advances when a resumed makeup transitions from pending to final", () => {
    expect(shouldAdvanceBracketOnArchive({ outcome: "updated", priorPending: true, isPending: false })).toBe(true);
  });

  it("does not advance when an already-final match is resubmitted", () => {
    expect(shouldAdvanceBracketOnArchive({ outcome: "updated", priorPending: false, isPending: false })).toBe(false);
  });

  it("never advances for a duplicate concurrent archive result", () => {
    expect(shouldAdvanceBracketOnArchive({ outcome: "existing", isPending: false })).toBe(false);
  });
});
