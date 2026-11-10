function toIsoDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function latestPerPlayer(rows) {
  const latest = new Map();
  for (const row of rows) {
    const key = String(row.player_num);
    const prior = latest.get(key);
    const rowDate = toIsoDate(row.schedule_week_date) ?? "";
    const priorDate = toIsoDate(prior?.schedule_week_date) ?? "";
    if (!prior || rowDate > priorDate ||
      (rowDate === priorDate && String(row.imported_at ?? "") > String(prior.imported_at ?? ""))) latest.set(key, row);
  }
  return [...latest.values()];
}

function counterTotalAtDate(teamId, date, snapshots) {
  const rows = snapshots.filter(row => row.team_id === teamId && toIsoDate(row.schedule_week_date) === date);
  if (!rows.length) return null;
  const asOf = latestPerPlayer(snapshots.filter(row =>
    row.team_id === teamId && toIsoDate(row.schedule_week_date) && toIsoDate(row.schedule_week_date) <= date
  ));
  if (!asOf.length || asOf.some(row => row.matches_played == null || row.matches_won == null)) return null;
  const totals = asOf.reduce((sum, row) => ({
    played: sum.played + Number(row.matches_played),
    won: sum.won + Number(row.matches_won),
  }), { played: 0, won: 0 });
  return totals;
}

/**
 * Audit-only Rule 5.5 calculation. Official IBA positions remain authoritative.
 * Uses report week dates to align imported cumulative player counters and
 * weekly team points to scheduled regular-season matches.
 */
export function buildRule55TieBreakAudit({
  officialStandings = [],
  schedule = [],
  standingsHistory = [],
  counterSnapshots = [],
} = {}) {
  const ranked = [...officialStandings]
    .filter(team => team.teamId && !String(team.teamId).startsWith("manual:"))
    .sort((a, b) => Number(a.position ?? 999999) - Number(b.position ?? 999999));
  const byPoints = new Map();
  for (const team of ranked) {
    const key = String(team.totalPoints ?? 0);
    if (!byPoints.has(key)) byPoints.set(key, []);
    byPoints.get(key).push(team);
  }
  const tiedGroups = [...byPoints.values()].filter(group => group.length > 1);
  if (!tiedGroups.length) return [];

  const weeks = (schedule ?? []).map(week => ({
    ...week,
    dateKey: toIsoDate(week.date),
  })).filter(week =>
    week.dateKey && !week.isPlayoff && !/playoff/i.test(week.special ?? "") && (week.pairings ?? []).length
  ).sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  const pointsByTeamDate = new Map();
  for (const row of standingsHistory) {
    const date = toIsoDate(row.week_key);
    if (row.team_id && date) pointsByTeamDate.set(`${row.team_id}:${date}`, row.points_last_wk);
  }

  const lastMatchDateByTeam = new Map();
  const priorMatchDateByTeamWeek = new Map();
  const previousDate = new Map();
  for (const week of weeks) {
    const teamsThisWeek = new Set((week.pairings ?? []).flatMap(pairing => [pairing.homeTeamId, pairing.awayTeamId]).filter(Boolean));
    for (const teamId of teamsThisWeek) {
      priorMatchDateByTeamWeek.set(`${teamId}:${week.dateKey}`, previousDate.get(teamId) ?? null);
      previousDate.set(teamId, week.dateKey);
      lastMatchDateByTeam.set(teamId, week.dateKey);
    }
  }

  const output = [];
  for (const group of tiedGroups) {
    const tiedIds = new Set(group.map(team => team.teamId));
    for (const team of group) {
      let headToHeadPoints = 0;
      let headToHeadComplete = true;
      let pointsLost = 0;
      let pointsLostComplete = true;

      for (const week of weeks) {
        for (const pairing of week.pairings ?? []) {
          const isHome = pairing.homeTeamId === team.teamId;
          const isAway = pairing.awayTeamId === team.teamId;
          if (!isHome && !isAway) continue;
          const opponentId = isHome ? pairing.awayTeamId : pairing.homeTeamId;
          const opponentPoints = pointsByTeamDate.get(`${opponentId}:${week.dateKey}`);
          if (opponentPoints == null) pointsLostComplete = false;
          else pointsLost += Number(opponentPoints);
          if (tiedIds.has(opponentId)) {
            const ownPoints = pointsByTeamDate.get(`${team.teamId}:${week.dateKey}`);
            if (ownPoints == null) headToHeadComplete = false;
            else headToHeadPoints += Number(ownPoints);
          }
        }
      }

      const finalTeamDate = lastMatchDateByTeam.get(team.teamId);
      const finalCounters = finalTeamDate ? counterTotalAtDate(team.teamId, finalTeamDate, counterSnapshots) : null;
      const nextTeam = ranked.find(candidate => Number(candidate.position) === Number(team.position) + 1);
      let recordVsNext = null;
      let recordVsNextComplete = !!nextTeam;
      if (nextTeam) {
        const record = { wins: 0, losses: 0, draws: 0, matches: 0 };
        const meetings = [];
        for (const week of weeks) {
          const pairing = (week.pairings ?? []).find(item =>
            (item.homeTeamId === team.teamId && item.awayTeamId === nextTeam.teamId) ||
            (item.awayTeamId === team.teamId && item.homeTeamId === nextTeam.teamId)
          );
          if (pairing) meetings.push(week);
        }
        if (!meetings.length) recordVsNextComplete = false;
        for (const week of meetings) {
          const own = counterTotalAtDate(team.teamId, week.dateKey, counterSnapshots);
          const opponent = counterTotalAtDate(nextTeam.teamId, week.dateKey, counterSnapshots);
          const ownPriorDate = priorMatchDateByTeamWeek.get(`${team.teamId}:${week.dateKey}`);
          const opponentPriorDate = priorMatchDateByTeamWeek.get(`${nextTeam.teamId}:${week.dateKey}`);
          const ownPrior = ownPriorDate ? counterTotalAtDate(team.teamId, ownPriorDate, counterSnapshots) : { won: 0 };
          const opponentPrior = opponentPriorDate ? counterTotalAtDate(nextTeam.teamId, opponentPriorDate, counterSnapshots) : { won: 0 };
          if (!own || !opponent || !ownPrior || !opponentPrior) {
            recordVsNextComplete = false;
            continue;
          }
          const ownSetWins = own.won - ownPrior.won;
          const opponentSetWins = opponent.won - opponentPrior.won;
          if (ownSetWins < 0 || opponentSetWins < 0) {
            recordVsNextComplete = false;
            continue;
          }
          record.matches += 1;
          if (ownSetWins > opponentSetWins) record.wins += 1;
          else if (ownSetWins < opponentSetWins) record.losses += 1;
          else record.draws += 1;
        }
        if (recordVsNextComplete) recordVsNext = record;
      }

      output.push({
        teamId: team.teamId,
        teamName: team.name,
        position: team.position,
        totalPoints: team.totalPoints,
        tiedWith: group.filter(other => other.teamId !== team.teamId).map(other => other.name),
        headToHeadPoints: headToHeadComplete ? headToHeadPoints : null,
        setsWon: finalCounters?.won ?? null,
        pointsLost: pointsLostComplete ? pointsLost : null,
        recordVsNext,
        completeness: {
          headToHeadPoints: headToHeadComplete,
          setsWon: !!finalCounters,
          pointsLost: pointsLostComplete,
          recordVsNext: recordVsNextComplete,
        },
      });
    }
  }
  return output.sort((a, b) => Number(a.position ?? 999999) - Number(b.position ?? 999999));
}
