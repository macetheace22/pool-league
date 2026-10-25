import { describe, it, expect } from "vitest";

import {
  classifyIbaReportImport,
  getDivisionReportWeek,
  getValidatedScheduleWeekTag,
} from "../src/ibaImportValidation.js";

const fingerprint = "a".repeat(64);
const week17 = { weekNumber: 17, weekNumbers: [17], missing: false, ambiguous: false };
const metadata = { reportWeek: week17 };
const scheduledWeeks = [{ week: 17 }];

function classify(overrides = {}) {
  return classifyIbaReportImport({
    reportType: "rost",
    divisionNum: 8538160,
    reportMetadata: metadata,
    scheduledWeeks,
    history: [],
    contentSha256: fingerprint,
    ...overrides,
  });
}

describe("getValidatedScheduleWeekTag", () => {
  it("normalizes valid ISO dates to a stable key", () => {
    expect(getValidatedScheduleWeekTag(17, "2026-10-25")).toEqual({
      weekKey: "2026-10-25",
      label: "IBA Week 17 · 2026-10-25",
    });
  });

  it("accepts legacy US dates and normalizes the key", () => {
    expect(getValidatedScheduleWeekTag(17, "1/3/2027")).toEqual({
      weekKey: "2027-01-03",
      label: "IBA Week 17 · 1/3/2027",
    });
  });

  it.each(["2026-02-30", "13/1/2026", "", "not a date"])(
    "rejects invalid or missing date %s",
    value => {
      expect(getValidatedScheduleWeekTag(17, value)).toBeNull();
    },
  );
});

describe("getDivisionReportWeek", () => {
  it("uses the selected division's week when the PDF has division sections", () => {
    const reportMetadata = {
      reportWeek: { weekNumber: 99, weekNumbers: [99], missing: false, ambiguous: false },
      reportWeeksByDivision: {
        hasDivisionSections: true,
        byDivision: {
          "8538160": week17,
          "8538161": { weekNumber: 18, weekNumbers: [18], missing: false, ambiguous: false },
        },
      },
    };

    expect(getDivisionReportWeek(reportMetadata, 8538160)).toEqual(week17);
    expect(getDivisionReportWeek(reportMetadata, 8538161).weekNumber).toBe(18);
  });

  it("does not borrow a week from another division section", () => {
    const reportMetadata = {
      reportWeek: week17,
      reportWeeksByDivision: {
        hasDivisionSections: true,
        byDivision: { "8538161": week17 },
      },
    };

    expect(getDivisionReportWeek(reportMetadata, 8538160)).toMatchObject({
      weekNumber: null,
      missing: true,
      ambiguous: false,
    });
  });

  it("uses the report-level week when the PDF has no division sections", () => {
    expect(getDivisionReportWeek(metadata, 8538160)).toEqual(week17);
  });
});

describe("classifyIbaReportImport", () => {
  it("allows a report only when week, schedule, fingerprint, and history checks pass", () => {
    expect(classify()).toMatchObject({ status: "ready" });
  });

  it("blocks unsupported report categories", () => {
    expect(classify({ reportType: "unknown" }).status).toBe("blocked_invalid_report_type");
  });

  it("blocks a missing week", () => {
    expect(classify({
      reportMetadata: { reportWeek: { weekNumber: null, weekNumbers: [], missing: true, ambiguous: false } },
    }).status).toBe("blocked_missing_week");
  });

  it("blocks conflicting week labels", () => {
    expect(classify({
      reportMetadata: { reportWeek: { weekNumber: null, weekNumbers: [16, 17], missing: false, ambiguous: true } },
    }).status).toBe("blocked_ambiguous_week");
  });

  it("blocks when schedule data is unavailable", () => {
    expect(classify({ scheduledWeeks: [] }).status).toBe("blocked_schedule_unavailable");
    expect(classify({ scheduledWeeks: null }).status).toBe("blocked_schedule_unavailable");
  });

  it("blocks a PDF week that is not present in the selected division's schedule", () => {
    expect(classify({ scheduledWeeks: [{ week: 16 }] })).toMatchObject({
      status: "blocked_schedule_mismatch",
      scheduledWeekNumbers: [16],
    });
  });

  it("blocks when the PDF fingerprint is absent or malformed", () => {
    expect(classify({ contentSha256: "" }).status).toBe("blocked_content_fingerprint_unavailable");
    expect(classify({ contentSha256: "abc" }).status).toBe("blocked_content_fingerprint_unavailable");
  });

  it("blocks when import history could not be loaded", () => {
    expect(classify({ history: null }).status).toBe("blocked_history_unavailable");
  });

  it("marks the same report fingerprint and week as a duplicate", () => {
    expect(classify({
      history: [{ report_type: "rost", report_week: 17, content_sha256: fingerprint }],
    }).status).toBe("duplicate");
  });

  it("holds changed content for review instead of treating it as a new import", () => {
    expect(classify({
      history: [{ report_type: "rost", report_week: 17, content_sha256: "b".repeat(64) }],
    }).status).toBe("changed_content");
  });

  it("checks duplicate history by report type and week", () => {
    expect(classify({
      history: [{ report_type: "mvp", report_week: 17, content_sha256: fingerprint }],
    }).status).toBe("ready");

    expect(classify({
      history: [{ report_type: "rost", report_week: 16, content_sha256: fingerprint }],
    }).status).toBe("ready");
  });
});
