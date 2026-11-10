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

// Each entry in games is one completed game within the set. Points accumulate
// only after a game is entered. If both players reach their targets in the
// same game, Section 6.7 makes that game's actual winner—not the point
// differential—the set winner.
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
      return game.gameWinner === "home" || game.gameWinner === "away"
        ? game.gameWinner
        : null;
    }
    if (homeReached) return "home";
    if (awayReached) return "away";
  }

  return null;
}
