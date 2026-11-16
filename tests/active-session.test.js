import { describe, expect, it } from "vitest";
import { isResumablePracticeSession } from "../src/activeSessionUtils.js";

describe("practice session resume lifecycle", () => {
  it.each(["type", "opponent", "gametype", "tablesize", "scoring", "config", undefined])(
    "does not resume an unfinished %s setup",
    (phase) => {
      expect(isResumablePracticeSession({ type: "practice", data: { phase } })).toBe(false);
    }
  );

  it.each(["play", "skillsplay", "done"])(
    "resumes a practice session in the %s phase",
    (phase) => {
      expect(isResumablePracticeSession({ type: "practice", data: { phase } })).toBe(true);
    }
  );

  it("does not treat a live match as a practice session", () => {
    expect(isResumablePracticeSession({ type: "live", data: { phase: "play" } })).toBe(false);
  });
});
