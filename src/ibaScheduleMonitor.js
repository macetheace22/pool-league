const CHICAGO_TIME_ZONE = "America/Chicago";

function parseScheduleDate(value) {
  const text = String(value ?? "").trim();
  let year, month, day;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, year, month, day] = match;
  else {
    match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (!match) return null;
    [, month, day, year] = match;
  }
  year = Number(year); month = Number(month); day = Number(day);
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function getChicagoCalendarDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHICAGO_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// Monitoring begins on the first scheduled regular-season week and ends on
// the scheduled date of Week 5 (inclusive). Missing/invalid boundaries are
// not guessed: the caller records an incomplete check rather than monitoring
// against an unknown cutoff.
export function getDivisionMonitoringWindow(weeks = [], today) {
  const regular = (Array.isArray(weeks) ? weeks : []).filter(week => {
    const number = Number(week?.week ?? week?.week_num ?? week?.weekNumber);
    return Number.isInteger(number) && number >= 1 && number <= 5 &&
      !week?.isPlayoff && !week?.is_playoff &&
      !/playoff/i.test(String(week?.special ?? ""));
  });
  const first = regular.find(week => Number(week.week ?? week.week_num ?? week.weekNumber) === 1);
  const fifth = regular.find(week => Number(week.week ?? week.week_num ?? week.weekNumber) === 5);
  if (!first || !fifth) {
    return { status: "incomplete", reason: "The saved schedule does not contain both Week 1 and Week 5 boundaries." };
  }
  const startDate = parseScheduleDate(first.date);
  const cutoffDate = parseScheduleDate(fifth.date);
  if (!startDate || !cutoffDate || cutoffDate < startDate) {
    return { status: "incomplete", reason: "The saved Week 1 or Week 5 date is missing or invalid." };
  }
  const currentDate = parseScheduleDate(today);
  if (!currentDate) return { status: "incomplete", reason: "The monitor's local calendar date is invalid." };
  if (currentDate < startDate) return { status: "not_started", startDate, cutoffDate };
  if (currentDate > cutoffDate) return { status: "cutoff_reached", startDate, cutoffDate };
  return { status: "monitor", startDate, cutoffDate };
}

export function emptyMonitorSummary() {
  return { added: 0, removed: 0, changed: 0, dateChanges: 0, tbaResolutions: 0 };
}
