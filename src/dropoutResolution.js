export const DROPOUT_REMEDIES = [
  { value: "wipe_prior_matches", label: "Wipe selected/all past matches" },
  { value: "award_average_points", label: "Award average points" },
  { value: "convert_future_byes", label: "Convert affected future schedule entries to BYEs" },
  { value: "award_max_points_against", label: "Award maximum points scored against the dropout" },
  { value: "other", label: "Other management resolution" },
];

export function normalizeDropoutPreview(preview) {
  return {
    teamId: preview?.teamId ?? null,
    teamName: preview?.teamName ?? "",
    effectiveDate: preview?.effectiveDate ?? null,
    completedMatchCount: Number(preview?.completedMatchCount ?? 0),
    futureScheduleWeekCount: Number(preview?.futureScheduleWeekCount ?? 0),
    affectedMatchIds: Array.isArray(preview?.affectedMatchIds) ? preview.affectedMatchIds : [],
    affectedScheduleWeekIds: Array.isArray(preview?.affectedScheduleWeekIds) ? preview.affectedScheduleWeekIds : [],
  };
}

export function validateDropoutResolution({ seasonId, divisionId, teamId, effectiveDate, remedies, note }) {
  if (!seasonId || !divisionId || !teamId) return "Season, division, and dropout team are required.";
  if (!effectiveDate) return "Effective dropout date is required.";
  if (!Array.isArray(remedies) || remedies.length === 0) return "Select at least one management remedy.";
  if (remedies.includes("other") && !String(note ?? "").trim()) return "A note is required for an Other management resolution.";
  return null;
}
