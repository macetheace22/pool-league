// Display-only labels for set states in the live match summary.
// A pending makeup is not a final unplayed result; forfeits are final.
export function liveSetDisposition(set, makeupPending = false) {
  if (set?.forfeited) return `FORFEIT · ${set.forfeitPoints ?? 0}pt`;
  if (set?.complete) return null;
  if (makeupPending) return "AWAITING MAKEUP";
  if (Array.isArray(set?.racks) && set.racks.length > 0) return "IN PROGRESS";
  return "UNPLAYED";
}
