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
    const divisionLabel = row?.division?.num != null
      ? `Division ${row.division.num}`
      : row?.division?.name ?? "Division";
    for (const team of row?.seeding?.championship ?? []) {
      championshipTeams.push({ ...team, divisionId, divisionLabel });
    }
    for (const team of row?.seeding?.consolation ?? []) {
      const receivedBye = deriveConsolationByeStatus(team.teamId, row?.playoffMatches);
      const seedCategory = classifyConsolationSeed({ consolationChampion: true, receivedBye });
      consolationTeams.push({ ...team, divisionId, divisionLabel, receivedBye, seedCategory });
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

const SEED_POSITIONS = bracketSize => {
  let positions = [1, 2];
  while (positions.length < bracketSize) {
    const nextSeed = positions.length * 2 + 1;
    positions = positions.flatMap(seed => [seed, nextSeed - seed]);
  }
  return positions;
};

/**
 * Build a complete single-elimination bracket from manager-ordered entries.
 * Entries must already be grouped by rulebook category priority. Ordering
 * within a category is the manager's explicit seed decision.
 */
export function buildSeasonalTournamentBracket(tournamentType, orderedTeams) {
  const priority = PRIORITY[tournamentType];
  if (!priority) throw new Error("tournamentType must be championship or consolation");
  const teams = Array.isArray(orderedTeams) ? orderedTeams : [];
  if (!teams.length) return { error: "At least one qualified team is required." };
  const categoryOrder = teams.map(team => priority.indexOf(team.seedCategory));
  if (categoryOrder.some(index => index < 0)) {
    return { error: "Every team must have a verified rulebook seeding category." };
  }
  if (categoryOrder.some((value, index) => index > 0 && value < categoryOrder[index - 1])) {
    return { error: "Teams must be ordered by the rulebook seeding categories." };
  }

  const categoryRanks = new Map();
  const rankedTeams = teams.map(team => {
    const rank = categoryRanks.get(team.seedCategory) ?? 0;
    categoryRanks.set(team.seedCategory, rank + 1);
    return { ...team, byeRank: rank };
  });
  const byePlan = buildSeasonalByePlan(tournamentType, rankedTeams);
  if (byePlan.requiresReview || byePlan.awardedTeamIds.length !== byePlan.byeCount) {
    return { error: "Bye allocation is unresolved. Review the category order before creating the bracket.", byePlan };
  }

  const bracketSize = byePlan.bracketSize;
  const rounds = bracketSize > 1 ? Math.log2(bracketSize) : 0;
  const byeIds = new Set(byePlan.awardedTeamIds);
  const byeTeams = rankedTeams.filter(team => byeIds.has(team.teamId));
  const playingTeams = rankedTeams.filter(team => !byeIds.has(team.teamId));
  const firstRoundPairCount = bracketSize / 2;
  const firstRoundPairs = [];

  // Place the highest-priority, manager-ordered bye recipients into the
  // opening bye slots. Pair the remaining teams highest seed vs lowest seed.
  for (const team of byeTeams) firstRoundPairs.push([team, null]);
  for (let index = 0; index < playingTeams.length / 2; index++) {
    firstRoundPairs.push([
      playingTeams[index],
      playingTeams[playingTeams.length - 1 - index],
    ]);
  }
  if (firstRoundPairs.length !== firstRoundPairCount) {
    return { error: "The seeded first-round layout does not match the bracket size.", byePlan };
  }

  const matches = [];
  for (let slotNum = 1; slotNum <= firstRoundPairCount; slotNum++) {
    const [home, away] = firstRoundPairs[slotNum - 1];
    const isBye = Boolean(home) !== Boolean(away);
    matches.push({
      matchKey: `r1-m${slotNum}`,
      roundNum: 1,
      slotNum,
      teamHomeId: home?.teamId ?? null,
      teamAwayId: away?.teamId ?? null,
      winnerTeamId: isBye ? (home?.teamId ?? away?.teamId) : null,
      isBye,
      feedsIntoMatchKey: rounds > 1 ? `r2-m${Math.ceil(slotNum / 2)}` : null,
      feedsIntoSlot: rounds > 1 ? (slotNum % 2 === 1 ? "home" : "away") : null,
    });
  }

  for (let roundNum = 2; roundNum <= rounds; roundNum++) {
    const matchCount = bracketSize / (2 ** roundNum);
    for (let slotNum = 1; slotNum <= matchCount; slotNum++) {
      matches.push({
        matchKey: `r${roundNum}-m${slotNum}`,
        roundNum,
        slotNum,
        teamHomeId: null,
        teamAwayId: null,
        winnerTeamId: null,
        isBye: false,
        feedsIntoMatchKey: roundNum < rounds ? `r${roundNum + 1}-m${Math.ceil(slotNum / 2)}` : null,
        feedsIntoSlot: roundNum < rounds ? (slotNum % 2 === 1 ? "home" : "away") : null,
      });
    }
  }

  const matchesByKey = new Map(matches.map(match => [match.matchKey, match]));
  for (const match of matches) {
    if (!match.winnerTeamId || !match.feedsIntoMatchKey) continue;
    const target = matchesByKey.get(match.feedsIntoMatchKey);
    if (match.feedsIntoSlot === "home") target.teamHomeId = match.winnerTeamId;
    else target.teamAwayId = match.winnerTeamId;
  }

  const entries = rankedTeams.map((team, index) => ({
    teamId: team.teamId,
    divisionId: team.divisionId,
    seedNum: index + 1,
    seedCategory: team.seedCategory,
    seedCategorySource: team.seedCategorySource ?? "rulebook_derived",
    divisionPosition: team.position ?? team.divisionFinishPosition ?? null,
    receivedByeHistory: team.seedCategory === "consolation_champion_after_bye"
      ? true
      : team.seedCategory === "consolation_champion_back_to_back_wins"
        ? false
        : null,
  }));

  return {
    tournamentType,
    qualifiedTeamCount: rankedTeams.length,
    bracketSize,
    byePlan,
    entries,
    matches,
    championTeamId: rankedTeams.length === 1 ? rankedTeams[0].teamId : null,
  };
}

/** Convert the pure bracket model to the snake_case contract used by the SQL RPC. */
export function serializeSeasonalTournamentBracket(bracket) {
  return {
    entries: (bracket?.entries ?? []).map(entry => ({
      team_id: entry.teamId,
      division_id: entry.divisionId,
      seed_num: entry.seedNum,
      seed_category: entry.seedCategory,
      seed_category_source: entry.seedCategorySource,
      division_position: entry.divisionPosition,
      received_bye_history: entry.receivedByeHistory,
    })),
    matches: (bracket?.matches ?? []).map(match => ({
      match_key: match.matchKey,
      round_num: match.roundNum,
      slot_num: match.slotNum,
      team_home_id: match.teamHomeId,
      team_away_id: match.teamAwayId,
      winner_team_id: match.winnerTeamId,
      is_bye: match.isBye,
      feeds_into_match_key: match.feedsIntoMatchKey,
      feeds_into_slot: match.feedsIntoSlot,
    })),
  };
}
