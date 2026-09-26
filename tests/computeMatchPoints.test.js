import { describe, it, expect } from "vitest";

import { computeMatchPoints } from "../src/db.js";

describe("computeMatchPoints", () => {

  it("masters format: winner gets add-on + 100, loser gets 0", () => {
    const state = {
      format: "masters",

      sets: [{
        complete: true,
        winnerSlot: "home",

        playerHome: { num: "1", rating: 50 },
        playerAway: { num: "2", rating: 45 },

        racks: [{ home: 50, away: 30 }],
      }],
    };

    // Away rating = 45
    // Away run = 30
    // Margin = 45 - 30 = 15
    // Add-on = 15 * 3 = 45
    // Home = 45 + 100 = 145
    // Masters does NOT apply the 325 team-rating adjustment.

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 145,
      awayPoints: 0,
    });
  });


  it("advanced format: five unique shooters, runs are retained, and 325 team-rating adjustment is applied", () => {
    const state = {
      format: "advanced",

      sets: [
        {
          complete: true,
          winnerSlot: "away",

          playerHome: { num: "1", rating: 50 },
          playerAway: { num: "6", rating: 40 },

          racks: [{ home: 20, away: 40 }],
        },

        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "2", rating: 55 },
          playerAway: { num: "7", rating: 45 },

          racks: [{ home: 55, away: 30 }],
        },

        {
          complete: true,
          winnerSlot: "away",

          playerHome: { num: "3", rating: 60 },
          playerAway: { num: "8", rating: 50 },

          racks: [{ home: 25, away: 50 }],
        },

        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "4", rating: 65 },
          playerAway: { num: "9", rating: 55 },

          racks: [{ home: 65, away: 40 }],
        },

        {
          complete: true,
          winnerSlot: "away",

          playerHome: { num: "5", rating: 70 },
          playerAway: { num: "10", rating: 60 },

          racks: [{ home: 30, away: 60 }],
        },
      ],
    };

    /*
      HOME TEAM RATING:
      50 + 55 + 60 + 65 + 70 = 300

      AWAY TEAM RATING:
      40 + 45 + 50 + 55 + 60 = 250

      HOME 325 adjustment:
      325 - 300 = +25

      AWAY 325 adjustment:
      325 - 250 = +75


      SET 1 - AWAY WINS:
      Home run = 20
      Away run = 40
      Home rating = 50

      Margin = 50 - 20 = 30
      Add-on = 30 * 3 = 90

      Away = 40 + 90 + 100 = 230
      Home = 20


      SET 2 - HOME WINS:
      Home run = 55
      Away run = 30
      Away rating = 45

      Margin = 45 - 30 = 15
      Add-on = 15 * 3 = 45

      Home = 55 + 45 + 100 = 200
      Away = 30


      SET 3 - AWAY WINS:
      Home run = 25
      Away run = 50
      Home rating = 60

      Margin = 60 - 25 = 35
      Add-on = 35 * 3 = 105

      Away = 50 + 105 + 100 = 255
      Home = 25


      SET 4 - HOME WINS:
      Home run = 65
      Away run = 40
      Away rating = 55

      Margin = 55 - 40 = 15
      Add-on = 15 * 3 = 45

      Home = 65 + 45 + 100 = 210
      Away = 40


      SET 5 - AWAY WINS:
      Home run = 30
      Away run = 60
      Home rating = 70

      Margin = 70 - 30 = 40
      Add-on = 40 * 3 = 120

      Away = 60 + 120 + 100 = 280
      Home = 30


      RAW TOTALS:
      Home = 20 + 200 + 25 + 210 + 30 = 485
      Away = 230 + 30 + 255 + 40 + 280 = 835


      AFTER 325 TEAM-RATING ADJUSTMENT:
      Home = 485 + 25 = 510
      Away = 835 + 75 = 910
    */

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 510,
      awayPoints: 910,
    });
  });


  it("open format: unrated player forces both players to the fixed target", () => {
    const state = {
      format: "open",

      sets: [
        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "1", rating: 1 },
          playerAway: { num: "6", rating: 50 },

          racks: [{ home: 45, away: 20 }],
        },
      ],
    };

    /*
      Open target = 45.

      Because Home is unrated, BOTH players use the fixed
      target of 45.

      Away run = 20
      Margin = 45 - 20 = 25
      Add-on = 25 * 3 = 75

      Home = 45 + 75 + 100 = 220
      Away = 20

      Team ratings:
      Home unrated = 45
      Away = 50

      Home adjustment:
      325 - 45 = +280

      Away adjustment:
      325 - 50 = +275

      Therefore the complete result includes those adjustments.
    */

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 500,
      awayPoints: 295,
    });
  });


  it("applies a 5x penalty when a team rating is over 325", () => {
    const state = {
      format: "advanced",

      sets: [
        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "1", rating: 70 },
          playerAway: { num: "6", rating: 50 },

          racks: [{ home: 70, away: 30 }],
        },

        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "2", rating: 70 },
          playerAway: { num: "7", rating: 50 },

          racks: [{ home: 70, away: 30 }],
        },

        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "3", rating: 70 },
          playerAway: { num: "8", rating: 50 },

          racks: [{ home: 70, away: 30 }],
        },

        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "4", rating: 70 },
          playerAway: { num: "9", rating: 50 },

          racks: [{ home: 70, away: 30 }],
        },

        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "5", rating: 70 },
          playerAway: { num: "10", rating: 50 },

          racks: [{ home: 70, away: 30 }],
        },
      ],
    };

    /*
      Home team rating:
      70 * 5 = 350

      350 - 325 = 25 over the limit
      25 * 5 = 125 penalty

      Away team rating:
      50 * 5 = 250

      325 - 250 = +75 bonus
    */

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 1025,
      awayPoints: 225,
    });
  });


  it("forfeit: receiving side gets the flat forfeit point value, forfeiting side gets 0", () => {
    const state = {
      format: "masters",

      sets: [{
        complete: true,
        winnerSlot: "away",

        playerHome: { num: "1", rating: 50 },
        playerAway: { num: "2", rating: 45 },

        racks: [],

        forfeited: true,
        forfeitedBy: "home",
        forfeitPoints: 100,
      }],
    };

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 0,
      awayPoints: 100,
    });
  });


  it("forfeited by away: home receives the forfeit points", () => {
    const state = {
      format: "masters",

      sets: [{
        complete: true,
        winnerSlot: "home",

        playerHome: { num: "1", rating: 50 },
        playerAway: { num: "2", rating: 45 },

        racks: [],

        forfeited: true,
        forfeitedBy: "away",
        forfeitPoints: 100,
      }],
    };

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 100,
      awayPoints: 0,
    });
  });


  it("ignores incomplete sets", () => {
    const state = {
      format: "masters",

      sets: [
        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "1", rating: 50 },
          playerAway: { num: "2", rating: 45 },

          racks: [{ home: 50, away: 30 }],
        },

        {
          complete: false,
          winnerSlot: "away",

          playerHome: { num: "3", rating: 60 },
          playerAway: { num: "4", rating: 55 },

          racks: [{ home: 10, away: 50 }],
        },
      ],
    };

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 145,
      awayPoints: 0,
    });
  });


  it("ignores a complete set without a winner", () => {
    const state = {
      format: "masters",

      sets: [{
        complete: true,
        winnerSlot: null,

        playerHome: { num: "1", rating: 50 },
        playerAway: { num: "2", rating: 45 },

        racks: [{ home: 50, away: 30 }],
      }],
    };

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 0,
      awayPoints: 0,
    });
  });


  it("accumulates points across multiple completed sets", () => {
    const state = {
      format: "masters",

      sets: [
        {
          complete: true,
          winnerSlot: "home",

          playerHome: { num: "1", rating: 50 },
          playerAway: { num: "2", rating: 45 },

          racks: [{ home: 50, away: 30 }],
        },

        {
          complete: true,
          winnerSlot: "away",

          playerHome: { num: "3", rating: 60 },
          playerAway: { num: "4", rating: 55 },

          racks: [{ home: 20, away: 55 }],
        },
      ],
    };

    /*
      Set 1:
      Home = 145
      Away = 0

      Set 2:
      Home run = 20
      Away run = 55
      Home rating = 60

      Margin = 60 - 20 = 40
      Add-on = 120

      Away = 55 + 120 + 100 = 275
      Home = 0

      Total:
      Home = 145
      Away = 275
    */

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 145,
      awayPoints: 220,
    });
  });


  it("defaults to masters when format is missing", () => {
    const state = {
      sets: [{
        complete: true,
        winnerSlot: "home",

        playerHome: { num: "1", rating: 50 },
        playerAway: { num: "2", rating: 45 },

        racks: [{ home: 50, away: 30 }],
      }],
    };

    expect(computeMatchPoints(state)).toEqual({
      homePoints: 145,
      awayPoints: 0,
    });
  });

});