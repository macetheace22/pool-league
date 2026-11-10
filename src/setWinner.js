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

// Each rack is one completed game. When both players reach their targets
// during the same game, the winner of that final game wins the set.
export function detectSetWinner(games, playerHome, playerAway, format) {
  if (playerHome?.rating == null || playerAway?.rating == null) return null;

  const targetHome = effectiveSetTarget(playerHome, playerAway, format);
  const targetAway = effectiveSetTarget(playerAway, playerHome, format);
  let runHome = 0;
  let runAway = 0;

  for (const game of games ?? []) {
    runHome += Number(game.home ?? 0);
    runAway += Number(game.away ?? 0);

    const homeReached = runHome >= targetHome;
    const awayReached = runAway >= targetAway;

    if (homeReached && awayReached) {
      return game.home > game.away ? "home" : game.away > game.home ? "away" : game.tiebreak ?? "home";
    }
    if (homeReached) return "home";
    if (awayReached) return "away";
  }

  return null;
}
