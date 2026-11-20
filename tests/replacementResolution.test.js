import { describe, expect, it } from "vitest";
import {
  REPLACEMENT_MAKEUP_LIMIT,
  normalizeReplacementPreview,
  validateReplacementResolution,
} from "../src/replacementResolution";

describe("replacement team resolution", () => {
  it("normalizes the manager preview", () => {
    expect(normalizeReplacementPreview({
      dropoutTeamId: "drop",
      dropoutTeamName: "Dropout",
      replacementTeamId: "replace",
      replacementTeamName: "Replacement",
      eligibleMakeupWeekCount: "3",
      eligibleMakeupWeekIds: ["w1", "w2", "w3"],
    })).toMatchObject({
      dropoutTeamId: "drop",
      replacementTeamId: "replace",
      eligibleMakeupWeekCount: 3,
      eligibleMakeupWeekIds: ["w1", "w2", "w3"],
    });
  });

  it("requires the linked dropout resolution and structured inherited standings", () => {
    expect(validateReplacementResolution({
      dropoutResolutionId: "",
      seasonId: "s",
      divisionId: "d",
      replacementTeamId: "r",
      effectiveDate: "2026-11-19",
      preview: { dropoutTeamId: "drop", eligibleMakeupWeekIds: [] },
      inheritedStandings: {},
    })).toBe("Dropout resolution, season, division, and replacement team are required.");

    expect(validateReplacementResolution({
      dropoutResolutionId: "dr",
      seasonId: "s",
      divisionId: "d",
      replacementTeamId: "r",
      effectiveDate: "2026-11-19",
      preview: { dropoutTeamId: "drop", eligibleMakeupWeekIds: [] },
      inheritedStandings: [],
    })).toBe("Inherited standings must be recorded as a structured snapshot.");
  });

  it("accepts a structured official IBA standings snapshot", () => {
    expect(validateReplacementResolution({
      dropoutResolutionId: "dr",
      seasonId: "s",
      divisionId: "d",
      replacementTeamId: "r",
      effectiveDate: "2026-11-19",
      preview: { dropoutTeamId: "drop", eligibleMakeupWeekIds: [] },
      inheritedStandings: {
        totalPoints: 125,
        position: 4,
        weekKey: "week-17",
        source: "official_iba",
      },
    })).toBe("");

  it("enforces the three-makeup maximum", () => {
    expect(validateReplacementResolution({
      dropoutResolutionId: "dr",
      seasonId: "s",
      divisionId: "d",
      replacementTeamId: "r",
      effectiveDate: "2026-11-19",
      preview: { dropoutTeamId: "drop", eligibleMakeupWeekIds: ["1", "2", "3", "4"] },
      inheritedStandings: { totalPoints: 125 },
    })).toBe("No more than three makeup weeks may be recorded.");
  });
});
