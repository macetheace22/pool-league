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
  if (Array.isArray(season?.divisions) && season.divisions.length === 0) {
    return { leagueType: null, day: null, contexts: [] };
  }
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
      const parsedRowCount = report.reportType === "rost"
        ? Object.keys(parseLeagueRoster(report.text).registry || {}).length
        : report.reportType === "div"
          ? parseStandingsImport(report.text).length
          : report.reportType === "mvp"
            ? parseMvpImport(report.text).length
            : 0;
      const scheduledWeek = scheduledWeeks.find(item => Number(item.week) === Number(classification.week?.weekNumber));
      let status = parsedRowCount === 0 ? "blocked_zero_rows" : classification.status;
      let reason = parsedRowCount === 0
        ? "The report parsed to zero records; import is blocked."
        : classification.reason;
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
    // A missing PDF is normal when a format/day is not playing this week.
    // Other independently validated format/day groups may still be imported.
    // Actual fetch errors and empty PDFs remain fail-closed.
    canImport: allChecksReady && reportFailures.every(failure => failure.status === "missing"),
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
  const fallbackWeekTag = currentWeekTag(schedule);
  const result = {
    weekTag: fallbackWeekTag,
    roster: { updatedDivisions: [], unmatchedTeams: [], ambiguousTeamIds: [], warnings: [] },
    standings: { imported: 0, skipped: [] },
    mvp: { imported: 0, skipped: [] },
    warnings: [],
    skippedDuplicateDivisions: preflight.checks
      .filter(check => check.status === "duplicate")
      .map(check => `${check.reportType.toUpperCase()} · Division ${check.divisionNum} · Week ${check.weekNumber}`),
  };

  const recordHistory = async (report, reportType, divisionIds) => {
    const checks = preflight.checks.filter(check =>
      check.reportKey === report.key &&
      check.reportType === reportType &&
      divisionIds.includes(check.divisionId) &&
      check.status === "ready"
    );
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

  const successfulReports = (reports ?? []).filter(report => report.status === "ok");
  const teamNums = [...new Set(successfulReports.flatMap(report => {
    if (report.reportType === "rost") return Object.keys(parseLeagueRoster(report.text).rosters || {});
    if (report.reportType === "div") return parseStandingsImport(report.text).map(row => row.teamNum);
    if (report.reportType === "mvp") return parseMvpImport(report.text).map(row => row.teamNum);
    return [];
  }))];
  const routing = await db.listActiveTeamsByNumbers(teamNums);
  // Restrict team-number routing to the explicitly selected season. Team
  // numbers may repeat across seasons as well as across IBA format/day groups.
  const seasonDivisionIds = new Set((season?.divisions || []).map(division => String(division.id)));
  const routingForReport = report => Object.fromEntries(Object.entries(routing.byNum || {}).map(([teamNum, matches]) => [
    teamNum,
    matches.filter(team => {
      const codes = contextCodes(team);
      return seasonDivisionIds.has(String(team.divisionId)) &&
        codes.leagueType === report.leagueType &&
        codes.day === report.day;
    }),
  ]));

  for (const report of successfulReports.filter(item => item.reportType === "rost")) {
    const parsed = parseLeagueRoster(report.text);
    const checks = preflight.checks.filter(check => check.reportKey === report.key && check.reportType === "rost");
    const readyDivisionIds = new Set(checks.filter(check => check.status === "ready").map(check => check.divisionId));
    const reportRouting = routingForReport(report);
    const eligibleTeamNums = new Set(Object.keys(parsed.rosters || {}).filter(teamNum => {
      const matches = reportRouting[teamNum] || [];
      return matches.length === 1 && readyDivisionIds.has(matches[0].divisionId);
    }));
    const ambiguousTeamNums = Object.keys(parsed.rosters || {}).filter(teamNum => {
      const matches = reportRouting[teamNum] || [];
      return matches.length > 1 && matches.some(team => readyDivisionIds.has(team.divisionId));
    });
    if (ambiguousTeamNums.length) result.warnings.push(`${report.key}: ${ambiguousTeamNums.length} roster team numbers matched multiple active divisions and were skipped.`);
    const eligiblePlayerNums = new Set([...eligibleTeamNums].flatMap(teamNum => parsed.rosters[teamNum] || []));
    const filteredParsed = {
      ...parsed,
      rosters: Object.fromEntries(Object.entries(parsed.rosters || {}).filter(([teamNum]) => eligibleTeamNums.has(teamNum))),
      teams: Object.fromEntries(Object.entries(parsed.teams || {}).filter(([teamNum]) => eligibleTeamNums.has(teamNum))),
      registry: Object.fromEntries(Object.entries(parsed.registry || {}).filter(([, player]) => eligiblePlayerNums.has(player.num))),
      needsRating: (parsed.needsRating || []).filter(player => eligiblePlayerNums.has(player.num)),
      ambiguousRoster: (parsed.ambiguousRoster || []).filter(item => eligiblePlayerNums.has(item.playerNum || item.num)),
    };
    if (!eligibleTeamNums.size) continue;
    const imported = await db.bulkImportPlayers(filteredParsed, {
      byReportDivision: preflight.weekTagsByReportDivision,
      allowedDivisionIds: [...readyDivisionIds],
      fallback: fallbackWeekTag,
    });
    result.roster.updatedDivisions.push(...(imported?.updatedDivisions || []));
    result.roster.unmatchedTeams.push(...(imported?.unmatchedTeams || []));
    result.roster.ambiguousTeamIds.push(...(imported?.ambiguousTeamIds || []));
    result.roster.warnings.push(...(imported?.warnings || []));
    const updatedIds = (imported?.updatedDivisions || []).map(item => item.divisionId);
    if (updatedIds.length) await recordHistory(report, "rost", updatedIds);
  }

  for (const report of successfulReports.filter(item => item.reportType === "div")) {
    const grouped = groupByDivision(parseStandingsImport(report.text), routingForReport(report));
    result.standings.skipped.push(...grouped.skipped);
    const importedDivisionIds = [];
    for (const [divisionId, group] of Object.entries(grouped.groups)) {
      const check = preflight.checks.find(item => item.reportKey === report.key && item.reportType === "div" && item.divisionId === divisionId);
      if (!check || check.status === "duplicate") continue;
      if (check.status !== "ready") throw new Error(`Import blocked: division ${check.divisionNum} standings were not validated.`);
      const tag = preflight.weekTagsByReportDivision[`div:${divisionId}`];
      if (!tag) throw new Error(`Import blocked: no validated report week for division ${divisionId} standings.`);
      const ok = await db.importStandingsForWeek(divisionId, group.rows, group.teams, tag);
      if (!ok) throw new Error(`Could not save standings for division ${divisionId}.`);
      result.standings.imported += group.rows.length;
      if (group.rows.length) importedDivisionIds.push(divisionId);
    }
    if (importedDivisionIds.length) await recordHistory(report, "div", importedDivisionIds);
  }

  for (const report of successfulReports.filter(item => item.reportType === "mvp")) {
    const grouped = groupByDivision(parseMvpImport(report.text), routingForReport(report));
    result.mvp.skipped.push(...grouped.skipped);
    const importedDivisionIds = [];
    for (const [divisionId, group] of Object.entries(grouped.groups)) {
      const check = preflight.checks.find(item => item.reportKey === report.key && item.reportType === "mvp" && item.divisionId === divisionId);
      if (!check || check.status === "duplicate") continue;
      if (check.status !== "ready") throw new Error(`Import blocked: division ${check.divisionNum} MVP standings were not validated.`);
      const tag = preflight.weekTagsByReportDivision[`mvp:${divisionId}`];
      if (!tag) throw new Error(`Import blocked: no validated report week for division ${divisionId} MVP standings.`);
      const ok = await db.importMvpForWeek(divisionId, group.rows, tag);
      if (!ok) throw new Error(`Could not save MVP standings for division ${divisionId}.`);
      result.mvp.imported += group.rows.length;
      if (group.rows.length) importedDivisionIds.push(divisionId);
    }
    if (importedDivisionIds.length) await recordHistory(report, "mvp", importedDivisionIds);
  }

  return result;
}
