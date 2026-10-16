// Shared, side-effect-free checks used by both automatic and manual IBA imports.
// This module deliberately does not guess a week or allow a report to proceed
// when schedule/history data is unavailable.
const VALID_REPORT_TYPES = new Set(["rost", "div", "mvp"]);

function missingWeek() {
  return { weekNumber: null, weekNumbers: [], missing: true, ambiguous: false };
}

export function getDivisionReportWeek(reportMetadata, divisionNum) {
  const sections = reportMetadata?.reportWeeksByDivision;
  if (sections?.hasDivisionSections) {
    const division = sections.byDivision?.[String(divisionNum)];
    // A report with division sections must never lend one division's week to
    // another division whose section is missing.
    return division ?? { ...missingWeek(), divisionLabel: null };
  }
  return reportMetadata?.reportWeek ?? missingWeek();
}

export function classifyIbaReportImport({
  reportType,
  divisionNum,
  reportMetadata,
  scheduledWeeks,
  history,
  contentSha256,
}) {
  if (!VALID_REPORT_TYPES.has(String(reportType || "").toLowerCase())) {
    return { status: "blocked_invalid_report_type", reason: "Unsupported IBA report type." };
  }

  const week = getDivisionReportWeek(reportMetadata, divisionNum);
  if (week.missing || !Number.isInteger(week.weekNumber)) {
    return {
      status: week.ambiguous ? "blocked_ambiguous_week" : "blocked_missing_week",
      reason: week.ambiguous
        ? "The PDF contains conflicting week labels for this division."
        : "The PDF week could not be detected for this division.",
      week,
    };
  }

  if (!Array.isArray(scheduledWeeks) || scheduledWeeks.length === 0) {
    return {
      status: "blocked_schedule_unavailable",
      reason: "The selected division's schedule could not be verified.",
      week,
    };
  }

  const scheduledWeekNumbers = scheduledWeeks
    .map(item => Number(item?.week ?? item?.weekNumber ?? item?.week_number))
    .filter(Number.isInteger);
  if (!scheduledWeekNumbers.includes(week.weekNumber)) {
    return {
      status: "blocked_schedule_mismatch",
      reason: `PDF says week ${week.weekNumber}, but that week is not present in the selected division's schedule.`,
      week,
      scheduledWeekNumbers,
    };
  }

  if (!Array.isArray(history)) {
    return {
      status: "blocked_history_unavailable",
      reason: "Import history could not be checked; retry before importing.",
      week,
    };
  }

  const matchingWeek = history.filter(item =>
    String(item?.report_type ?? item?.reportType ?? "").toLowerCase() === String(reportType).toLowerCase()
    && Number(item?.report_week ?? item?.reportWeek) === week.weekNumber
  );
  const fingerprint = String(contentSha256 || "").toLowerCase();
  if (matchingWeek.some(item => String(item?.content_sha256 ?? item?.contentSha256 ?? "").toLowerCase() === fingerprint && fingerprint)) {
    return { status: "duplicate", reason: "This exact report has already been imported for this division and week.", week };
  }
  if (matchingWeek.length > 0) {
    return {
      status: "changed_content",
      reason: "A report for this division, report type, and week was imported before, but its content has changed. Review before importing again.",
      week,
    };
  }

  return { status: "ready", reason: "Week, schedule, and import history checks passed.", week };
}
