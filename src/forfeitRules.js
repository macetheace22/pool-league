export function hasLaterCompletedSet(sets, setIdx) {
  return (sets ?? []).some((set, index) => index > setIdx && set?.complete);
}

export function makeupDeadlineFromPlayoffsStart(playoffsStartDate) {
  if (!playoffsStartDate) return null;
  const start = new Date(`${playoffsStartDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() - 14 * 86400000);
}

export function isMakeupDeadlinePassed(playoffsStartDate, now = new Date()) {
  const deadline = makeupDeadlineFromPlayoffsStart(playoffsStartDate);
  return !!deadline && now.getTime() > deadline.getTime();
}
