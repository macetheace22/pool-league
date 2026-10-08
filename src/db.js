}

// ─── Match history (archive) ────────────────────────────────────────────────
// Pure transformation used by archiveMatch. Keeping this separate makes the
// highest-risk completion rules testable without writing anything to Supabase.
export function buildCompletedMatchRow(state, divisionId) {
  const isMakeup = !!(state.makeup?.confirmedHome && state.makeup?.confirmedAway);
  const completedCount = (state.sets ?? []).filter(s => s.complete).length;
  // A makeup match keeps the real score for whatever tables were actually
  // played (matchSideTotal only counts complete sets already) -- totals only
  // go null when literally nothing was played, so there's no misleading 0-0.
  const homeTotal = isMakeup && completedCount === 0 ? null : matchSideTotal(state, "home");
  const awayTotal = isMakeup && completedCount === 0 ? null : matchSideTotal(state, "away");
  const { homePoints, awayPoints } = computeMatchPoints(state);
  return {
    division_id: divisionId ?? null,
    season_id: state.seasonId ?? null,
    season_label: state.seasonLabel ?? null,
    week_num: state.weekNum ?? null,
    week_date: state.weekDate ?? null,
    venue: state.venue ?? null,
    format: state.format ?? "masters",
    team_home_id: state.teamHome?.id ?? null,
    team_away_id: state.teamAway?.id ?? null,
    team_home_name: state.teamHome?.name ?? "",
    team_away_name: state.teamAway?.name ?? "",
    team_home_total: homeTotal,
    team_away_total: awayTotal,
    team_home_points: isMakeup && completedCount === 0 ? null : homePoints,
    team_away_points: isMakeup && completedCount === 0 ? null : awayPoints,
    state,
    source: "live",
    is_makeup_pending: isMakeup,
  };
}

// Only a first successful archive or a pending-makeup -> final transition
// may trigger bracket advancement. Duplicate submissions are explicitly inert.
export function shouldAdvanceBracketOnArchive({ outcome, priorPending = false, isPending = false } = {}) {
  if (outcome === "created") return !isPending;
  if (outcome === "updated") return priorPending && !isPending;
  return false;
}

// Builds and persists a completed_matches row from a finished live_match state.
// Called once both sides have confirmed in Live Entry.
export async function archiveMatch(state, divisionId) {
  const row = buildCompletedMatchRow(state, divisionId);
  // Resuming a makeup updates its existing archive row. Only advance the
  // bracket if this update transitions a pending makeup to a final result.
  if (state.resumingMatchId) {
    const { data: prior } = await supabase.from("completed_matches")
      .select("is_makeup_pending").eq("id", state.resumingMatchId).maybeSingle();
    const updateRow = { ...row, reopened_at: null, reopened_by: null };
    const { data, error } = await supabase.from("completed_matches").update(updateRow).eq("id", state.resumingMatchId).select().single();
    if (error || !data) return null;
    return { ...data, _archiveOutcome: "updated", _shouldAdvanceBracket: shouldAdvanceBracketOnArchive({ outcome: "updated", priorPending: !!prior?.is_makeup_pending, isPending: data.is_makeup_pending }) };
  }

  const { data, error } = await supabase.from("completed_matches").insert(row).select().single();
  if (!error && data) {
    return { ...data, _archiveOutcome: "created", _shouldAdvanceBracket: shouldAdvanceBracketOnArchive({ outcome: "created", isPending: data.is_makeup_pending }) };
  }

  // A unique partial index makes concurrent submissions for the same
  // schedule pairing converge on one row. Return the winner's row but mark
  // it as existing so a second scorer never advances the bracket again.
  if (error?.code === "23505" && state.schedulePairingId) {
    const { data: existing } = await supabase.from("completed_matches")
      .select("*").eq("source", "live")
      .filter("state->>schedulePairingId", "eq", String(state.schedulePairingId))
      .maybeSingle();
    if (existing) return { ...existing, _archiveOutcome: "existing", _shouldAdvanceBracket: shouldAdvanceBracketOnArchive({ outcome: "existing", isPending: existing.is_makeup_pending }) };
  }
  return null;
}

// Sets won per side -- the simplest, format-agnostic "who won the match" total.
// (Full point-value scoring with margin/add-on/win-bonus/rating-bonus lives in
// the scoresheet view itself, computed from the same state at render time.)
// ─── Forfeit points ─────────────────────────────────────────────────────────
// Same lookup used live in LiveEntryApp.jsx -- kept here too since the