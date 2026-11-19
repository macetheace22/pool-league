// Section 8.5: only the deterministic makeup cutoff and the two
// League Management deadline outcomes are handled here. Responsibility is
// never inferred by the app.

export function parseLeagueDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  let date = null;
  if (/^\\d{1,2}\\/\\d{1,2}\\/\\d{4}$/.test(text)) {
    const [m, d, y] = text.split("/").map(Number);
    date = new Date(y, m - 1, d);
  } else if (/^\\d{4}-\\d{2}-\\d{2}$/.test(text)) {
    const [y, m, d] = text.split("-").map(Number);
    date = new Date(y, m - 1, d);
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

export function makeupCutoffFromFinalRegularSeasonDate(finalRegularSeasonDate) {
  const finalDate = parseLeagueDate(finalRegularSeasonDate);
  if (!finalDate) return null;
  // The rule says no makeup is allowed less than seven days before the
  // last scheduled regular-season date. The final allowable calendar date
  // is therefore seven days before that final regular-season date.
  const cutoff = new Date(finalDate);
  cutoff.setDate(cutoff.getDate() - 7);
  cutoff.setHours(23, 59, 59, 999);
  return cutoff;
}

export function isMakeupWithinProhibitedWindow(finalRegularSeasonDate, now = new Date()) {
  const cutoff = makeupCutoffFromFinalRegularSeasonDate(finalRegularSeasonDate);
  return !!cutoff && now.getTime() > cutoff.getTime();
}

export function validateDeadlineResolution(outcome, responsibleSide = null) {
  if (outcome === "no_agreement") return { ok: true, responsibleSide: null };
  if (outcome === "team_responsible" && ["home", "away"].includes(responsibleSide)) {
    return { ok: true, responsibleSide };
  }
  return { ok: false, reason: "INVALID_RESOLUTION" };
}
