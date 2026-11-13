// Pending makeup rows shown to a captain across every team they captain.
// Captain assignment is independent of player roster membership.
export function listCaptainPendingMakeups(teamOverviews, captainTeamIds) {
  const captainIds = new Set(captainTeamIds ?? []);
  return (teamOverviews ?? [])
    .filter(overview => captainIds.has(overview?.team?.id))
    .flatMap(overview => (overview.myCompleted ?? [])
      .filter(match => match?.is_makeup_pending)
      .map(match => ({ match, overview })))
    .sort((a, b) => new Date(b.match.created_at ?? 0) - new Date(a.match.created_at ?? 0));
}
