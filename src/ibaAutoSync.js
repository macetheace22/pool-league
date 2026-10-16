import * as db from "./db";
import { classifyIbaReportImport, getValidatedScheduleWeekTag } from "./ibaImportValidation";
import { extractIbaReportWeek, extractIbaReportWeeksByDivision, parseLeagueRoster, parseStandingsImport, parseMvpImport } from "./ibaParsers";

const FORMAT_TO_CODE = { masters: "mast", advanced: "adv", open: "open" };
const DAY_TO_CODE = { monday: "mon", tuesday: "tues", wednesday: "wed", thursday: "thur", friday: "fri", saturday: "sat", sunday: "sun" };

function currentWeekTag(schedule) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const parseUS = value => {
    const m = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
  };
  const weeks = (schedule ?? []).filter(w => w.week && w.pairings?.length && !w.isPlayoff && !w.special);
  const current = weeks.find(w => { const d = parseUS(w.date); return d && d >= today; }) || weeks[weeks.length - 1] || null;
  if (!current) {
    const now = new Date();
    return { weekKey: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`, label: `As of ${now.toLocaleDateString()}` };
  }
  const d = parseUS(current.date);
  const weekKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  return { weekKey, label: `Week ${current.week} · ${current.date}` };
}

export function ibaCodesForSeason(season) {
  const format = String(season?.format || "").toLowerCase();
  const day = String(season?.day || "").toLowerCase();
  return { leagueType: FORMAT_TO_CODE[format] || null, day: DAY_TO_CODE[day] || null };
}

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

function groupByDivision(rows, activeTeamsByNum) {
  const groups = {};
  const skipped = [];
  for (const row of rows) {
    const matches = activeTeamsByNum[row.teamNum] || [];
    if (matches.length !== 1) {
      skipped.push({ ...row, reason: matches.length ? "Team number is ambiguous across active divisions" : "Team number not found in active teams" });
      continue;
    }
    const team = matches[0];
    (groups[team.divisionId] ??= { teams: [], rows: [] }).rows.push(row);
    if (!groups[team.divisionId].teams.some(t => t.id === team.id)) groups[team.divisionId].teams.push(team);
  }
  return { groups, skipped };
}


export async function validateIbaReports(reports, season) {
  const seasons = await db.listSeasons();
  const selected = (seasons ?? []).find(item => String(item.id) === String(season?.id));
  if (!selected) throw new Error("The selected season could not be reloaded. Refresh the page and retry.");
  const divisions = selected.divisions ?? [];
  if (!divisions.length) throw new Error("No divisions are configured for this season. Import its IBA schedule before weekly reports.");

  const checks = [];
  const weekTagsByReportDivision = {};
  for (const division of divisions) {
    const teams = await db.listTeams(division.id);
    const scheduledWeeks = await db.listSchedule(division.id, teams);
    const historyResult = await db.listIbaReportImportHistory(season.id, division.id);
    for (const report of (reports ?? []).filter(item => item.status === "ok")) {
      const reportMetadata = {
        reportWeek: extractIbaReportWeek(report.text),
        reportWeeksByDivision: extractIbaReportWeeksByDivision(report.text),
      };
      const classification = classifyIbaReportImport({
        reportType: report.reportType,
        divisionNum: division.num,
        reportMetadata,
        scheduledWeeks,
        history: historyResult.error ? null : historyResult.data,
        contentSha256: report.sha256,
      });
      const scheduledWeek = scheduledWeeks.find(item => Number(item.week) === Number(classification.week?.weekNumber));
      let status = classification.status;
      let reason = classification.reason;
      let weekTag = null;
      if (status === "ready") {
        weekTag = getValidatedScheduleWeekTag(classification.week.weekNumber, scheduledWeek?.date);
        if (!weekTag) {
          status = "blocked_schedule_date_unavailable";
          reason = "The matching schedule week has no valid date; import is blocked.";
        } else {
          weekTagsByReportDivision[`${report.reportType}:${division.id}`] = weekTag;
        }
      }
      checks.push({
        key: `${report.reportType}:${division.id}`,
        reportType: report.reportType,
        divisionId: division.id,
        divisionNum: String(division.num),
        divisionName: division.name,
        weekNumber: classification.week?.weekNumber ?? null,
        status,
        reason,
        weekTag,
      });
    }
  }
  const reportFailures = (reports ?? []).filter(report => report.status !== "ok");
  const allChecksReady = checks.length > 0 && checks.every(check => check.status === "ready" || check.status === "duplicate");
  return {
    checks,
    weekTagsByReportDivision,
    canImport: allChecksReady && reportFailures.length === 0,
    reportFailures: reportFailures.map(report => ({
      reportType: report.reportType,
      status: report.status,
      reason: report.message || "Report unavailable",
    })),
  };
}

export async function buildIbaPreview(reports) {
  const byType = Object.fromEntries((reports ?? []).map(r => [r.reportType, r]));
  const preview = { reports: [], roster: null, standings: null, mvp: null, errors: [] };
  for (const r of reports ?? []) {
    preview.reports.push({ key: r.key, reportType: r.reportType, status: r.status, pages: r.pages, bytes: r.bytes, message: r.message, reportWeek: r.status === "ok" ? extractIbaReportWeek(r.text) : null, reportWeeksByDivision: r.status === "ok" ? extractIbaReportWeeksByDivision(r.text) : null });
  }
  if (byType.rost?.status === "ok") {
    const parsed = parseLeagueRoster(byType.rost.text);
    preview.roster = { parsed, teamCount: Object.keys(parsed.rosters).length, playerCount: Object.keys(parsed.registry).length };
  }
  if (byType.div?.status === "ok") preview.standings = { rows: parseStandingsImport(byType.div.text) };
  if (byType.mvp?.status === "ok") preview.mvp = { rows: parseMvpImport(byType.mvp.text) };
  return preview;
}

export async function importIbaReports(reports, season, schedule, preflight) {
  if (!preflight?.canImport) throw new Error("Import blocked: complete the per-division validation checks before writing any data.");
  const weekTag = currentWeekTag(schedule);
  const importedDivisionIdsByType = { rost: [], div: [], mvp: [] };
  const recordHistory = async (report, reportType, divisionIds) => {
    const checks = preflight.checks.filter(check => check.reportType === reportType && divisionIds.includes(check.divisionId));
    for (const check of checks) {
      const saved = await db.recordIbaReportImportHistory({
        seasonId: season.id,
        divisionId: check.divisionId,
        reportType,
        reportWeek: check.weekNumber,
        contentSha256: report.sha256,
        source: "automatic",
        metadata: { reportKey: report.key, divisionNum: check.divisionNum, weekKey: check.weekTag?.weekKey },
      });
      if (!saved.ok) throw new Error(`Data was saved, but import history could not be recorded for division ${check.divisionNum}: ${saved.error}`);
    }
  };
  const result = { weekTag, roster: null, standings: null, mvp: null, warnings: [], skippedDuplicateDivisions: preflight.checks.filter(check => check.status === "duplicate").map(check => `${check.reportType.toUpperCase()} · Division ${check.divisionNum} · Week ${check.weekNumber}`) };
  const byType = Object.fromEntries((reports ?? []).map(r => [r.reportType, r]));

  if (byType.rost?.status === "ok") {
    const parsed = parseLeagueRoster(byType.rost.text);
    const readyRosterDivisions = new Set(preflight.checks.filter(check => check.reportType === "rost" && check.status === "ready").map(check => check.divisionId));
    const allRosterTeamNums = Object.keys(parsed.rosters ?? {});
    const rosterRouting = await db.listActiveTeamsByNumbers(allRosterTeamNums);
    const eligibleTeamNums = new Set(allRosterTeamNums.filter(teamNum => {
      const matches = rosterRouting.byNum[teamNum] || [];
      return matches.length === 1 && readyRosterDivisions.has(matches[0].divisionId);
    }));
    const eligiblePlayerNums = new Set([...eligibleTeamNums].flatMap(teamNum => parsed.rosters[teamNum] || []));
    const filteredParsed = {
      ...parsed,
      rosters: Object.fromEntries(Object.entries(parsed.rosters ?? {}).filter(([teamNum]) => eligibleTeamNums.has(teamNum))),
      teams: Object.fromEntries(Object.entries(parsed.teams ?? {}).filter(([teamNum]) => eligibleTeamNums.has(teamNum))),
      registry: Object.fromEntries(Object.entries(parsed.registry ?? {}).filter(([, player]) => eligiblePlayerNums.has(player.num))),
      needsRating: (parsed.needsRating ?? []).filter(player => eligiblePlayerNums.has(player.num)),
    };
    result.roster = eligibleTeamNums.size
      ? await db.bulkImportPlayers(filteredParsed, { byReportDivision: preflight.weekTagsByReportDivision, fallback: weekTag })
      : { updatedDivisions: [], unmatchedTeams: [], ambiguousTeamIds: [], skippedDuplicates: true };
    importedDivisionIdsByType.rost = (result.roster?.updatedDivisions ?? []).map(item => item.divisionId);
    if (importedDivisionIdsByType.rost.length) await recordHistory(byType.rost, "rost", importedDivisionIdsByType.rost);
    if (parsed.ambiguousRoster?.length) result.warnings.push(`${parsed.ambiguousRoster.length} roster assignments need review.`);
    if (result.roster?.ambiguousTeamIds?.length) result.warnings.push(`${result.roster.ambiguousTeamIds.length} team numbers matched more than one active division.`);
    if (result.roster?.unmatchedTeams?.length) result.warnings.push(`${result.roster.unmatchedTeams.length} team numbers were not matched to an active team.`);
  }

  const teamNums = [
    ...(byType.div?.status === "ok" ? parseStandingsImport(byType.div.text).map(r => r.teamNum) : []),
    ...(byType.mvp?.status === "ok" ? parseMvpImport(byType.mvp.text).map(r => r.teamNum) : []),
  ];
  const routing = await db.listActiveTeamsByNumbers([...new Set(teamNums)]);

  if (byType.div?.status === "ok") {
    const rows = parseStandingsImport(byType.div.text);
    const grouped = groupByDivision(rows, routing.byNum);
    result.standings = { imported: 0, skipped: grouped.skipped };
    for (const [divisionId, group] of Object.entries(grouped.groups)) {
      if (preflight.checks.some(check => check.reportType === "div" && check.divisionId === divisionId && check.status === "duplicate")) continue;
      const divisionWeekTag = preflight.weekTagsByReportDivision[`div:${divisionId}`];
      if (!divisionWeekTag) throw new Error(`Import blocked: no validated report week for division ${divisionId} standings.`);
      const ok = await db.importStandingsForWeek(divisionId, group.rows, group.teams, divisionWeekTag);
      if (!ok) throw new Error(`Could not save standings for division ${divisionId}.`);
      result.standings.imported += group.rows.length;
      if (group.rows.length) importedDivisionIdsByType.div.push(divisionId);
    }
    if (importedDivisionIdsByType.div.length) await recordHistory(byType.div, "div", importedDivisionIdsByType.div);
  }

  if (byType.mvp?.status === "ok") {
    const rows = parseMvpImport(byType.mvp.text);
    const grouped = groupByDivision(rows, routing.byNum);
    result.mvp = { imported: 0, skipped: grouped.skipped };
    for (const [divisionId, group] of Object.entries(grouped.groups)) {
      if (preflight.checks.some(check => check.reportType === "mvp" && check.divisionId === divisionId && check.status === "duplicate")) continue;
      const divisionWeekTag = preflight.weekTagsByReportDivision[`mvp:${divisionId}`];
      if (!divisionWeekTag) throw new Error(`Import blocked: no validated report week for division ${divisionId} MVP standings.`);
      const ok = await db.importMvpForWeek(divisionId, group.rows, divisionWeekTag);
      if (!ok) throw new Error(`Could not save MVP standings for division ${divisionId}.`);
      result.mvp.imported += group.rows.length;
      if (group.rows.length) importedDivisionIdsByType.mvp.push(divisionId);
    }
    if (importedDivisionIdsByType.mvp.length) await recordHistory(byType.mvp, "mvp", importedDivisionIdsByType.mvp);
  }
  return result;
}
