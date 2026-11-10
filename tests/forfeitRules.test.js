import { describe, expect, it } from "vitest";
import { teamForfeitMilestone, nextTeamForfeitMilestone, teamForfeitSetsDue } from "../src/forfeitRules.js";

const start = "2026-11-10T18:00:00-06:00";
const at = (minutes) => Date.parse(start) + minutes * 60_000;

describe("Rule 6.5 team-match forfeit timing", () => {
  it.each([[0,0],[14.99,0],[15,1],[29.99,1],[30,2],[44.99,2],[45,5],[90,5]])(
    "returns %s minute milestone as %s forfeited sets", (minutes, expected) => {
      expect(teamForfeitSetsDue(start, at(minutes))).toBe(expected);
    }
  );
  it("does not invent timing when the scheduled start is missing", () => {
    expect(teamForfeitMilestone(null, at(60))).toBeNull();
    expect(nextTeamForfeitMilestone(null, at(60))).toBeNull();
  });
  it("shows the next deadline before the first milestone", () => {
    expect(nextTeamForfeitMilestone(start, at(10))).toEqual({ minutes: 15, sets: 1 });
  });
  it("shows no next deadline after all five sets are due", () => {
    expect(nextTeamForfeitMilestone(start, at(45))).toBeNull();
  });
});
