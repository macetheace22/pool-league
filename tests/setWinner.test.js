import { describe, expect, it } from "vitest";
import { detectSetWinner, effectiveSetTarget } from "../src/setWinner.js";

const home = { rating: 50 };
const away = { rating: 45 };

describe("detectSetWinner — Rule 6.7", () => {
  it("awards the set to the winner of the game in which both ratings are reached", () => {
    expect(detectSetWinner([
      { home: 50, away: 45 },
    ], home, away, "advanced")).toBe("home");
    expect(detectSetWinner([
      { home: 50, away: 45 },
    ], away, home, "advanced")).toBe("home");
  });

  it("uses the last game's winner, not the cumulative point differential", () => {
    expect(detectSetWinner([
      { home: 20, away: 10 },
      { home: 30, away: 35 },
    ], home, away, "advanced")).toBe("away");
  });

  it("awards the set to the only player who reaches their target", () => {
    expect(detectSetWinner([
      { home: 50, away: 30 },
    ], home, away, "advanced")).toBe("home");
  });

  it("continues accumulating games until a target is reached", () => {
    expect(detectSetWinner([
      { home: 25, away: 20 },
      { home: 25, away: 25 },
    ], home, away, "advanced")).toBe("away");
  });

  it("uses the fixed format target when either player is unrated", () => {
    expect(effectiveSetTarget({ rating: 1 }, { rating: 70 }, "open")).toBe(45);
    expect(effectiveSetTarget({ rating: 1 }, { rating: 70 }, "advanced")).toBe(50);
    expect(detectSetWinner([
      { home: 45, away: 45 },
    ], { rating: 1 }, { rating: 70 }, "open")).toBe("home");
  });

  it("does not infer a winner when a player's rating is missing", () => {
    expect(detectSetWinner([{ home: 50, away: 30 }], { rating: null }, away, "advanced")).toBeNull();
  });
});
