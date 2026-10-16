export async function fetchIbaReports(season, reportType = null) {
  const { leagueType, day } = ibaCodesForSeason(season);
  if (!leagueType || !day) throw new Error("The selected season must have a supported format and day.");
  const response = await fetch("/api/iba-reports", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reportType ? { reports: [{ leagueType, day, reportType }] } : { leagueType, day }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not retrieve IBA reports.");
  return { ...body, leagueType, day };
}

const ALL_LEAGUE_TYPES = ["mast", "adv", "open"];
const ALL_DAYS = ["mon", "tues", "wed", "thur", "fri", "sat", "sun"];
const REPORT_TYPE_LABELS = { rost: "Roster & ratings", div: "Team standings", mvp: "MVP standings" };

export async function fetchAllIbaReports(onProgress = () => {}) {
  const groups = ALL_LEAGUE_TYPES.flatMap(leagueType =>
    ALL_DAYS.map(day => ({ leagueType, day }))
  );
  const results = [];
  // Limit concurrency to avoid opening 63 PDF requests at once.
  for (let i = 0; i < groups.length; i += 3) {
    const batch = groups.slice(i, i + 3);
    const fetched = await Promise.all(batch.map(async ({ leagueType, day }) => {
      const response = await fetch("/api/iba-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagueType, day }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not retrieve IBA reports for ${leagueType}/${day}.`);
      return (body.reports || []).map(report => ({
        ...report,
        formatLabel: ({ mast: "Masters", adv: "Advanced", open: "Open" })[leagueType],
        dayLabel: ({ mon: "Monday", tues: "Tuesday", wed: "Wednesday", thur: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" })[day],
        reportLabel: REPORT_TYPE_LABELS[report.reportType] || report.reportType,
      }));
    }));
    fetched.forEach(items => results.push(...items));
    onProgress({ completedGroups: Math.min(i + batch.length, groups.length), totalGroups: groups.length, reports: results.length });
  }
  return { generatedAt: new Date().toISOString(), reports: results };
}
