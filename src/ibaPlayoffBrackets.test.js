import { describe, expect, it } from "vitest";
import {
  parseIbaPlayoffBrackets,
  normalizeImportedPlayoffBracket,
  compareImportedPlayoffBracket,
} from "./ibaPlayoffBrackets";

const example = [
  "IBA / M8 POOL LEAGUE",
  "Winter Season 2026",
  "#121 - Division",
  "Longhorns Burger House Hogan's Heroes",
  "1st",
  "12104",
  "Longhorns Burger House Troy's Team",
  "4th",
  "12102",
  "Championship Play-Offs",
  "Longhorns Burger House Come Get Some",
  "2nd",
  "12103",
  "Longhorns Burger House Last Chance",
  "3rd",
  "12101",
  "Longhorns Burger House Come Get Some",
  "DIVISION CHAMPIONS",
].join("\n");

describe("parseIbaPlayoffBrackets", () => {
  it("detects the published championship bracket and extracts printed seed/team pairs", () => {
    const result = parseIbaPlayoffBrackets(example);
    expect(result.detected).toBe(true);
    expect(result.divisionNum).toBe("121");
    expect(result.brackets).toHaveLength(1);
    expect(result.brackets[0]).toMatchObject({
      bracketType: "championship",
      firstRoundMatches: [
        {
          seedHome: 1,
          seedAway: 4,
          teamNumHome: "12104",
          teamNumAway: "12102",
        },
        {
          seedHome: 2,
          seedAway: 3,
          teamNumHome: "12103",
          teamNumAway: "12101",
        },
      ],
    });
  });

  it("supports a second consolation bracket in the same extracted report", () => {
    const raw = example.replace(
      "DIVISION CHAMPIONS",
      [
        "DIVISION CHAMPIONS",
        "Consolation Play-Offs",
        "Team Five",
        "5th",
        "12105",
        "Team Six",
        "6th",
        "12106",
      ].join("\n"),
    );
    const result = parseIbaPlayoffBrackets(raw);
    expect(result.brackets.map(b => b.bracketType)).toEqual(["championship", "consolation"]);
  });

  it("fails closed when a bracket has an incomplete first round", () => {
    const result = parseIbaPlayoffBrackets([
      "#121 - Division",
      "Championship Play-Offs",
      "Team One",
      "1st",
      "12101",
      "Team Two",
      "2nd",
    ].join("\n"));
    expect(result.brackets[0].parseError).toContain("complete set");
  });
});

describe("playoff bracket comparison", () => {
  const generated = {
    bracketType: "championship",
    bracketGroup: "championship",
    firstRoundMatches: [
      { slot: 1, seedHome: 1, seedAway: 4, teamNumHome: "12104", teamNumAway: "12102" },
      { slot: 2, seedHome: 2, seedAway: 3, teamNumHome: "12103", teamNumAway: "12101" },
    ],
  };

  it("matches the published example when the provisional bracket agrees", () => {
    const imported = parseIbaPlayoffBrackets(example).brackets[0];
    expect(compareImportedPlayoffBracket(imported, generated).matches).toBe(true);
  });

  it("detects a published matchup difference", () => {
    const imported = parseIbaPlayoffBrackets(example.replace("12102", "12105")).brackets[0];
    const result = compareImportedPlayoffBracket(imported, generated);
    expect(result.matches).toBe(false);
    expect(result.differences).toContainEqual({
      field: "firstRoundMatches[0].teamNumAway",
      imported: "12105",
      generated: "12102",
    });
  });

  it("normalizes team numbers as strings", () => {
    expect(normalizeImportedPlayoffBracket({
      bracketType: "championship",
      firstRoundMatches: [{ slot: 1, seedHome: 1, seedAway: 4, teamNumHome: 12104, teamNumAway: 12102 }],
    }).firstRoundMatches[0].teamNumHome).toBe("12104");
  });
});
