import { describe, expect, it } from "vitest";
import { toPlayerMatchPerspective } from "../src/leagueMatchPerspective";

describe("player-relative league match history", () => {
  it("leaves home-player and neutral administrative views unchanged", () => {
    const home = { playerSide: "home", team_home_name: "Home", team_away_name: "Away" };
    const neutral = { team_home_name: "Home", team_away_name: "Away" };
    expect(toPlayerMatchPerspective(home)).toBe(home);
    expect(toPlayerMatchPerspective(neutral)).toBe(neutral);
  });

  it("reverses an away player's match summary and team identity", () => {
    const source = {
      playerSide: "away",
      team_home_id: "home-id",
      team_away_id: "away-id",
      team_home_name: "Home Team",
      team_away_name: "Away Team",
      team_home_total: 420,
      team_away_total: 510,
      team_home_points: 4,
      team_away_points: 5,
    };
    expect(toPlayerMatchPerspective(source)).toMatchObject({
      playerSide: "home",
      team_home_id: "away-id",
      team_away_id: "home-id",
      team_home_name: "Away Team",
      team_away_name: "Home Team",
      team_home_total: 510,
      team_away_total: 420,
      team_home_points: 5,
      team_away_points: 4,
    });
    expect(source.team_home_name).toBe("Home Team");
    expect(source.team_home_total).toBe(420);
  });

  it("reverses the full scoresheet including rack values, player sides, winners, and forfeits", () => {
    const source = {
      playerSide: "away",
      state: {
        teamHome: { id: "home-id", teamNum: "101" },
        teamAway: { id: "away-id", teamNum: "202" },
        makeup: { shortTeam: "away", reason: "Short roster" },
        sets: [{
          playerHome: { num: "1", name: "Home Player", team: "home" },
          playerAway: { num: "2", name: "Away Player", team: "away" },
          winnerSlot: "away",
          forfeitedBy: "home",
          racks: [{ home: 3, away: 5, timeoutHomeCount: 1, timeoutAwayCount: 2, safetyHome: 1, safetyAway: 4 }],
        }],
      },
    };

    const viewed = toPlayerMatchPerspective(source);
    expect(viewed.playerSide).toBe("home");
    expect(viewed.state.teamHome).toEqual({ id: "away-id", teamNum: "202" });
    expect(viewed.state.teamAway).toEqual({ id: "home-id", teamNum: "101" });
    expect(viewed.state.makeup.shortTeam).toBe("home");
    expect(viewed.state.sets[0]).toMatchObject({
      playerHome: { num: "2", name: "Away Player", team: "home" },
      playerAway: { num: "1", name: "Home Player", team: "away" },
      winnerSlot: "home",
      forfeitedBy: "away",
      racks: [{ home: 5, away: 3, timeoutHomeCount: 2, timeoutAwayCount: 1, safetyHome: 4, safetyAway: 1 }],
    });
    expect(source.state.sets[0].winnerSlot).toBe("away");
    expect(source.state.sets[0].racks[0].home).toBe(3);
  });

  it("preserves the match if the selected player side is unavailable", () => {
    const source = { team_home_name: "Home", team_away_name: "Away" };
    expect(toPlayerMatchPerspective(source)).toBe(source);
  });
});
