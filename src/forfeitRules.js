// Rule 6.5 team-match forfeit timing.
// The scheduled start is an explicit match-state value because the imported
// schedule currently stores the league date but not a wall-clock start time.
export const TEAM_FORFEIT_MILESTONES = [
  { minutes: 15, sets: 1 },
  { minutes: 30, sets: 2 },
  { minutes: 45, sets: 5 },
];

export function teamForfeitMilestone(scheduledStartAt, now = Date.now()) {
  if (!scheduledStartAt) return null;
  const start = Date.parse(scheduledStartAt);
  if (Number.isNaN(start)) return null;
  const elapsedMinutes = Math.max(0, (now - start) / 60000);
  let result = { minutes: 0, sets: 0, elapsedMinutes };
  for (const milestone of TEAM_FORFEIT_MILESTONES) {
    if (elapsedMinutes >= milestone.minutes) result = { ...milestone, elapsedMinutes };
  }
  return result;
}

export function nextTeamForfeitMilestone(scheduledStartAt, now = Date.now()) {
  if (!scheduledStartAt) return null;
  const start = Date.parse(scheduledStartAt);
  if (Number.isNaN(start)) return null;
  const elapsedMinutes = Math.max(0, (now - start) / 60000);
  return TEAM_FORFEIT_MILESTONES.find(m => elapsedMinutes < m.minutes) ?? null;
}

export function teamForfeitSetsDue(scheduledStartAt, now = Date.now()) {
  return teamForfeitMilestone(scheduledStartAt, now)?.sets ?? 0;
}
