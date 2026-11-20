import { describe, expect, it } from "vitest";
import { normalizeDropoutPreview, validateDropoutResolution } from "../src/dropoutResolution";

describe("dropout resolution", () => {
  it("normalizes preview counts and ids", () => {
    expect(normalizeDropoutPreview({ completedMatchCount: "3", futureScheduleWeekCount: 2, affectedMatchIds: ["a"] }))
      .toMatchObject({ completedMatchCount: 3, futureScheduleWeekCount: 2, affectedMatchIds: ["a"] });
  });

  it("requires a remedy", () => {
    expect(validateDropoutResolution({
      seasonId: "s", divisionId: "d", teamId: "t", effectiveDate: "2026-11-01", remedies: []
    })).toBe("Select at least one management remedy.");
  });

  it("requires a note for other", () => {
    expect(validateDropoutResolution({
      seasonId: "s", divisionId: "d", teamId: "t", effectiveDate: "2026-11-01",
      remedies: ["other"], note: ""
    })).toBe("A note is required for an Other management resolution.");
  });

  it("accepts a normal remedy", () => {
    expect(validateDropoutResolution({
      seasonId: "s", divisionId: "d", teamId: "t", effectiveDate: "2026-11-01",
      remedies: ["convert_future_byes"]
    })).toBeNull();
  });
});
