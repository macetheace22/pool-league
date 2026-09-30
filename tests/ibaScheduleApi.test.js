import { describe, expect, it } from "vitest";
import { parseDivisionOptions, parsePairings, parseScheduleHtml } from "../api/iba-schedules";

describe("IBA schedule API parsers", () => {
  it("parses all divisions from the GetDivisions HTML", () => {
    const html = `
      <select id="Divisions">
        <option value="">Division</option>
        <option selected value="287!8538257">Wed South Advanced</option>
        <option value="287!8538262">Wed West Advanced</option>
        <option value="287!8538266">Wed Northeast Advanced</option>
        <option value="287!8538270">Wed North Advanced</option>
      </select>`;

    expect(parseDivisionOptions(html)).toEqual([
      { value: "287!8538257", label: "Wed South Advanced", selected: true },
      { value: "287!8538262", label: "Wed West Advanced", selected: false },
      { value: "287!8538266", label: "Wed Northeast Advanced", selected: false },
      { value: "287!8538270", label: "Wed North Advanced", selected: false },
    ]);
  });

  it("parses IBA's current GetDivisions response where options are not wrapped in a select", () => {
    const html = `
      <option class="bg-dark-purple" value="">Division</option>
      <option class="bg-dark-purple" selected value="287!8538257">Wed South Advanced</option>
      <option class="bg-dark-purple" value="287!8538262">Wed West Advanced</option>
      <option class="bg-dark-purple" value="287!8538266">Wed Northeast Advanced</option>
      <option class="bg-dark-purple" value="287!8538270">Wed North Advanced</option>
      <option class="bg-dark-purple" value="287!8538274">Wed Southwest Advanced</option>
      <option class="bg-dark-purple" value="287!8538307">Wed Northwest Advanced</option>
      <option class="bg-dark-purple" value="287!8551032">Wed Faribo Area Advanced</option>`;

    expect(parseDivisionOptions(html)).toHaveLength(7);
    expect(parseDivisionOptions(html)[0]).toEqual({ value: "287!8538257", label: "Wed South Advanced", selected: true });
    expect(parseDivisionOptions(html)[6]).toEqual({ value: "287!8551032", label: "Wed Faribo Area Advanced", selected: false });
  });

  it("parses regular and TBD pairings", () => {
    expect(parsePairings("1 vs 2  3 vs 4  5 vs TBD")).toEqual([
      { home: 1, away: 2 },
      { home: 3, away: 4 },
      { home: 5, away: null },
    ]);
  });

  it("parses IBA team and schedule tables with nested pairing markup", () => {
    const html = `
      <table>
        <tr><th>Team #</th><th>Name</th><th>Location</th></tr>
        <tr><td>75101</td><td>Rebels</td><td>Pullman Club</td></tr>
        <tr><td>75102</td><td>Legion of Doom</td><td>Pullman Club</td></tr>
        <tr><td>75103</td><td>Huracanes #1</td><td>Turtle's Bar &amp; Grill</td></tr>
        <tr><td>75104</td><td>Double Dipt</td><td>Turtle's Bar &amp; Grill</td></tr>
      </table>
      <table>
        <tr><th>Week</th><th>Date</th><th>Pairings</th></tr>
        <tr>
          <td>1</td><td>9/9/2026</td>
          <td><table><tr><td>1 vs 2</td><td>3 vs 4</td></tr><tr><td>5 vs TBD</td></tr></table></td>
        </tr>
        <tr><td>2</td><td>9/16/2026</td><td>3 vs 1  2 vs TBD</td></tr>
        <tr><td>11</td><td>11/18/2026</td><td>1 vs 2  3 vs 4</td></tr>
        <tr><td></td><td>11/25/2026</td><td>Thanksgiving - No Matches</td></tr>
        <tr><td>15</td><td>1/6/2027</td><td>Playoffs - All Teams</td></tr>
      </table>`;

    const parsed = parseScheduleHtml(html);

    expect(parsed.teams).toHaveLength(4);
    expect(parsed.teams[0]).toMatchObject({ teamNum: "75101", name: "Rebels", venue: "Pullman Club" });
    expect(parsed.weeks).toEqual(expect.arrayContaining([
      expect.objectContaining({ week: 1, date: "9/9/2026", pairings: [{ home: 1, away: 2 }, { home: 3, away: 4 }, { home: 5, away: null }] }),
      expect.objectContaining({ week: 2, date: "9/16/2026", pairings: [{ home: 3, away: 1 }, { home: 2, away: null }] }),
      expect.objectContaining({ date: "11/25/2026", special: "Thanksgiving - No Matches" }),
      expect.objectContaining({ week: 15, date: "1/6/2027", special: "Playoffs - All Teams" }),
    ]));
    expect(parsed.hasSchedule).toBe(true);
  });
});
