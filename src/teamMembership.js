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


// Captain assignments are separate from player memberships. A profile may be
// a player on several teams and captain only on a subset of those teams.
export function getCaptainTeamIds(profile) {
  const ids = Array.isArray(profile?.captain_team_ids) ? profile.captain_team_ids : [];
  return [...new Set(ids.filter(Boolean))];
}

export function isCaptainOfTeam(profile, teamId) {
  return !!teamId && getCaptainTeamIds(profile).includes(teamId);
}
