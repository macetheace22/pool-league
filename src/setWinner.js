// Pure scoring helpers for IBA individual-set completion.
const UNRATED_MAX = 2;

function isUnrated(rating) {
  return rating != null && rating <= UNRATED_MAX;
}

export function effectiveSetTarget(player, otherPlayer, format) {
  if (isUnrated(player?.rating) || isUnrated(otherPlayer?.rating)) {
    return (format || "masters").toLowerCase() === "open" ? 45 : 50;
  }
  return player?.rating ?? null;
}

// Each rack is one completed 8-ball game. The game's recorded points include
// the winner's game bonus, so the higher per-game score identifies its winner.
export function detectSetWinner(games, playerHome, playerAway, format) {
  if (playerHome?.rating == null || playerAway?.rating == null) return null;

  const targetHome = effectiveSetTarget(playerHome, playerAway, format);
  const targetAway = effectiveSetTarget(playerAway, playerHome, format);
  let runHome = 0;
  let runAway = 0;

  for (const game of games ?? []) {
    const pointsHome = Number(game.home ?? 0);
    const pointsAway = Number(game.away ?? 0);
    runHome += pointsHome;
    runAway += pointsAway;

    const homeReached = runHome >= targetHome;
    const awayReached = runAway >= targetAway;

    if (homeReached && awayReached) {
      if (pointsHome > pointsAway) return "home";
      if (pointsAway > pointsHome) return "away";
      return game.tiebreak === "home" || game.tiebreak === "away" ? game.tiebreak : null;
    }
    if (homeReached) return "home";
    if (awayReached) return "away";
  }

  return null;
}
