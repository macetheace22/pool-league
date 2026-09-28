import * as db from "./db";
import { parseLeagueRoster, parseStandingsImport, parseMvpImport } from "./ibaParsers";

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

export async function fetchIbaReports(season) {
  const { leagueType, day } = ibaCodesForSeason(season);
  if (!leagueType || !day) throw new Error("The selected season must have a supported format and day.");
  const response = await fetch("/api/iba-reports", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leagueType, day }),
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

export async function buildIbaPreview(reports) {
  const byType = Object.fromEntries((reports ?? []).map(r => [r.reportType, r]));
  const preview = { reports: [], roster: null, standings: null, mvp: null, errors: [] };
  for (const r of reports ?? []) {
    preview.reports.push({ key: r.key, reportType: r.reportType, status: r.status, pages: r.pages, bytes: r.bytes, message: r.message });
  }
  if (byType.rost?.status === "ok") {
    const parsed = parseLeagueRoster(byType.rost.text);
    preview.roster = { parsed, teamCount: Object.keys(parsed.rosters).length, playerCount: Object.keys(parsed.registry).length };
  }
  if (byType.div?.status === "ok") preview.standings = { rows: parseStandingsImport(byType.div.text) };
  if (byType.mvp?.status === "ok") preview.mvp = { rows: parseMvpImport(byType.mvp.text) };
  return preview;
}

export async function importIbaReports(reports, season, schedule) {
  const weekTag = currentWeekTag(schedule);
  const result = { weekTag, roster: null, standings: null, mvp: null, warnings: [] };
  const byType = Object.fromEntries((reports ?? []).map(r => [r.reportType, r]));

  if (byType.rost?.status === "ok") {
    const parsed = parseLeagueRoster(byType.rost.text);
    result.roster = await db.bulkImportPlayers(parsed, weekTag);
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
      const ok = await db.importStandingsForWeek(divisionId, group.rows, group.teams, weekTag);
      if (ok) result.standings.imported += group.rows.length;
    }
  }

  if (byType.mvp?.status === "ok") {
    const rows = parseMvpImport(byType.mvp.text);
    const grouped = groupByDivision(rows, routing.byNum);
    result.mvp = { imported: 0, skipped: grouped.skipped };
    for (const [divisionId, group] of Object.entries(grouped.groups)) {
      const ok = await db.importMvpForWeek(divisionId, group.rows, weekTag);
      if (ok) result.mvp.imported += group.rows.length;
    }
  }
  return result;
}
