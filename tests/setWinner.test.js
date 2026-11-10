import { describe, expect, it } from "vitest";
import { detectSetWinner, effectiveSetTarget } from "../src/setWinner.js";

const home = { rating: 50 };
const away = { rating: 45 };

describe("detectSetWinner — Rule 6.7", () => {
  it("uses the actual game winner when both players reach their targets in the same game", () => {
    expect(detectSetWinner([
      { home: 50, away: 45, gameWinner: "away" },
    ], home, away, "advanced")).toBe("away");
  });

  it("does not infer the game winner from the point differential", () => {
    expect(detectSetWinner([
      { home: 55, away: 48 },
    ], home, away, "advanced")).toBeNull();
  });

  it("awards the set to the only player who reaches their target", () => {
    expect(detectSetWinner([
      { home: 50, away: 30 },
    ], home, away, "advanced")).toBe("home");
  });

  it("continues accumulating games until a target is reached", () => {
    expect(detectSetWinner([
      { home: 25, away: 20 },
      { home: 25, away: 25, gameWinner: "away" },
    ], home, away, "advanced")).toBe("away");
  });

  it("uses the fixed format target when either player is unrated", () => {
    expect(effectiveSetTarget({ rating: 1 }, { rating: 70 }, "open")).toBe(45);
    expect(effectiveSetTarget({ rating: 1 }, { rating: 70 }, "advanced")).toBe(50);
    expect(detectSetWinner([
      { home: 45, away: 45, gameWinner: "home" },
    ], { rating: 1 }, { rating: 70 }, "open")).toBe("home");
  });

  it("does not infer a winner when a player's rating is missing", () => {
    expect(detectSetWinner([{ home: 50, away: 30 }], { rating: null }, away, "advanced")).toBeNull();
  });
});
