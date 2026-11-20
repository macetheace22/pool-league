import { buildIbaScheduleSnapshotState } from "../src/db.js";

describe("IBA schedule import history", () => {
  it("normalizes imported team-number pairings into stable team ids", () => {
    const state = buildIbaScheduleSnapshotState(
      [{
        week: 6,
        date: "11/18/2026",
        special: null,
        pairings: [
          { homeTeamNum: "76A01", awayTeamNum: "76B02" },
          { homeTeamNum: "76C03", awayTbdCode: "TBA" },
        ],
      }],
      [
        { id: "home-id", teamNum: "76A01" },
        { id: "away-id", teamNum: "76B02" },
        { id: "bye-id", teamNum: "76C03" },
      ],
    );

    expect(state.version).toBe(1);
    expect(state.weeks[0]).toMatchObject({
      week: 6,
      date: "11/18/2026",
      isPlayoff: false,
    });
    expect(state.weeks[0].pairings).toEqual([
      { homeTeamId: "home-id", awayTeamId: "away-id", homeTbdCode: null, awayTbdCode: null },
      { homeTeamId: "bye-id", awayTeamId: null, homeTbdCode: null, awayTbdCode: "TBA" },
    ]);
  });

  it("preserves TBA/BYE placeholders without inventing team ids", () => {
    const state = buildIbaScheduleSnapshotState([{
      week: 7,
      date: "11/25/2026",
      special: "TBA",
      pairings: [{
        homeTbdCode: "TBA",
        awayTbdCode: "BYE",
      }],
    }]);

    expect(state.weeks[0].pairings[0]).toEqual({
      homeTeamId: null,
      awayTeamId: null,
      homeTbdCode: "TBA",
      awayTbdCode: "BYE",
    });
  });
});
