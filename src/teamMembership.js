// Current team context is derived exclusively from active profile_team_memberships.
// Ended memberships remain available for history but never count as current.
export function getActiveTeamIds(profile) {
  const memberships = Array.isArray(profile?.team_memberships) ? profile.team_memberships : [];
  return [...new Set(
    memberships
      .filter(m => m && !m.ended_at && m.team_id)
      .sort((a, b) => String(a.joined_at ?? "").localeCompare(String(b.joined_at ?? "")))
      .map(m => m.team_id)
  )];
}

export function hasActiveTeamMembership(profile, teamId) {
  return !!teamId && getActiveTeamIds(profile).includes(teamId);
}
