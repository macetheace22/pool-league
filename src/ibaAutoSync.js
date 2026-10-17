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

const REPORT_TYPES = ["rost", "div", "mvp"];
const FORMAT_LABELS = { mast: "Masters", adv: "Advanced", open: "Open" };
const DAY_LABELS = { mon: "Monday", tues: "Tuesday", wed: "Wednesday", thur: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

function contextCodes(context) {
  const format = String(context?.format || "").toLowerCase();
  const day = String(context?.day || "").toLowerCase();
  return { leagueType: FORMAT_TO_CODE[format] || null, day: DAY_TO_CODE[day] || null };
}

export function ibaCodesForSeason(season) {
  const contexts = [...new Map((season?.divisions || [])
    .map(division => ({ ...contextCodes(division), format: division.format, dayName: division.day }))
    .filter(context => context.leagueType && context.day)
    .map(context => [`${context.leagueType}:${context.day}`, context])).values()];
  if (contexts.length) return { ...contexts[0], contexts };
  const legacy = contextCodes(season);
  return { ...legacy, contexts: legacy.leagueType && legacy.day ? [{ ...legacy, format: season?.format, dayName: season?.day }] : [] };
}

export async function fetchIbaReports(season, reportType = null) {
  const { contexts } = ibaCodesForSeason(season);
  if (!contexts.length) throw new Error("The selected season has no divisions with a valid IBA format and day. Import its IBA schedule first.");
  const requestedTypes = reportType ? [reportType] : REPORT_TYPES;
  const reportsToFetch = contexts.flatMap(context =>
    requestedTypes.map(type => ({ leagueType: context.leagueType, day: context.day, reportType: type }))
  );
  const response = await fetch("/api/iba-reports", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reports: reportsToFetch }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Could not retrieve IBA reports.");
  const reports = (body.reports || []).map(report => ({
    ...report,
    formatLabel: FORMAT_LABELS[report.leagueType] || report.leagueType,
    dayLabel: DAY_LABELS[report.day] || report.day,
  }));
  return { ...body, reports, contexts };
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


export async function validateIbaReports(reports, season, options = {}) {
  const seasons = await db.listSeasons();
  const selected = (seasons ?? []).find(item => String(item.id) === String(season?.id));
  if (!selected) throw new Error("The selected season could not be reloaded. Refresh the page and retry.");
  const allDivisions = selected.divisions ?? [];
  const requestedDivisionId = options?.divisionId ? String(options.divisionId) : null;
  const divisions = requestedDivisionId ? allDivisions.filter(item => String(item.id) === requestedDivisionId) : allDivisions;
  if (requestedDivisionId && !divisions.length) throw new Error("The selected division does not belong to this season. Refresh the page and select it again.");
  if (!divisions.length) throw new Error("No divisions are configured for this season. Import its IBA schedule before weekly reports.");

  const checks = [];
  const weekTagsByReportDivision = {};
  for (const division of divisions) {
    const teams = await db.listTeams(division.id);
    const scheduledWeeks = await db.listSchedule(division.id, teams);
    const historyResult = await db.listIbaReportImportHistory(season.id, division.id);
    const divisionCodes = contextCodes(division);
    for (const report of (reports ?? []).filter(item =>
      item.status === "ok" &&
      item.leagueType === divisionCodes.leagueType &&
      item.day === divisionCodes.day
    )) {
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
        reportKey: report.key,
        leagueType: report.leagueType,
        day: report.day,
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
  const preview = { reports: [], sections: [], roster: null, standings: null, mvp: null, errors: [] };
  const rosterSections = [];
  const standingsSections = [];
  const mvpSections = [];

  for (const report of reports ?? []) {
    const section = {
      key: report.key,
      reportType: report.reportType,
      leagueType: report.leagueType,
      day: report.day,
      formatLabel: report.formatLabel || FORMAT_LABELS[report.leagueType] || report.leagueType,
      dayLabel: report.dayLabel || DAY_LABELS[report.day] || report.day,
      status: report.status,
      reportWeek: report.status === "ok" ? extractIbaReportWeek(report.text) : null,
      reportWeeksByDivision: report.status === "ok" ? extractIbaReportWeeksByDivision(report.text) : null,
    };
    if (report.status === "ok") {
      if (report.reportType === "rost") {
        section.parsed = parseLeagueRoster(report.text);
        section.teamCount = Object.keys(section.parsed.rosters || {}).length;
        section.playerCount = Object.keys(section.parsed.registry || {}).length;
        rosterSections.push(section);
      } else if (report.reportType === "div") {
        section.rows = parseStandingsImport(report.text);
        standingsSections.push(section);
      } else if (report.reportType === "mvp") {
        section.rows = parseMvpImport(report.text);
        mvpSections.push(section);
      }
    }
    preview.reports.push({
      key: section.key,
      reportType: section.reportType,
      status: section.status,
      pages: report.pages,
      bytes: report.bytes,
      message: report.message,
      reportWeek: section.reportWeek,
      reportWeeksByDivision: section.reportWeeksByDivision,
      formatLabel: section.formatLabel,
      dayLabel: section.dayLabel,
      detectedRows: section.reportType === "rost" ? section.playerCount : section.rows?.length,
      teamCount: section.teamCount,
    });
    preview.sections.push(section);
  }

  const mergeRosterSections = sections => {
    const parsed = { registry: {}, rosters: {}, teams: {}, needsRating: [], ambiguousRoster: [] };
    let playerCount = 0;
    let teamCount = 0;
    for (const section of sections) {
      const current = section.parsed;
      if (!current) continue;
      playerCount += Object.keys(current.registry || {}).length;
      teamCount += Object.keys(current.rosters || {}).length;
      Object.assign(parsed.registry, current.registry || {});
      Object.assign(parsed.teams, current.teams || {});
      for (const [teamNum, players] of Object.entries(current.rosters || {})) {
        parsed.rosters[teamNum] = [...new Set([...(parsed.rosters[teamNum] || []), ...players])];
      }
      parsed.needsRating.push(...(current.needsRating || []));
      parsed.ambiguousRoster.push(...(current.ambiguousRoster || []));
    }
    return { parsed, playerCount, teamCount };
  };
  if (rosterSections.length) {
    const merged = mergeRosterSections(rosterSections);
    preview.roster = { ...merged, sections: rosterSections };
  }
  if (standingsSections.length) {
    preview.standings = { rows: standingsSections.flatMap(section => section.rows || []), sections: standingsSections };
  }
  if (mvpSections.length) {
    preview.mvp = { rows: mvpSections.flatMap(section => section.rows || []), sections: mvpSections };
  }
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
        source: report.source === "manual" ? "manual" : "automatic",
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
      if (!preflight.checks.some(check => check.reportType === "div" && check.divisionId === divisionId)) continue;
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
      if (!preflight.checks.some(check => check.reportType === "mvp" && check.divisionId === divisionId)) continue;
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
