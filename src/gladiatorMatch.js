// Rule 5.5 Gladiator matches are available only in postseason, before
// five sets have been played, and only when each team can field a previously
// played player for the sudden-death set.
export function canOfferGladiatorMatch({ isPlayoff = false, sets = [], setIdx = -1, homePoints = null, awayPoints = null } = {}) {
  if (!isPlayoff || setIdx < 1 || setIdx >= 5) return false;
  if (homePoints != null && awayPoints != null && homePoints !== awayPoints) return false;
  const prior = sets.slice(0, setIdx);
  if (!prior.length || prior.some(set => !set?.complete || set?.forfeited || set?.isGladiator)) return false;
  if (!prior.some(set => set?.playerHome && set?.playerAway)) return false;
  const later = sets.slice(setIdx + 1);
  if (later.some(set => set?.complete || set?.playerHome || set?.playerAway || (set?.racks?.length ?? 0) > 0)) return false;
  const current = sets[setIdx];
  if (!current || current.complete || (current.racks ?? []).length > 0) return false;
  if (!gladiatorPlayerChoices(sets, setIdx, "home").length || !gladiatorPlayerChoices(sets, setIdx, "away").length) return false;
  return true;
}

export function gladiatorPlayerChoices(sets = [], setIdx = -1, side = "home") {
  const key = side === "home" ? "playerHome" : "playerAway";
  const byNum = new Map();
  for (const set of sets.slice(0, setIdx)) {
    if (!set?.complete || set?.forfeited || !["home", "away"].includes(set?.winnerSlot)) continue;
    const player = set[key];
    if (player?.num != null && !byNum.has(String(player.num))) byNum.set(String(player.num), player);
  }
  return [...byNum.values()];
}

export function createGladiatorSet(set, setIdx, homePlayer, awayPlayer) {
  if (!set || !homePlayer?.num || !awayPlayer?.num) return null;
  return {
    ...set,
    setNum: setIdx + 1,
    playerHome: homePlayer,
    playerAway: awayPlayer,
    racks: [],
    winnerSlot: null,
    complete: false,
    forfeited: false,
    isGladiator: true,
  };
}
