import { describe, expect, it } from "vitest";
import {
  makeupCutoffFromFinalRegularSeasonDate,
  isMakeupWithinProhibitedWindow,
  validateDeadlineResolution,
} from "../src/makeupDeadlineRules";

describe("Section 8.5 makeup deadline rules", () => {
  it("calculates seven days before the final regular-season date", () => {
    const cutoff = makeupCutoffFromFinalRegularSeasonDate("10/25/2026");
    expect(cutoff.toISOString().slice(0, 10)).toBe("2026-10-18");
  });

  it("treats the cutoff date itself as allowable", () => {
    const cutoff = makeupCutoffFromFinalRegularSeasonDate("10/25/2026");
    expect(isMakeupWithinProhibitedWindow("10/25/2026", new Date("2026-10-18T23:59:00"))).toBe(false);
    expect(isMakeupWithinProhibitedWindow("10/25/2026", new Date(cutoff.getTime() + 1000))).toBe(true);
  });

  it("accepts no-agreement without assigning responsibility", () => {
    expect(validateDeadlineResolution("no_agreement")).toEqual({ ok: true, responsibleSide: null });
  });

  it("requires League Management to name the responsible side", () => {
    expect(validateDeadlineResolution("team_responsible")).toEqual({ ok: false, reason: "INVALID_RESOLUTION" });
    expect(validateDeadlineResolution("team_responsible", "home")).toEqual({ ok: true, responsibleSide: "home" });
    expect(validateDeadlineResolution("team_responsible", "away")).toEqual({ ok: true, responsibleSide: "away" });
  });
});
