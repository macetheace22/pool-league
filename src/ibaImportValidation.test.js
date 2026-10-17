import { describe, expect, it } from "vitest";
import { classifyIbaReportImport, getDivisionReportWeek, getValidatedScheduleWeekTag } from "./ibaImportValidation";

const reportMetadata = weekNumber => ({
  reportWeek: { weekNumber, weekNumbers: [weekNumber], missing: false, ambiguous: false },
});
const schedule = [{ week: 16 }, { week: 17 }, { week: 18 }];

describe("getDivisionReportWeek", () => {
  it("uses the matching division's own week", () => {
    const metadata = {
      reportWeek: { weekNumber: null, weekNumbers: [16, 17], missing: false, ambiguous: true },
      reportWeeksByDivision: {
        hasDivisionSections: true,
        byDivision: {
          "151": { weekNumber: 17, weekNumbers: [17], missing: false, ambiguous: false },
          "152": { weekNumber: 16, weekNumbers: [16], missing: false, ambiguous: false },
        },
      },
    };
    expect(getDivisionReportWeek(metadata, "151").weekNumber).toBe(17);
    expect(getDivisionReportWeek(metadata, "152").weekNumber).toBe(16);
  });

  it("does not borrow a week from another division's section", () => {
    const metadata = {
      reportWeek: { weekNumber: 17, weekNumbers: [17], missing: false, ambiguous: false },
      reportWeeksByDivision: { hasDivisionSections: true, byDivision: { "151": { weekNumber: 17, missing: false, ambiguous: false } } },
    };
    expect(getDivisionReportWeek(metadata, "152")).toMatchObject({ missing: true, weekNumber: null });
  });
});

describe("classifyIbaReportImport", () => {
  const base = {
    reportType: "div",
    divisionNum: "151",
    reportMetadata: reportMetadata(17),
    scheduledWeeks: schedule,
    history: [],
    contentSha256: "a".repeat(64),
  };

  it("allows a valid week not already imported", () => {
    expect(classifyIbaReportImport(base)).toMatchObject({ status: "ready", week: { weekNumber: 17 } });
  });

  it("blocks missing and ambiguous weeks", () => {
    expect(classifyIbaReportImport({ ...base, reportMetadata: { reportWeek: { missing: true } } }).status).toBe("blocked_missing_week");
    expect(classifyIbaReportImport({ ...base, reportMetadata: { reportWeek: { missing: false, ambiguous: true, weekNumber: null } } }).status).toBe("blocked_ambiguous_week");
  });

  it("blocks weeks absent from the selected division's schedule", () => {
    expect(classifyIbaReportImport({ ...base, reportMetadata: reportMetadata(19) }).status).toBe("blocked_schedule_mismatch");
  });

  it("fails closed when schedule, fingerprint, or history cannot be checked", () => {
    expect(classifyIbaReportImport({ ...base, scheduledWeeks: [] }).status).toBe("blocked_schedule_unavailable");
    expect(classifyIbaReportImport({ ...base, history: null }).status).toBe("blocked_history_unavailable");
    expect(classifyIbaReportImport({ ...base, contentSha256: "" }).status).toBe("blocked_content_fingerprint_unavailable");
    expect(classifyIbaReportImport({ ...base, contentSha256: "not-a-hash" }).status).toBe("blocked_content_fingerprint_unavailable");
  });

  it("skips an exact duplicate but flags changed content for the same division/report/week", () => {
    const imported = { report_type: "div", report_week: 17, content_sha256: "a".repeat(64) };
    expect(classifyIbaReportImport({ ...base, history: [imported] }).status).toBe("duplicate");
    expect(classifyIbaReportImport({ ...base, history: [{ ...imported, content_sha256: "b".repeat(64) }] }).status).toBe("changed_content");
  });

  it("treats report categories independently for duplicate checks", () => {
    expect(classifyIbaReportImport({
      ...base,
      reportType: "mvp",
      history: [{ report_type: "div", report_week: 17, content_sha256: "a".repeat(64) }],
    }).status).toBe("ready");
  });
});

describe("getValidatedScheduleWeekTag", () => {
  it.each([
    ["2026-10-09", "2026-10-09"],
    ["10/9/2026", "2026-10-09"],
    ["10/09/2026", "2026-10-09"],
  ])("normalizes valid schedule date %s", (date, expectedKey) => {
    expect(getValidatedScheduleWeekTag(17, date)).toMatchObject({
      weekKey: expectedKey,
      label: expect.stringContaining("Week 17"),
    });
  });

  it.each(["2026-02-30", "13/40/2026", "not-a-date", ""])("rejects invalid schedule date %s", date => {
    expect(getValidatedScheduleWeekTag(17, date)).toBeNull();
  });
});
