// IBA Section 2.7 coaching time-out allowance.
// The allowance is per player, per set. NR uses the lowest tier for the format.
export function isTimeoutEligibleFormat(format) {
  return format === "open" || format === "advanced";
}

export function timeoutAllowance(format, rating) {
  const fmt = (format || "").toLowerCase();
  if (fmt === "masters") return 0;
  if (fmt === "open") {
    // Ratings 30-50 receive two coaching periods; 51+ receive one.
    // NR is represented by the app's low rating values (<=2) and uses the
    // lowest Open tier.
    return rating != null && rating > 50 ? 1 : 2;
  }
  if (fmt === "advanced") {
    // Advanced has one coaching period for rated players and the same
    // lowest available tier for NR.
    return 1;
  }
  return 0;
}

export function timeoutCount(set, side) {
  const boolKey = side === "home" ? "timeoutHome" : "timeoutAway";
  const countKey = side === "home" ? "timeoutHomeCount" : "timeoutAwayCount";
  return (set?.racks || []).reduce((count, rack) => {
    // New records store the number of timeouts in a rack. Fall back to the
    // legacy boolean marker so existing saved matches remain fully readable.
    const rackCount = Number.isFinite(rack?.[countKey]) ? Math.max(0, rack[countKey]) : (rack?.[boolKey] ? 1 : 0);
    return count + rackCount;
  }, 0);
}

export function timeoutRemaining(set, side, format) {
  const player = side === "home" ? set?.playerHome : set?.playerAway;
  const allowance = timeoutAllowance(format, player?.rating);
  return Math.max(0, allowance - timeoutCount(set, side));
}
