import { createClient } from "@supabase/supabase-js";
import { getDivisions, getDivisionSchedule } from "./iba-schedules";
import { compareIbaSchedules, validateIbaScheduleSnapshot } from "../src/ibaScheduleComparison";
import { fingerprintIbaScheduleSnapshot } from "../src/ibaScheduleConfirmation";
import { emptyMonitorSummary, getChicagoCalendarDate, getDivisionMonitoringWindow } from "../src/ibaScheduleMonitor";

function authorized(req, secret) {
  const supplied = String(req.headers?.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && require("node:crypto").timingSafeEqual(actual, expected);
}

function divisionIdentity(value) {
  return String(value ?? "").split("!").pop();
}

function savedSnapshotFor(division, teams, weeks) {
  const divisionTeams = teams.filter(team => team.division_id === division.id).map(team => ({
    id: team.id,
    teamNum: team.team_num,
    name: team.name,
    venue: team.venue ?? "",
    isBye: Boolean(team.is_bye),
  }));
  const divisionWeeks = weeks.filter(week => week.division_id === division.id).map(week => ({
    id: week.id,
    week: week.week_num,
    date: week.date,
    special: week.special ?? "",
    isPlayoff: Boolean(week.is_playoff),
    pairings: (week.schedule_pairings ?? []).map(pairing => ({
      homeTeamId: pairing.home_team_id,
      awayTeamId: pairing.away_team_id,
      homeTbdCode: pairing.home_tbd_code ?? null,
      awayTbdCode: pairing.away_tbd_code ?? null,
    })),
  }));
  return { teams: divisionTeams, weeks: divisionWeeks };
}

async function saveCheck(client, row) {
  const { error } = await client.from("iba_schedule_monitor_checks")
    .upsert(row, { onConflict: "division_id,monitor_date" });
  if (error) throw new Error(error.message);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GET required" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(503).json({ error: "CRON_SECRET is not configured." });
  if (!authorized(req, cronSecret)) return res.status(401).json({ error: "Unauthorized." });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(503).json({ error: "Server-side Supabase URL and service-role key must be configured." });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const monitorDate = getChicagoCalendarDate();
  try {
    const { data: seasons, error: seasonError } = await client.from("seasons")
      .select("id,type,year,divisions(id,num,name,format,day)")
      .eq("is_active", true);
    if (seasonError) throw new Error(`Could not load active seasons: ${seasonError.message}`);

    const divisions = (seasons ?? []).flatMap(season =>
      (season.divisions ?? []).map(division => ({ ...division, season_id: season.id, season_type: season.type, season_year: season.year }))
    );
    if (!divisions.length) {
      return res.status(200).json({ monitorDate, checked: 0, skipped: 0, incomplete: 0, changesFound: 0, message: "No active-season divisions." });
    }

    const divisionIds = divisions.map(division => division.id);
    const [{ data: teams, error: teamError }, { data: weeks, error: weekError }] = await Promise.all([
      client.from("teams").select("id,division_id,team_num,name,venue,is_bye").in("division_id", divisionIds).order("team_num"),
      client.from("schedule_weeks")
        .select("id,division_id,week_num,date,special,is_playoff,schedule_pairings(id,home_team_id,away_team_id,home_tbd_code,away_tbd_code)")
        .in("division_id", divisionIds),
    ]);
    if (teamError) throw new Error(`Could not load saved teams: ${teamError.message}`);
    if (weekError) throw new Error(`Could not load saved schedules: ${weekError.message}`);

    const contexts = [...new Map(divisions.map(division => [
      `${division.format}|${division.day}`, { format: division.format, day: division.day },
    ])).values()];
    const discoveries = await Promise.all(contexts.map(async context => {
      try {
        const found = await getDivisions(context.format, context.day);
        return { ...context, divisions: found.divisions, error: null };
      } catch (error) {
        return { ...context, divisions: [], error: error?.message || "IBA division discovery failed." };
      }
    }));
    const discoveryByContext = new Map(discoveries.map(item => [`${item.format}|${item.day}`, item]));

    const eligible = [];
    let skipped = 0;
    let incomplete = 0;
    for (const division of divisions) {
      const saved = savedSnapshotFor(division, teams ?? [], weeks ?? []);
      const window = getDivisionMonitoringWindow(saved.weeks, monitorDate);
      if (window.status === "not_started" || window.status === "cutoff_reached") {
        skipped++;
        continue;
      }
      if (window.status === "incomplete") {
        incomplete++;
        await saveCheck(client, {
          season_id: division.season_id, division_id: division.id, monitor_date: monitorDate,
          status: "incomplete", snapshot_fingerprint: null, snapshot: null,
          changes: [], summary: emptyMonitorSummary(), error: window.reason, checked_at: new Date().toISOString(),
        });
        continue;
      }
      const discovery = discoveryByContext.get(`${division.format}|${division.day}`);
      if (!discovery || discovery.error) {
        incomplete++;
        await saveCheck(client, {
          season_id: division.season_id, division_id: division.id, monitor_date: monitorDate,
          status: "incomplete", snapshot_fingerprint: null, snapshot: null,
          changes: [], summary: emptyMonitorSummary(),
          error: discovery?.error || "IBA division discovery was unavailable.", checked_at: new Date().toISOString(),
        });
        continue;
      }
      const match = discovery.divisions.find(item => divisionIdentity(item.value) === String(division.num));
      if (!match) {
        incomplete++;
        await saveCheck(client, {
          season_id: division.season_id, division_id: division.id, monitor_date: monitorDate,
          status: "incomplete", snapshot_fingerprint: null, snapshot: null,
          changes: [], summary: emptyMonitorSummary(),
          error: `IBA did not return division ${division.num} for ${division.format} · ${division.day}.`,
          checked_at: new Date().toISOString(),
        });
        continue;
      }
      eligible.push({ division, saved, divisionValue: match.value });
    }

    const outcomes = await Promise.all(eligible.map(async item => {
      try {
        const official = await getDivisionSchedule(item.divisionValue);
        const validationErrors = validateIbaScheduleSnapshot(official);
        const comparison = compareIbaSchedules({ saved: item.saved, official, errors: validationErrors });
        if (comparison.status === "incomplete") {
          await saveCheck(client, {
            season_id: item.division.season_id, division_id: item.division.id, monitor_date: monitorDate,
            status: "incomplete", snapshot_fingerprint: null, snapshot: null,
            changes: [], summary: emptyMonitorSummary(), error: comparison.reason,
            checked_at: new Date().toISOString(),
          });
          return { status: "incomplete" };
        }
        const fingerprint = await fingerprintIbaScheduleSnapshot(official);
        await saveCheck(client, {
          season_id: item.division.season_id, division_id: item.division.id, monitor_date: monitorDate,
          status: comparison.status, snapshot_fingerprint: fingerprint,
          snapshot: { teams: official.teams, weeks: official.weeks },
          changes: comparison.changes, summary: comparison.summary, error: null,
          checked_at: new Date().toISOString(),
        });
        return { status: comparison.status };
      } catch (error) {
        await saveCheck(client, {
          season_id: item.division.season_id, division_id: item.division.id, monitor_date: monitorDate,
          status: "incomplete", snapshot_fingerprint: null, snapshot: null,
          changes: [], summary: emptyMonitorSummary(),
          error: error?.message || "IBA schedule monitoring failed.", checked_at: new Date().toISOString(),
        });
        return { status: "incomplete" };
      }
    }));

    const outcomeIncomplete = outcomes.filter(item => item.status === "incomplete").length;
    const changesFound = outcomes.filter(item => item.status === "changes_found").length;
    return res.status(200).json({
      monitorDate,
      activeDivisions: divisions.length,
      checked: outcomes.length,
      skipped,
      incomplete: incomplete + outcomeIncomplete,
      changesFound,
      noChanges: outcomes.filter(item => item.status === "no_changes").length,
      notificationsSent: 0,
      scheduleWrites: 0,
    });
  } catch (error) {
    console.error("IBA schedule monitor failed:", error);
    return res.status(500).json({ error: error?.message || "IBA schedule monitor failed." });
  }
}
