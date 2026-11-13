export function hasLaterCompletedSet(sets, setIdx) {
  return (sets ?? []).some((set, index) => index > setIdx && set?.complete);
}

export function makeupDeadlineFromPlayoffsStart(playoffsStartDate) {
  if (!playoffsStartDate) return null;
  const start = new Date(`${playoffsStartDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  // The cutoff is a calendar date. Treat the entire cutoff date as allowable;
  // the rule excludes make-ups less than seven days before the final
  // regular-season date, not the cutoff date itself.
  const deadline = new Date(start.getTime() - 14 * 86400000);
  deadline.setHours(23, 59, 59, 999);
  return deadline;
}

export function isMakeupDeadlinePassed(playoffsStartDate, now = new Date()) {
  const deadline = makeupDeadlineFromPlayoffsStart(playoffsStartDate);
  return !!deadline && now.getTime() > deadline.getTime();
}

export function hasLaterStartedSet(sets, setIdx) {
  return (sets ?? []).some((set, index) => index > setIdx && (set?.complete || set?.playerHome || set?.playerAway));
}
