// Build a fail-closed roster reconciliation plan from one official IBA roster report.
// A division is reconciled only when every configured team is represented and all
// player placements are unambiguous. An empty player list is meaningful: it clears
// that team's current roster while preserving its historical records.
export function buildRosterSyncPlan({
  parsed = {},
  matchedTeams = [],
  allDivisionTeams = [],
  unmatchedTeamNums = [],
  ambiguousTeamNums = [],
} = {}) {
  const teamsByDivision = new Map();
  for (const team of allDivisionTeams) {
    const divisionId = String(team.division_id ?? "");
    if (!divisionId) continue;
    if (!teamsByDivision.has(divisionId)) teamsByDivision.set(divisionId, []);
    teamsByDivision.get(divisionId).push(team);
  }

  const matchedByNum = new Map(
    matchedTeams.map(team => [String(team.team_num ?? ""), team]),
  );
  const parsedRosters = parsed.rosters ?? {};
  const parsedTeamNums = new Set(Object.keys(parsedRosters).map(String));
  const ambiguousTeams = new Set((ambiguousTeamNums ?? []).map(String));
  const unmatched = (unmatchedTeamNums ?? []).map(String);
  const ambiguousPlayers = parsed.ambiguousRoster ?? [];
  const rosterPayload = [];
  const completeDivisions = [];
  const skippedDivisions = [];
  const warnings = [];

  if (unmatched.length) {
    const reason = `Unmatched team number(s): ${unmatched.join(", ")}. No current rosters were changed; resolve the team mapping and re-import.`;
    for (const [divisionId, teams] of teamsByDivision) {
      skippedDivisions.push({ divisionId, reason });
    }
    warnings.push(reason);
    return { rosterPayload, completeDivisions, skippedDivisions, warnings };
  }

  for (const [divisionId, teams] of teamsByDivision) {
    const expectedNums = new Set(teams.map(team => String(team.team_num ?? "")));
    let reason = null;

    const ambiguousTeam = [...expectedNums].find(teamNum => ambiguousTeams.has(teamNum));
    if (ambiguousTeam) {
      reason = `Team number ${ambiguousTeam} is ambiguous across active divisions.`;
    }

    const missingTeam = teams.find(team => {
      const teamNum = String(team.team_num ?? "");
      return !parsedTeamNums.has(teamNum) || matchedByNum.get(teamNum)?.id !== team.id;
    });
    if (!reason && missingTeam) {
      reason = `The report did not unambiguously include every team in this division (missing or unmatched team ${missingTeam.team_num}).`;
    }

    const ambiguousPlayer = !reason && ambiguousPlayers.find(player => {
      const candidates = (player.candidateTeamIds ?? []).map(String);
      const guessed = player.guessedTeamId == null ? [] : [String(player.guessedTeamId)];
      return [...candidates, ...guessed].some(teamNum => expectedNums.has(teamNum));
    });
    if (!reason && ambiguousPlayer) {
      reason = `Player ${ambiguousPlayer.num ?? "with an unknown number"} has an ambiguous team placement.`;
    }

    const seenPlayers = new Set();
    if (!reason) {
      for (const team of teams) {
        const teamNum = String(team.team_num ?? "");
        for (const playerNum of (parsedRosters[teamNum] ?? []).map(String)) {
          if (seenPlayers.has(playerNum)) {
            reason = `Player ${playerNum} appears on more than one team in this division.`;
            break;
          }
          seenPlayers.add(playerNum);
        }
        if (reason) break;
      }
    }

    if (reason) {
      skippedDivisions.push({ divisionId, reason });
      warnings.push(`Division ${teams[0]?.divisions?.num ?? divisionId}: ${reason} Current roster memberships were left unchanged.`);
      continue;
    }

    for (const team of teams) {
      const teamNum = String(team.team_num ?? "");
      rosterPayload.push({
        team_id: team.id,
        player_nums: [...new Set((parsedRosters[teamNum] ?? []).map(String))],
      });
    }
    completeDivisions.push({ divisionId, teamCount: teams.length });
  }

  return { rosterPayload, completeDivisions, skippedDivisions, warnings };
}
