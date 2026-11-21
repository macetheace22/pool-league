/**
 * Rulebook-defined seasonal tournament qualification derived from
 * authoritative final standings and completed division playoff results.
 *
 * This is deliberately pure: callers provide the official standings and
 * playoff rows; this module never recalculates standings or invents winners.
 */

function normalizedPosition(row) {
  const n = Number(row?.position ?? row?.rank ?? row?.place);
  return Number.isFinite(n) ? n : null;
}

function teamIdOf(row) {
  return row?.teamId ?? row?.team_id ?? null;
}

function winnerIdOf(match) {
  return match?.winnerTeamId ?? match?.winner_team_id ?? null;
}

function divisionChampionId(matches) {
  const finals = (matches ?? []).filter(match =>
    match?.bracket_type === "championship" && match?.round === "final"
  );
  return finals.length === 1 ? winnerIdOf(finals[0]) : null;
}

function consolationChampionIds(matches) {
  return (matches ?? [])
    .filter(match => match?.bracket_type === "consolation" && match?.round === "final")
    .map(winnerIdOf)
    .filter(Boolean);
}

export function buildSeasonalQualificationSnapshot(standings, playoffMatches = []) {
  const rows = (standings ?? [])
    .map(row => ({ ...row, position: normalizedPosition(row), teamId: teamIdOf(row) }))
    .filter(row => row.teamId && row.position != null)
    .sort((a, b) => a.position - b.position);

  const divisionChampion = divisionChampionId(playoffMatches);
  const championshipIds = new Set();
  const first = rows.find(row => row.position === 1);
  if (first) championshipIds.add(first.teamId);
  if (divisionChampion) {
    const championRow = rows.find(row => row.teamId === divisionChampion);
    if (championRow && championRow.position <= 4) championshipIds.add(divisionChampion);
  }

  const championship = rows
    .filter(row => championshipIds.has(row.teamId))
    .map(row => ({
      teamId: row.teamId,
      name: row.name ?? null,
      teamNum: row.teamNum ?? row.team_num ?? null,
      position: row.position,
      qualified: true,
      reason: row.position === 1 && row.teamId === divisionChampion
        ? "regular_season_first_and_division_champion"
        : row.position === 1
          ? "regular_season_first_place_automatic"
          : "division_champion",
    }));

  const consolationWinners = new Set(consolationChampionIds(playoffMatches));
  const consolation = rows
    .filter(row => row.position >= 5 && consolationWinners.has(row.teamId))
    .map(row => ({
      teamId: row.teamId,
      position: row.position,
      qualified: true,
      reason: "consolation_bracket_champion",
    }));

  const qualifiedIds = new Set([
    ...championship.map(row => row.teamId),
    ...consolation.map(row => row.teamId),
  ]);
  const excluded = rows
    .filter(row => !qualifiedIds.has(row.teamId))
    .map(row => ({
      teamId: row.teamId,
      position: row.position,
      qualified: false,
      reason: row.position >= 2 && row.position <= 4
        ? "did_not_win_division_championship"
        : row.position >= 5
          ? "did_not_win_consolation_bracket"
          : "not_qualified",
    }));

  return {
    complete: rows.length > 0,
    divisionChampionId: divisionChampion,
    championship,
    consolation,
    excluded,
  };
}

export function buildSeasonalSeedingInputs(snapshot) {
  return {
    championship: (snapshot?.championship ?? []).map(row => ({
      ...row,
      seedCategory: row.position === 1 && row.teamId === snapshot.divisionChampionId
        ? "first_place_and_division_champion"
        : row.position === 1
          ? "first_place_not_division_champion"
          : "below_first_division_champion",
    })),
    consolation: (snapshot?.consolation ?? []).map(row => ({
      ...row,
      seedCategory: "consolation_champion_pending_bracket_history",
    })),
  };
}
