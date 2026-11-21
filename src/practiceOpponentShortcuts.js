// Build stable shortcuts from prior completed Practice history and saved manual opponents.
// League identities are keyed by IBA player number; guest identities by practice_opponents.id.
export function buildPracticeOpponentShortcuts(history = [], manualOpponents = []) {
  const playersByNum = new Map();
  for (const game of history) {
    if (!game || game.practice_type === "skills_drills") continue;
    const isLinkedViewer = game.viewer_perspective === "linked";
    const playerNum = isLinkedViewer ? (game.owner_player_num ?? game.player_num) : game.opponent_player_num;
    if (!playerNum) continue;
    const key = String(playerNum);
    const playedAt = game.played_at ?? game.completed_at ?? game.created_at ?? null;
    const existing = playersByNum.get(key);
    if (!existing || new Date(playedAt ?? 0).getTime() > new Date(existing.playedAt ?? 0).getTime()) {
      playersByNum.set(key, {
        key: `player:${key}`,
        type: "player",
        num: key,
        name: isLinkedViewer
          ? (game.owner_display_name || game.display_name || game.opponent_name || `Player ${key}`)
          : (game.opponent_name || `Player ${key}`),
        rating: isLinkedViewer ? (game.my_rating ?? null) : (game.opponent_rating ?? null),
        playedAt,
      });
    }
  }

  const manualById = new Map();
  for (const opponent of manualOpponents) {
    if (!opponent?.id || manualById.has(opponent.id)) continue;
    manualById.set(opponent.id, {
      key: `manual:${opponent.id}`,
      type: "manual",
      id: opponent.id,
      name: opponent.display_name || opponent.name,
      linked_profile_id: opponent.linked_profile_id ?? null,
    });
  }

  return [...playersByNum.values(), ...manualById.values()];
}
