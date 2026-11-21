/** Rulebook Section 5.4 seasonal tournament seeding and bye planning.
 * No within-category tie-break is stated for these seasonal tournaments, so
 * ties at the bye cutoff are held for manager/IBA review, not guessed.
 */
export function classifyChampionshipSeed(team) {
  const position = Number(team?.divisionFinishPosition ?? team?.division_finish_position);
  const champion = Boolean(team?.divisionChampion ?? team?.division_champion);
  if (position === 1 && champion) return "first_place_and_division_champion";
  if (position === 1) return "first_place_not_division_champion";
  if (Number.isFinite(position) && position > 1 && champion) return "below_first_division_champion";
  return null;
}
export function classifyConsolationSeed(team) {
  const champion = Boolean(team?.consolationChampion ?? team?.consolation_champion);
  if (!champion) return null;
  const receivedBye = team?.receivedBye ?? team?.received_bye;
  if (receivedBye === true) return "consolation_champion_after_bye";
  if (receivedBye === false) return "consolation_champion_back_to_back_wins";
  return "consolation_champion_history_unverified";
}
function nextPowerOfTwo(value) {
  let n = 1;
  while (n < value) n *= 2;
  return n;
}
const PRIORITY = {
  championship: ["first_place_and_division_champion", "first_place_not_division_champion", "below_first_division_champion"],
  consolation: ["consolation_champion_back_to_back_wins", "consolation_champion_after_bye"],
};
/** byeRank is accepted only as an explicit, trusted ordering supplied by an authoritative source. */
export function buildSeasonalByePlan(tournamentType, teams) {
  const priority = PRIORITY[tournamentType];
  if (!priority) throw new Error("tournamentType must be championship or consolation");
  const field = Array.isArray(teams) ? teams : [];
  const ids = field.map(team => team.teamId);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("Every team must have a unique teamId");
  const bracketSize = field.length ? nextPowerOfTwo(field.length) : 0;
  const byeCount = bracketSize - field.length;
  const ranked = field.map(team => ({ ...team, seedCategory: team.seedCategory ?? (tournamentType === "championship" ? classifyChampionshipSeed(team) : classifyConsolationSeed(team)) }));
  const invalid = ranked.filter(team => !priority.includes(team.seedCategory));
  const eligible = ranked.filter(team => priority.includes(team.seedCategory));
  const awarded = [];
  const pending = [];
  let remaining = byeCount;
  for (const category of priority) {
    const group = eligible.filter(team => team.seedCategory === category);
    if (!group.length || remaining <= 0) continue;
    if (group.length <= remaining) {
      awarded.push(...group.map(team => team.teamId));
      remaining -= group.length;
      continue;
    }
    const ranks = group.map(team => Number(team.byeRank));
    const hasCompleteByeRank = group.every(team => team.byeRank !== undefined && team.byeRank !== null && Number.isFinite(Number(team.byeRank))) && new Set(ranks).size === group.length;
    if (hasCompleteByeRank) {
      const sorted = [...group].sort((a, b) => Number(a.byeRank) - Number(b.byeRank));
      awarded.push(...sorted.slice(0, remaining).map(team => team.teamId));
    } else {
      pending.push(...group.map(team => team.teamId));
    }
    remaining = 0;
  }
  const awardedSet = new Set(awarded);
  const pendingSet = new Set(pending);
  return {
    tournamentType, qualifiedTeamCount: field.length, bracketSize, byeCount,
    awardedTeamIds: awarded,
    nonByeTeamIds: eligible.filter(team => !awardedSet.has(team.teamId) && !pendingSet.has(team.teamId)).map(team => team.teamId),
    pendingTeamIds: pending,
    unclassifiedTeamIds: invalid.map(team => team.teamId),
    requiresReview: pending.length > 0 || invalid.length > 0,
    unresolvedByes: Math.max(0, byeCount - awarded.length),
  };
}

/**
 * Determines whether a consolation champion advanced through a recorded bye.
 * Returns null when the playoff rows do not prove either required path.
 */
export function deriveConsolationByeStatus(teamId, playoffMatches) {
  const matches = Array.isArray(playoffMatches) ? playoffMatches : [];
  const finals = matches.filter(match =>
    match?.bracket_type === "consolation" &&
    match?.round === "final" &&
    String(match?.winner_team_id ?? "") === String(teamId)
  );
  if (finals.length !== 1) return null;
  const final = finals[0];
  const groupKey = final.bracket_group ?? final.bracket_label;
  if (!groupKey) return null;
  const group = matches.filter(match =>
    match?.bracket_type === "consolation" &&
    (match.bracket_group ?? match.bracket_label) === groupKey
  );
  const byeSemifinals = group.filter(match =>
    match.round === "semifinal" && (match.is_bye_home === true || match.is_bye_away === true)
  );
  const byeTeamIds = byeSemifinals.map(match =>
    match.is_bye_home === true ? match.team_home_id : match.team_away_id
  );
  if (byeTeamIds.some(id => String(id ?? "") === String(teamId))) return true;
  const recordedSemifinalWins = group.filter(match =>
    match.round === "semifinal" &&
    !(match.is_bye_home === true || match.is_bye_away === true) &&
    String(match.winner_team_id ?? "") === String(teamId)
  );
  return recordedSemifinalWins.length > 0 ? false : null;
}

/** Aggregate all divisions into the two season-wide tournaments (Rulebook 5.3). */
export function buildSeasonalTournamentPlans(divisionSnapshots) {
  const championshipTeams = [];
  const consolationTeams = [];
  for (const row of divisionSnapshots ?? []) {
    const divisionId = row?.division?.id ?? null;
    for (const team of row?.seeding?.championship ?? []) {
      championshipTeams.push({ ...team, divisionId });
    }
    for (const team of row?.seeding?.consolation ?? []) {
      consolationTeams.push({ ...team, divisionId });
    }
  }
  return {
    championship: {
      teams: championshipTeams,
      byePlan: buildSeasonalByePlan("championship", championshipTeams),
    },
    consolation: {
      teams: consolationTeams,
      byePlan: buildSeasonalByePlan("consolation", consolationTeams),
    },
  };
}
