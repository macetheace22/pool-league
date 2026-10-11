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

  it("parses the current rate-first IBA roster layout and keeps the first division before its heading", () => {
    const raw = [
      "Team 15101 Scotty Doesn't Know",
      "Twin City Billiards",
      "Rate Num Play Win Name",
      "105 34240 4 2 Marier, Dave",
      "116 14768 2 1 Barrett, Scott",
      "73 25953 0 0 Stewart, Ryan",
      "Team 15102 Damn It",
      "Twin City Billiards",
      "134 18529 3 2 Carlson, Doug \"DamnIt\"",
      "Division Roster and Handicap Report Wed (BCA/VNEA)TCB Masters",
      "For Week: 6 Division # 151",
      "Fall Season 2026",
      "Report printed: 10/09/26",
      "Team 15201 No Bull",
      "C.R.'s Sports Bar",
      "88 13102 4 3 Johnson, Loren \"Smooth\"",
      "89 02256 4 2 Reyes, Oakley\"Natural\"",
    ].join("\n");

    const result = parseLeagueRoster(raw);
    expect(result.teams["15101"].name).toBe("Scotty Doesn't Know");
    expect(result.teams["15102"].name).toBe("Damn It");
    expect(result.teams["15201"].name).toBe("No Bull");
    expect(result.rosters["15101"]).toEqual(["34240", "14768", "25953"]);
    expect(result.registry["34240"]).toMatchObject({ name: "Marier, Dave", rating: 105 });
    expect(result.registry["14768"]).toMatchObject({ name: "Barrett, Scott", rating: 116 });
    expect(result.registry["25953"]).toMatchObject({ name: "Stewart, Ryan", rating: 73 });
    expect(result.registry["13102"]).toMatchObject({ name: "Johnson, Loren", nickname: "Smooth", rating: 88 });
    expect(result.rosters["15201"]).toEqual(["13102", "02256"]);
    expect(result.registry["02256"]).toMatchObject({ name: "Reyes, Oakley", nickname: "Natural", rating: 89 });
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
