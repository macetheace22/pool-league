// IBA Rule 5.5: a regular-season dead heat remains a tie. In postseason,
 // a dead heat after the scheduled five sets is awarded to the team that won
 // at least three sets. Point totals remain the primary match result.
export function resolveTeamMatchWinner({ homePoints = 0, awayPoints = 0, homeSets = 0, awaySets = 0, isPlayoff = false, completedSets = 5, gladiatorSet = null } = {}) {
  if (isPlayoff && gladiatorSet?.complete && gladiatorSet?.isGladiator && (gladiatorSet.winnerSlot === "home" || gladiatorSet.winnerSlot === "away")) return gladiatorSet.winnerSlot;
  if (homePoints > awayPoints) return "home";
  if (awayPoints > homePoints) return "away";
  if (!isPlayoff || completedSets !== 5) return null;
  if (homeSets >= 3 && homeSets + awaySets === 5) return "home";
  if (awaySets >= 3 && homeSets + awaySets === 5) return "away";
  return null;
}
