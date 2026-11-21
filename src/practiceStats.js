// Practice-only game-type scoping shared by My Stats result totals, history, and shot events.
// Skills & Drills sessions are intentionally excluded from opponent game records.
export function filterPracticeGamesByType(games, gameTypes = null) {
  const selected = Array.isArray(gameTypes) ? gameTypes : gameTypes ? [gameTypes] : null;
  return (games ?? []).filter(game =>
    game.practice_type !== "skills_drills" && (!selected || selected.includes(game.game_type))
  );
}

export function matchesPracticeGameType(event, gameTypes = null) {
  if (event.context_type !== "practice_game" || !gameTypes) return true;
  const selected = Array.isArray(gameTypes) ? gameTypes : [gameTypes];
  return selected.includes(event.game_type);
}
