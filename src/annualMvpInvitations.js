const MVP_FORMAT_ORDER = ["Open", "Advanced", "Masters"];

function normalizedMvpFormat(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "open") return "Open";
  if (normalized === "advanced" || normalized === "adv") return "Advanced";
  if (normalized === "masters" || normalized === "master") return "Masters";
  return null;
}

/**
 * Build the Annual MVP Tournament invitation audit from official, already
 * validated division MVP standings. Each player receives one invitation in
 * their highest qualifying format; multiple divisions in that same format
 * are retained as provenance, not duplicate invitations.
 */
export function buildAnnualMvpTournamentInvitations(divisionResults = []) {
  const candidates = new Map();
  const divisionIssues = [];
  const identityReview = [];
  const formatRank = new Map(MVP_FORMAT_ORDER.map((format, index) => [format, index]));

  for (const result of divisionResults ?? []) {
    const division = result?.division ?? {};
    const divisionLabel = division.name || (division.num != null ? `Division ${division.num}` : "Unknown division");
    const format = normalizedMvpFormat(division.format);
    if (!format) {
      divisionIssues.push({ divisionId: division.id ?? null, divisionLabel, issue: `Unknown IBA format: ${division.format ?? "missing"}` });
      continue;
    }
    if (result?.error) {
      divisionIssues.push({ divisionId: division.id ?? null, divisionLabel, format, issue: result.error });
      continue;
    }
    const standings = result?.standings ?? [];
    if (!standings.length) {
      divisionIssues.push({ divisionId: division.id ?? null, divisionLabel, format, issue: "No official IBA MVP report is available for this division." });
      continue;
    }

    for (const row of standings.filter(item => Number.isInteger(item.position) && item.position >= 1 && item.position <= 15)) {
      const playerNum = row.num != null && !String(row.num).startsWith("manual:") ? String(row.num) : null;
      const qualification = {
        divisionId: division.id ?? null,
        divisionLabel,
        format,
        position: row.position,
        playerNum,
        playerName: row.name ?? "Unknown player",
        teamNum: row.teamNum ?? null,
        reportWeek: row.weekKey ?? null,
      };
      if (!playerNum) {
        identityReview.push({ ...qualification, issue: "Player number is not linked to a registered player; identity must be resolved before assigning a single-format invitation." });
        continue;
      }
      if (!candidates.has(playerNum)) candidates.set(playerNum, []);
      candidates.get(playerNum).push(qualification);
    }
  }

  const invitationsByFormat = Object.fromEntries(MVP_FORMAT_ORDER.map(format => [format, []]));
  const crossFormatResolutions = [];
  for (const [playerNum, qualifications] of candidates) {
    const highestRank = Math.max(...qualifications.map(row => formatRank.get(row.format)));
    const eligibleFormat = MVP_FORMAT_ORDER[highestRank];
    const eligibleQualifications = qualifications.filter(row => row.format === eligibleFormat)
      .sort((a, b) => a.position - b.position || a.divisionLabel.localeCompare(b.divisionLabel));
    const lowerFormatQualifications = qualifications.filter(row => row.format !== eligibleFormat);
    const best = eligibleQualifications[0];
    invitationsByFormat[eligibleFormat].push({
      playerNum,
      playerName: best.playerName,
      eligibleFormat,
      position: best.position,
      teamNum: best.teamNum,
      qualifyingDivisions: eligibleQualifications,
      alsoQualifiedIn: [...new Set(lowerFormatQualifications.map(row => row.format))],
    });
    if (lowerFormatQualifications.length) {
      crossFormatResolutions.push({
        playerNum,
        playerName: best.playerName,
        eligibleFormat,
        suppressedFormats: [...new Set(lowerFormatQualifications.map(row => row.format))],
        qualifications: qualifications,
      });
    }
  }

  for (const format of MVP_FORMAT_ORDER) {
    invitationsByFormat[format].sort((a, b) => a.position - b.position || a.playerName.localeCompare(b.playerName));
  }
  return {
    complete: (divisionResults ?? []).length > 0 && divisionIssues.length === 0,
    divisionCount: (divisionResults ?? []).length,
    divisionIssues,
    invitationsByFormat,
    crossFormatResolutions,
    identityReview,
    totalInvitations: MVP_FORMAT_ORDER.reduce((sum, format) => sum + invitationsByFormat[format].length, 0),
  };
}
