export const REPLACEMENT_MAKEUP_LIMIT = 3;

export function normalizeReplacementPreview(raw = {}) {
  return {
    dropoutTeamId: raw.dropoutTeamId ?? null,
    dropoutTeamName: raw.dropoutTeamName ?? "",
    replacementTeamId: raw.replacementTeamId ?? null,
    replacementTeamName: raw.replacementTeamName ?? "",
    effectiveDate: raw.effectiveDate ?? null,
    eligibleMakeupWeekCount: Number(raw.eligibleMakeupWeekCount ?? 0),
    eligibleMakeupWeekIds: Array.isArray(raw.eligibleMakeupWeekIds) ? raw.eligibleMakeupWeekIds : [],
  };
}

export function validateReplacementResolution({
  dropoutResolutionId,
  seasonId,
  divisionId,
  replacementTeamId,
  effectiveDate,
  preview,
  inheritedStandings,
}) {
  if (!dropoutResolutionId || !seasonId || !divisionId || !replacementTeamId) {
    return "Dropout resolution, season, division, and replacement team are required.";
  }
  if (!effectiveDate) return "Effective replacement date is required.";
  if (!preview) return "Preview the replacement impact before recording it.";
  if (!inheritedStandings || typeof inheritedStandings !== "object" || Array.isArray(inheritedStandings)) {
    return "Inherited standings must be recorded as a structured snapshot.";
  }
  if (replacementTeamId === preview.dropoutTeamId) return "Replacement team must differ from the dropout team.";
  if (preview.eligibleMakeupWeekIds.length > REPLACEMENT_MAKEUP_LIMIT) {
    return "No more than three makeup weeks may be recorded.";
  }
  return "";
}
