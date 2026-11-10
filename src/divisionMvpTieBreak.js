function playerNum(player) {
  return player?.num == null ? null : String(player.num);
}

function individualSetPoints(set, side, format) {
  if (set?.forfeited || !set?.complete) return null;
  const home = set.playerHome;
  const away = set.playerAway;
  if (!home || !away || !["home", "away"].includes(set.winnerSlot)) return null;
  if (!Array.isArray(set.racks) || set.racks.length === 0 || set.racks.some(rack =>
    rack?.home == null || rack?.away == null || !Number.isFinite(Number(rack.home)) || !Number.isFinite(Number(rack.away)))) return null;
  const isMasters = String(format ?? "masters").toLowerCase() === "masters";
  const isOpen = String(format ?? "masters").toLowerCase() === "open";
  const fixedTarget = isOpen ? 45 : 50;
  const unrated = home.rating == null || away.rating == null ||
    Number(home.rating) <= 0 || Number(away.rating) <= 0;
  const targetHome = unrated ? fixedTarget : Number(home.rating);
  const targetAway = unrated ? fixedTarget : Number(away.rating);
  const runHome = (set.racks ?? []).reduce((sum, rack) => sum + Number(rack.home ?? 0), 0);
  const runAway = (set.racks ?? []).reduce((sum, rack) => sum + Number(rack.away ?? 0), 0);
  let homePoints = 0, awayPoints = 0;
  if (set.winnerSlot === "home") {
    const margin = Math.max(0, targetAway - runAway);
    const addOn = isOpen ? 0 : margin * 3;
    homePoints = isMasters ? addOn + 100 : runHome + addOn + 100;
    awayPoints = isMasters ? 0 : runAway;
  } else {
    const margin = Math.max(0, targetHome - runHome);
    const addOn = isOpen ? 0 : margin * 3;
    awayPoints = isMasters ? addOn + 100 : runAway + addOn + 100;
    homePoints = isMasters ? 0 : runHome;
  }
  return side === "home" ? homePoints : awayPoints;
}

function scheduledRegularMatches(matches, schedule) {
  const pairingById = new Map();
  for (const week of schedule ?? []) {
    if (week.isPlayoff || /playoff/i.test(week.special ?? "")) continue;
    for (const pairing of week.pairings ?? []) {
      if (pairing.id) pairingById.set(String(pairing.id), { week, pairing });
    }
  }
  return (matches ?? []).filter(match => {
    if (!match?.state || match.is_makeup_pending) return false;
    if (match.state.isPlayoff || match.state.is_playoff) return false;
    const pairingId = match.state.schedulePairingId;
    if (!pairingId) return false;
    const scheduled = pairingById.get(String(pairingId));
    if (!scheduled) return false;
    return scheduled.pairing.homeTeamId === match.team_home_id &&
      scheduled.pairing.awayTeamId === match.team_away_id;
  });
}

/**
 * Audit-only Rule 5.5 Division MVP tie-break. Official IBA ranking and
 * published position are never modified. Only completed, scheduled regular-
 * season sets are used; unlinked/manual or playoff matches are not guessed.
 */
