import { describe, expect, it } from "vitest";
import { getChicagoCalendarDate, getDivisionMonitoringWindow } from "../src/ibaScheduleMonitor";

const weeks = [
  { week: 1, date: "9/13/2026", pairings: [{ home: 1, away: 2 }] },
  { week: 2, date: "9/20/2026", pairings: [{ home: 1, away: 2 }] },
  { week: 3, date: "9/27/2026", pairings: [{ home: 1, away: 2 }] },
  { week: 4, date: "10/4/2026", pairings: [{ home: 1, away: 2 }] },
  { week: 5, date: "10/11/2026", pairings: [{ home: 1, away: 2 }] },
  { week: 6, date: "10/18/2026", pairings: [{ home: 1, away: 2 }] },
];

describe("IBA Week 1–5 schedule monitoring window", () => {
  it("starts on the scheduled Week 1 date", () => {
    expect(getDivisionMonitoringWindow(weeks, "2026-09-13").status).toBe("monitor");
  });
  it("monitors throughout Week 5 and includes its scheduled date", () => {
    expect(getDivisionMonitoringWindow(weeks, "2026-10-11")).toMatchObject({
      status: "monitor", startDate: "2026-09-13", cutoffDate: "2026-10-11",
    });
  });
  it("does not monitor before Week 1", () => {
    expect(getDivisionMonitoringWindow(weeks, "2026-09-12").status).toBe("not_started");
  });
  it("stops after the Week 5 date even when later schedule weeks exist", () => {
    expect(getDivisionMonitoringWindow(weeks, "2026-10-12").status).toBe("cutoff_reached");
  });
  it("does not guess when Week 1 or Week 5 is missing", () => {
    expect(getDivisionMonitoringWindow(weeks.filter(week => week.week !== 5), "2026-09-20")).toMatchObject({
      status: "incomplete",
    });
  });
  it("rejects invalid schedule boundary dates", () => {
    const invalid = weeks.map(week => week.week === 5 ? { ...week, date: "2/31/2026" } : week);
    expect(getDivisionMonitoringWindow(invalid, "2026-09-20").status).toBe("incomplete");
  });
  it("uses the America/Chicago calendar date for the scheduled run", () => {
    expect(getChicagoCalendarDate(new Date("2026-09-13T05:30:00.000Z"))).toBe("2026-09-13");
    expect(getChicagoCalendarDate(new Date("2026-09-13T06:30:00.000Z"))).toBe("2026-09-13");
  });
});
