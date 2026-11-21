// Converts a league match into the selected player's perspective for personal history.
// Stored results remain in their original home/away orientation; only the returned
// presentation copy is reversed when the selected player played for the away team.
const HOME_AWAY_KEY_PAIRS = [
  ["team_home_id", "team_away_id"],
  ["team_home_name", "team_away_name"],
  ["team_home_total", "team_away_total"],
  ["team_home_points", "team_away_points"],
  ["teamHome", "teamAway"],
  ["playerHome", "playerAway"],
  ["home", "away"],
  ["homeTotal", "awayTotal"],
  ["homePoints", "awayPoints"],
  ["safetyHome", "safetyAway"],
  ["timeoutHomeCount", "timeoutAwayCount"],
  ["timeoutHome", "timeoutAway"],
  ["pointsHome", "pointsAway"],
];

const HOME_AWAY_VALUE_KEYS = new Set([
  "winnerSlot",
  "forfeitedBy",
  "shortTeam",
  "proposedByTeam",
  "playerSide",
  "team",
]);

function oppositeSide(value) {
  if (value === "home") return "away";
  if (value === "away") return "home";
  return value;
}

function reverseHomeAway(value) {
  if (Array.isArray(value)) return value.map(reverseHomeAway);
  if (!value || typeof value !== "object") return value;

  const reversed = {};
  const pairedKeys = new Set(HOME_AWAY_KEY_PAIRS.flat());
  for (const [key, child] of Object.entries(value)) {
    if (pairedKeys.has(key)) continue;
    reversed[key] = HOME_AWAY_VALUE_KEYS.has(key)
      ? oppositeSide(child)
      : reverseHomeAway(child);
  }

  for (const [homeKey, awayKey] of HOME_AWAY_KEY_PAIRS) {
    if (Object.prototype.hasOwnProperty.call(value, homeKey)) {
      reversed[awayKey] = reverseHomeAway(value[homeKey]);
    }
    if (Object.prototype.hasOwnProperty.call(value, awayKey)) {
      reversed[homeKey] = reverseHomeAway(value[awayKey]);
    }
  }
  return reversed;
}

export function toPlayerMatchPerspective(match) {
  if (!match || match.playerSide !== "away") return match;
  return reverseHomeAway(match);
}