export function buildDivisionMvpTieBreakAudit({ officialMvp = [], matches = [], schedule = [] } = {}) {
  const ranked = (officialMvp ?? []).filter(player =>
    player?.num != null && !String(player.num).startsWith("manual:") &&
    Number.isFinite(Number(player.mvpRanking))
  );
  if (ranked.length < 2) return [];
  const highest = Math.max(...ranked.map(player => Number(player.mvpRanking)));
  const tied = ranked.filter(player => Number(player.mvpRanking) === highest);
  if (tied.length < 2) return [];

  const regularMatches = scheduledRegularMatches(matches, schedule);
  const stats = new Map(tied.map(player => [String(player.num), {
    player, headToHeadPoints: 0, headToHeadSets: 0, headToHeadEncountered: false, headToHeadComplete: true,
    opponentRatingTotal: 0, opponentRatingCount: 0, opponentRatingsComplete: true,
    opponentSets: 0,
  }]));

  for (const match of regularMatches) {
    const format = match.state.format ?? match.format ?? "masters";
    for (const set of match.state.sets ?? []) {
      if (!set.complete || set.forfeited) continue;
      const homeNum = playerNum(set.playerHome);
      const awayNum = playerNum(set.playerAway);
      if (!homeNum || !awayNum) continue;
      const homeRating = Number(set.playerHome?.rating);
      const awayRating = Number(set.playerAway?.rating);
      const homeStats = stats.get(homeNum);
      const awayStats = stats.get(awayNum);
      if (homeStats) {
        homeStats.opponentSets += 1;
        if (Number.isFinite(awayRating) && awayRating > 0) {
          homeStats.opponentRatingTotal += awayRating;
          homeStats.opponentRatingCount += 1;
        } else homeStats.opponentRatingsComplete = false;
      }
      if (awayStats) {
        awayStats.opponentSets += 1;
        if (Number.isFinite(homeRating) && homeRating > 0) {
          awayStats.opponentRatingTotal += homeRating;
          awayStats.opponentRatingCount += 1;
        } else awayStats.opponentRatingsComplete = false;
      }
      if (homeStats && awayStats) {
        homeStats.headToHeadEncountered = true;
        awayStats.headToHeadEncountered = true;
        const homePoints = individualSetPoints(set, "home", format);
        const awayPoints = individualSetPoints(set, "away", format);
        if (homePoints == null || awayPoints == null) {
          homeStats.headToHeadComplete = false;
          awayStats.headToHeadComplete = false;
        } else {
          homeStats.headToHeadPoints += homePoints;
          awayStats.headToHeadPoints += awayPoints;
          homeStats.headToHeadSets += 1;
          awayStats.headToHeadSets += 1;
        }
      }
    }
  }

  const rows = [...stats.values()].map(stat => {
    const hasHeadToHead = stat.headToHeadEncountered;
    const headToHeadPoints = hasHeadToHead && stat.headToHeadComplete && stat.headToHeadSets > 0 ? stat.headToHeadPoints : null;
    const averageOpponentRating = stat.opponentSets > 0 &&
      stat.opponentRatingsComplete && stat.opponentRatingCount === stat.opponentSets
      ? stat.opponentRatingTotal / stat.opponentRatingCount : null;
    return {
      num: stat.player.num, name: stat.player.name, teamNum: stat.player.teamNum,
      officialPosition: stat.player.position, officialMvpRanking: stat.player.mvpRanking,
      headToHeadPoints, headToHeadSets: stat.headToHeadSets,
      averageOpponentRating, opponentSets: stat.opponentSets,
      headToHeadStatus: !hasHeadToHead ? "No regular-season head-to-head set found" :
        headToHeadPoints == null ? "Incomplete head-to-head scoring data" : "Available",
      opponentRatingStatus: averageOpponentRating == null
        ? "Incomplete opponent rating history" : "Available",
    };
  });

  const headToHeadValues = rows.map(row => row.headToHeadPoints);
  const hasHeadToHead = rows.some(row => row.headToHeadStatus !== "No regular-season head-to-head set found");
  let outcome = "insufficient-data";
  let explanation = "Available match or rating data is incomplete; the tie-break cannot be determined from the records currently stored.";
  const headToHeadComplete = headToHeadValues.every(value => value != null);
  const headToHeadResolved = headToHeadComplete && hasHeadToHead && new Set(headToHeadValues).size > 1;
  const headToHeadTied = headToHeadComplete && hasHeadToHead && new Set(headToHeadValues).size === 1;

  if (headToHeadResolved) {
    outcome = "head-to-head-points";
    explanation = "The player with more individual points in their regular-season head-to-head set(s) wins.";
  } else if ((!hasHeadToHead || headToHeadTied) && headToHeadComplete) {
    const ratings = rows.map(row => row.averageOpponentRating);
    if (ratings.every(value => value != null)) {
      const difference = Math.abs(ratings[0] - ratings[1]);
      if (difference >= 5) {
        outcome = "opponent-rating-average";
        explanation = "The player with the higher average opponent rating wins (difference of at least 5).";
      } else {
        outcome = "single-set-playoff-required";
        explanation = "The head-to-head and opponent-rating tie-breaks do not resolve the tie; a single set is required.";
      }
    }
  }
  return [{ players: rows, outcome, explanation }];
}
