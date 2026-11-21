// Viewer-specific presentation helpers for shared practice history.
// Source rows remain stored from the original creator's perspective.
export function reversePracticeWinner(winner) {
  if (winner === "me") return "opponent";
  if (winner === "opponent") return "me";
  return winner ?? null;
}

export function toLinkedPracticeGame(game, owner = {}) {
  return {
    ...game,
    viewer_perspective: "linked",
    owner_profile_id: game.created_by ?? null,
    owner_display_name: owner.display_name ?? null,
    owner_player_num: owner.player_num ?? null,
    opponent_name: owner.display_name || game.opponent_name,
    my_score: game.opponent_score ?? 0,
    opponent_score: game.my_score ?? 0,
    winner: reversePracticeWinner(game.winner),
  };
}

export function toPracticeResultPerspective(result, isLinkedViewer) {
  if (!isLinkedViewer) return result;
  return {
    ...result,
    my_points: result.opponent_points,
    opponent_points: result.my_points,
    winner: reversePracticeWinner(result.winner),
  };
}
