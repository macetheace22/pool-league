// Practice-only game-type scoping shared by My Stats result totals, history, and shot events.
// Skills & Drills sessions are intentionally excluded from opponent game records.
export function filterPracticeGamesByType(games, gameType = null) {
  return (games ?? []).filter(game =>
    game.practice_type !== "skills_drills" && (!gameType || game.game_type === gameType)
  );
}

export function matchesPracticeGameType(event, gameType = null) {
  return event.context_type !== "practice_game" || !gameType || event.game_type === gameType;
}
