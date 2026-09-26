import { describe, it, expect } from "vitest";
import { computeShotStats } from "../db.js";

const shot = (outcome, extra = {}) => ({ category: "shot", outcome, tags: [], is_scratch: false, is_foul: false, is_miscue: false, ...extra });

describe("computeShotStats", () => {
  it("counts makes/misses and computes make percentage, rounded", () => {
    const events = [shot("make"), shot("miss"), shot("make")];
    const stats = computeShotStats(events);
    expect(stats.totalShots).toBe(3);
    expect(stats.makes).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.makePct).toBe(67); // 2/3 = 66.67% -> rounds to 67
  });

  it("scratches/fouls/miscues are counted across ALL categories, not just shots", () => {
    const events = [
      shot("miss", { is_scratch: true }),
      { category: "break", outcome: "make", tags: [], is_scratch: false, is_foul: true, is_miscue: false },
      { category: "safety", outcome: "successful", tags: [], is_scratch: false, is_foul: false, is_miscue: true },
    ];
    const stats = computeShotStats(events);
    expect(stats.scratches).toBe(1);
    expect(stats.fouls).toBe(1);
    expect(stats.miscues).toBe(1);
  });

  it("breaks down by distance/cut/technique tags, including multi-tag shots counting toward each tag", () => {
    const events = [
      shot("make", { tags: ["short"] }),
      shot("miss", { tags: ["short"] }),
      shot("make", { tags: ["long", "bank"] }),
    ];
    const stats = computeShotStats(events);
    expect(stats.byDistance.short).toEqual({ attempts: 2, makes: 1, pct: 50 });
    expect(stats.byDistance.long).toEqual({ attempts: 1, makes: 1, pct: 100 });
    expect(stats.byDistance.medium).toEqual({ attempts: 0, makes: 0, pct: 0 });
    expect(stats.byTechnique.bank).toEqual({ attempts: 1, makes: 1, pct: 100 });
    expect(stats.byTechnique.jump).toEqual({ attempts: 0, makes: 0, pct: 0 });
  });

  it("byCut reads the cut_left/cut_right tag keys specifically", () => {
    const events = [shot("make", { tags: ["cut_left"] }), shot("miss", { tags: ["cut_right"] })];
    const stats = computeShotStats(events);
    expect(stats.byCut.left).toEqual({ attempts: 1, makes: 1, pct: 100 });
    expect(stats.byCut.right).toEqual({ attempts: 1, makes: 0, pct: 0 });
  });

  it("safeties, breaks, and runouts are tracked separately from shot make/miss", () => {
    const events = [
      { category: "safety", outcome: "successful", tags: [], is_scratch: false, is_foul: false, is_miscue: false },
      { category: "safety", outcome: "unsuccessful", tags: [], is_scratch: false, is_foul: false, is_miscue: false },
      { category: "break", outcome: "make", tags: [], is_scratch: true, is_foul: false, is_miscue: false },
      { category: "runout" },
      { category: "runout" },
    ];
    const stats = computeShotStats(events);
    expect(stats.safeties).toEqual({ attempts: 2, successful: 1, pct: 50 });
    expect(stats.breaks).toEqual({ attempts: 1, made: 1, scratches: 1 });
    expect(stats.runouts).toBe(2);
    expect(stats.totalShots).toBe(0); // none of the above are category "shot"
  });

  it("empty input returns all zeros with no division-by-zero (NaN/Infinity) anywhere", () => {
    const stats = computeShotStats([]);
    expect(stats.totalShots).toBe(0);
    expect(stats.makePct).toBe(0);
    expect(stats.byDistance.short).toEqual({ attempts: 0, makes: 0, pct: 0 });
    expect(stats.safeties).toEqual({ attempts: 0, successful: 0, pct: 0 });
    expect(stats.breaks).toEqual({ attempts: 0, made: 0, scratches: 0 });
    expect(stats.runouts).toBe(0);
  });

  it("a shot event with no tags array (undefined) doesn't crash the tag breakdown", () => {
    const events = [{ category: "shot", outcome: "make", is_scratch: false, is_foul: false, is_miscue: false }];
    expect(() => computeShotStats(events)).not.toThrow();
    const stats = computeShotStats(events);
    expect(stats.totalShots).toBe(1);
    expect(stats.byDistance.short.attempts).toBe(0);
  });
});
