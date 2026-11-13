import { describe, expect, it } from "vitest";
import { isTimeoutEligibleFormat, timeoutAllowance, timeoutCount, timeoutRemaining } from "../src/timeoutRules";

describe("Section 2.7 timeout allowances", () => {
  it("applies Open allowance by rating", () => {
    expect(timeoutAllowance("open", 30)).toBe(2);
    expect(timeoutAllowance("open", 50)).toBe(2);
    expect(timeoutAllowance("open", 51)).toBe(1);
    expect(timeoutAllowance("open", 150)).toBe(1);
  });

  it("gives Advanced one period and Masters none", () => {
    expect(timeoutAllowance("advanced", 40)).toBe(1);
    expect(timeoutAllowance("advanced", 150)).toBe(1);
    expect(timeoutAllowance("masters", 50)).toBe(0);
    expect(timeoutAllowance("masters", 150)).toBe(0);
    expect(isTimeoutEligibleFormat("masters")).toBe(false);
  });

  it("uses the lowest tier for NR", () => {
    expect(timeoutAllowance("open", 0)).toBe(2);
    expect(timeoutAllowance("advanced", 0)).toBe(1);
  });

  it("counts coaching time-outs per player within the current set", () => {
    const set = {
      racks: [
        { timeoutHome: true, timeoutAway: false },
        { timeoutHome: false, timeoutAway: true },
        { timeoutHome: true, timeoutAway: true },
      ],
    };
    expect(timeoutCount(set, "home")).toBe(2);
    expect(timeoutCount(set, "away")).toBe(2);
    expect(timeoutRemaining({ ...set, playerHome: { rating: 50 }, playerAway: { rating: 51 } }, "home", "open")).toBe(0);
    expect(timeoutRemaining({ ...set, playerHome: { rating: 50 }, playerAway: { rating: 51 } }, "away", "open")).toBe(0);
  });
});
