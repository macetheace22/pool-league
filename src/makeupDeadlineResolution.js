import { supabase } from "./supabaseClient";
import {
  buildFullMatchForfeitSets,
  computeMatchPoints,
  listRosterForTeam,
} from "./db";

function uniquePlayerNums(players) {
  return (players ?? []).map(p => String(p?.num ?? "").trim()).filter(Boolean);
}

function assertFiveUniquePlayers(players, label) {
  const nums = uniquePlayerNums(players);
  if (nums.length !== 5 || new Set(nums).size !== 5) {
    throw new Error(`${label} must contain five different players.`);
  }
}

function playedPlayerNums(match) {
  return new Set(
    (match.state?.sets ?? []).flatMap(set => [
      set?.playerHome?.num,
      set?.playerAway?.num,
    ].filter(Boolean).map(String)),
  );
}

export async function resolveMakeupDeadline({
  matchId,
  outcome,
  responsibleSide = null,
  note = "",
  forfeitingPlayers = [],
  receivingPlayers = [],
}) {
  if (!matchId) throw new Error("A match is required.");
  if (outcome === "team_responsible") {
    assertFiveUniquePlayers(forfeitingPlayers, "Forfeiting players");
    assertFiveUniquePlayers(receivingPlayers, "Receiving players");
  }

  const { data: match, error: matchError } = await supabase
    .from("completed_matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();
  if (matchError || !match) throw new Error(matchError?.message ?? "MATCH_NOT_FOUND");
  if (!match.is_makeup_pending) throw new Error("MAKEUP_NOT_PENDING");

  if (outcome === "no_agreement") {
    const { data, error } = await supabase.rpc("resolve_makeup_deadline", {
      p_match_id: matchId,
      p_outcome: outcome,
      p_responsible_side: null,
      p_note: note || null,
      p_state: match.state ?? {},
      p_home_total: match.team_home_total ?? 0,
      p_away_total: match.team_away_total ?? 0,
      p_home_points: 0,
      p_away_points: 0,
    });
    if (error) throw error;
    return data;
  }

  if (![ "home", "away" ].includes(responsibleSide)) {
    throw new Error("RESPONSIBLE_SIDE_REQUIRED");
  }

  const [forfeitingRoster, receivingRoster] = await Promise.all([
    listRosterForTeam(responsibleSide === "home" ? match.team_home_id : match.team_away_id),
    listRosterForTeam(responsibleSide === "home" ? match.team_away_id : match.team_home_id),
  ]);
  const forfeitingRosterNums = new Set(forfeitingRoster.map(player => String(player.num)));
  const receivingRosterNums = new Set(receivingRoster.map(player => String(player.num)));
  const played = playedPlayerNums(match);

  for (const player of forfeitingPlayers) {
    if (!forfeitingRosterNums.has(String(player.num))) {
      throw new Error(`PLAYER_NOT_ON_ROSTER:${player.num}`);
    }
    if (played.has(String(player.num))) {
      throw new Error(`PLAYER_ALREADY_PLAYED:${player.num}`);
    }
  }
  for (const player of receivingPlayers) {
    if (!receivingRosterNums.has(String(player.num))) {
      throw new Error(`PLAYER_NOT_ON_ROSTER:${player.num}`);
    }
    if (played.has(String(player.num))) {
      throw new Error(`PLAYER_ALREADY_PLAYED:${player.num}`);
    }
  }

  const matchLike = {
    format: match.state?.format ?? match.format ?? "masters",
    weekDate: match.week_date,
    playoffsStartDate: match.state?.playoffsStartDate ?? null,
  };
  const forfeitedSets = buildFullMatchForfeitSets(
    matchLike,
    responsibleSide,
    forfeitingPlayers,
    receivingPlayers,
  );
  const nextState = {
    ...(match.state ?? {}),
    sets: forfeitedSets,
    fullMatchForfeit: {
      forfeitingSide: responsibleSide,
      reason: "section_8_5_makeup_deadline",
    },
    phase: "confirm",
    makeupDeadlineResolution: {
      outcome,
      responsibleSide,
      note: String(note ?? "").trim() || null,
    },
  };
  const { homePoints, awayPoints } = computeMatchPoints(nextState, { makeupPending: false });

  const { data, error } = await supabase.rpc("resolve_makeup_deadline", {
    p_match_id: matchId,
    p_outcome: outcome,
    p_responsible_side: responsibleSide,
    p_note: note || null,
    p_state: nextState,
    p_home_total: responsibleSide === "home" ? 0 : 5,
    p_away_total: responsibleSide === "away" ? 0 : 5,
    p_home_points: homePoints,
    p_away_points: awayPoints,
  });
  if (error) throw error;
  return data;
}
