import { describe, expect, it } from "vitest";
import {
  hasLaterCompletedSet,
  makeupDeadlineFromPlayoffsStart,
  isMakeupDeadlinePassed,
} from "../src/forfeitRules";

describe("forfeit lifecycle rules", () => {
  it("requires a forfeited set to be the last set once later play exists", () => {
    const sets = [
      { complete: true },
      { complete: true, forfeited: true },
      { complete: true },
      { complete: false },
      { complete: false },
    ];
    expect(hasLaterCompletedSet(sets, 1)).toBe(true);
    expect(hasLaterCompletedSet(sets, 2)).toBe(false);
  });

  it("calculates the makeup deadline from the final regular-season week", () => {
    const deadline = makeupDeadlineFromPlayoffsStart("2026-06-19");
    expect(deadline.toISOString().slice(0, 10)).toBe("2026-06-05");
  });

  it("does not mark the deadline passed on the cutoff date itself", () => {
    expect(isMakeupDeadlinePassed("2026-06-19", new Date("2026-06-05T23:59:59"))).toBe(false);
    expect(isMakeupDeadlinePassed("2026-06-19", new Date("2026-06-06T00:00:00"))).toBe(true);
  });
});
