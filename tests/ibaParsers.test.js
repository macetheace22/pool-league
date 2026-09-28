import { describe, expect, it } from "vitest";
import { parseLeagueRoster, parseStandingsImport, parseMvpImport } from "../src/ibaParsers";

describe("IBA parsers", () => {
  it("keeps standings compatible with tab-delimited paste and supports PDF space extraction", () => {
    expect(parseStandingsImport("15101\tRoom 40\t10\t123\t15\t8.20")[0]).toMatchObject({ teamNum:"15101", teamName:"Room 40", totalPoints:123, setsPlayed:15 });
    expect(parseStandingsImport("15101 Room 40 10 123 15 8.20")[0]).toMatchObject({ teamNum:"15101", teamName:"Room 40", totalPoints:123, setsPlayed:15 });
  });

  it("keeps MVP compatible with tab-delimited paste and supports PDF space extraction", () => {
    expect(parseMvpImport("12345\tBilly Macy\t15101\t4\t1\t250\t1050")[0]).toMatchObject({ playerNum:"12345", teamNum:"15101", wins:4, losses:1 });
    expect(parseMvpImport("12345 Billy Macy 15101 4 1 250 1050")[0]).toMatchObject({ playerNum:"12345", playerName:"Billy Macy", teamNum:"15101", wins:4, losses:1 });
  });

  it("parses a simple single-column roster without changing the existing output contract", () => {
    const result = parseLeagueRoster([
      "Division Roster and Handicap Report",
      "For Week: 10",
      "Team 15101 Room 40",
      "C.R.'s Sports Bar",
      "12345 0 0 Billy Macy 50",
    ].join("\n"));
    expect(result.teams["15101"].name).toBe("Room 40");
    expect(result.rosters["15101"]).toEqual(["12345"]);
    expect(result.registry["12345"]).toMatchObject({ name:"Billy Macy", rating:50 });
  });
});
