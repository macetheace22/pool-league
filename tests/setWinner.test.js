import { describe, expect, it } from "vitest";
import { detectSetWinner, effectiveSetTarget } from "../src/setWinner.js";

const home = { rating: 50 };
const away = { rating: 45 };

describe("detectSetWinner — Rule 6.7", () => {
  it("awards the set to the winner of the game in which both ratings are reached", () => {
    expect(detectSetWinner([{ home: 58, away: 45 }], home, away, "advanced")).toBe("home");
    expect(detectSetWinner([{ home: 50, away: 53 }], home, away, "advanced")).toBe("away");
  });

  it("uses the final game's winner, not the cumulative point differential", () => {
    expect(detectSetWinner([
      { home: 60, away: 10 },
      { home: 5, away: 53 },
    ], home, away, "advanced")).toBe("away");
  });

  it("awards the set to the only player who reaches their target", () => {
    expect(detectSetWinner([{ home: 58, away: 30 }], home, away, "advanced")).toBe("home");
  });

  it("continues accumulating games until a target is reached", () => {
    expect(detectSetWinner([
      { home: 25, away: 20 },
      { home: 25, away: 53 },
    ], home, away, "advanced")).toBe("away");
  });

  it("uses the fixed format target when either player is unrated", () => {
    expect(effectiveSetTarget({ rating: 1 }, { rating: 70 }, "open")).toBe(45);
    expect(effectiveSetTarget({ rating: 1 }, { rating: 70 }, "advanced")).toBe(50);
    expect(detectSetWinner([{ home: 53, away: 45 }], { rating: 1 }, { rating: 70 }, "open")).toBe("home");
  });

  it("does not infer a winner from tied game scores or missing ratings", () => {
    expect(detectSetWinner([{ home: 50, away: 50 }], home, away, "advanced")).toBeNull();
    expect(detectSetWinner([{ home: 50, away: 30 }], { rating: null }, away, "advanced")).toBeNull();
  });
});
