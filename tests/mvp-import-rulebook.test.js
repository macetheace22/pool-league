import { describe, expect, it } from "vitest";
import { validateMvpImportRow, validateMvpImportRows } from "../src/db.js";

describe("Section 5.6 imported MVP formula audit", () => {
  it("reconciles a published row with one 125-point forfeit win", () => {
    expect(validateMvpImportRow({ wins:3, losses:1, total_points:500, mvp_ranking_points:700 }))
      .toMatchObject({ valid:true, inferredForfeitWins:1, calculatedRankingPoints:700 });
  });
  it("reconciles a row with no forfeit wins", () => {
    expect(validateMvpImportRow({ wins:4, losses:1, total_points:837, mvp_ranking_points:1437 }))
      .toMatchObject({ valid:true, inferredForfeitWins:0 });
  });
  it("flags totals that cannot be explained by whole 125-point forfeit wins", () => {
    expect(validateMvpImportRow({ wins:3, losses:1, total_points:500, mvp_ranking_points:750 }).valid).toBe(false);
  });
  it("does not change official imported rankings or positions", () => {
    const rows=[{player_num:"1",player_name:"A",wins:3,losses:1,total_points:500,mvp_ranking_points:700,position:1}];
    const result=validateMvpImportRows(rows);
    expect(result).toMatchObject({total:1,validCount:1,inferredForfeitWins:1});
    expect(rows[0]).toMatchObject({mvp_ranking_points:700,position:1});
  });
});
