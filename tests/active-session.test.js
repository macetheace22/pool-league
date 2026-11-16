import { describe, expect, it } from "vitest";
import { isResumablePracticeSession } from "../src/activeSessionUtils.js";

describe("practice session resume lifecycle", () => {
  it.each(["type", "opponent", "gametype", "tablesize", "scoring", "config", undefined])(
    "does not resume an unfinished %s setup",
    (phase) => {
      expect(isResumablePracticeSession({ type: "practice", data: { phase } })).toBe(false);
    }
  );

  it("does not resume a legacy Skills & Drills session created by setup Continue", () => {
    expect(isResumablePracticeSession({ type: "practice", data: { phase: "skillsplay" } })).toBe(false);
  });

  it("resumes Skills & Drills only after the explicit Start Playing action", () => {
    expect(isResumablePracticeSession({
      type: "practice", data: { phase: "skillsplay", startedByUser: true },
    })).toBe(true);
  });

  it.each(["play", "done"])("continues an opponent practice session in the %s phase", (phase) => {
    expect(isResumablePracticeSession({ type: "practice", data: { phase } })).toBe(true);
  });

  it("does not treat a live match as a practice session", () => {
    expect(isResumablePracticeSession({ type: "live", data: { phase: "play" } })).toBe(false);
  });
});
