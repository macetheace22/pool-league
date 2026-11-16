// Pure, read-only comparison of an imported IBA schedule with the current app schedule.
// This module deliberately does not write to Supabase or mutate either input.
function teamNumber(team) {
  const value = team?.teamNum ?? team?.team_num ?? team?.teamNumber ?? team?.number;
  return value == null ? "" : String(value).trim();
}

function teamIndexMap(teams = []) {
  const byId = new Map();
  teams.forEach(team => {
    if (team?.id != null) byId.set(String(team.id), teamNumber(team));
  });
  return byId;
}

function resolveTeam(value, teams, byId) {
  if (value == null || value === "") return null;
  if (typeof value === "number" || /^\\d+$/.test(String(value))) {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 1 && index <= teams.length) {
      return teamNumber(teams[index - 1]) || null;
    }
  }
  return byId.get(String(value)) || String(value);
}

function normalizeDate(value) {
  if (!value) return "";
  const text = String(value).trim();
  let year, month, day;
  let match = text.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/);
  if (match) [, year, month, day] = match;
  else {
    match = text.match(/^(\\d{1,2})[/-](\\d{1,2})[/-](\\d{2,4})$/);
    if (!match) return text;
    [, month, day, year] = match;
  }
  year = Number(year); month = Number(month); day = Number(day);
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return text;
  return String(year) + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

function weekKey(week) {
  const number = week?.week ?? week?.week_num ?? week?.weekNumber;
  if (number != null && number !== "") return "week:" + number;
  return "date:" + normalizeDate(week?.date) + "|special:" + String(week?.special ?? "").trim().toLowerCase();
}

function normalizePairings(week, teams, byId) {
  const pairings = Array.isArray(week?.pairings) ? week.pairings : [];
  return pairings.map(pairing => {
    const homeValue = pairing?.homeTeamId ?? pairing?.home_team_id ?? pairing?.home;
    const awayValue = pairing?.awayTeamId ?? pairing?.away_team_id ?? pairing?.away;
    return {
      home: resolveTeam(homeValue, teams, byId),
      away: resolveTeam(awayValue, teams, byId),
    };
  }).filter(pairing => pairing.home);
}

function incompleteReason(schedule, errors) {
  if (Array.isArray(errors) && errors.length) return "IBA retrieval reported one or more errors.";
  if (!schedule || schedule.hasSchedule === false) return "IBA did not confirm that a schedule is available.";
  if (!Array.isArray(schedule.teams) || schedule.teams.length === 0) return "The schedule response did not contain a team list.";
  if (!Array.isArray(schedule.weeks) || schedule.weeks.length === 0) return "The schedule response did not contain schedule weeks.";
  if (!schedule.weeks.some(week => Array.isArray(week.pairings) && week.pairings.length)) return "The schedule response contained no usable matchups.";
  return null;
}

/**
 * Compare one division's current saved schedule to a successfully retrieved IBA schedule.
 * saved and official each have { teams, weeks }; week pairings can use 1-based
 * home/away team positions or team IDs. An explicit null away value represents TBA.
 * Pass retrieval errors in errors; any such error makes the result incomplete and
 * suppresses change claims, because a partial IBA response is not authoritative.
 */
export function compareIbaSchedules({ saved, official, errors = [] } = {}) {
  const reason = incompleteReason(official, errors);
  if (reason) {
    return {
      status: "incomplete",
      reason,
      changes: [],
      summary: { added: 0, removed: 0, changed: 0, dateChanges: 0, tbaResolutions: 0 },
    };
  }

  const savedTeams = saved?.teams ?? [];
  const officialTeams = official.teams;
  const savedById = teamIndexMap(savedTeams);
  const officialById = teamIndexMap(officialTeams);
  const savedWeeks = new Map((saved?.weeks ?? []).map(week => [weekKey(week), week]));
  const officialWeeks = new Map(official.weeks.map(week => [weekKey(week), week]));
  const changes = [];

  for (const [key, officialWeek] of officialWeeks) {
    const savedWeek = savedWeeks.get(key);
    if (!savedWeek) {
      changes.push({ type: "week_added", week: officialWeek.week ?? officialWeek.week_num ?? null, date: officialWeek.date ?? null });
      continue;
    }

    const savedDate = normalizeDate(savedWeek.date);
    const officialDate = normalizeDate(officialWeek.date);
    if (savedDate !== officialDate) {
      changes.push({
        type: "date_changed",
        week: officialWeek.week ?? officialWeek.week_num ?? savedWeek.week ?? savedWeek.week_num ?? null,
        from: savedWeek.date ?? null,
        to: officialWeek.date ?? null,
      });
    }

    const prior = normalizePairings(savedWeek, savedTeams, savedById);
    const current = normalizePairings(officialWeek, officialTeams, officialById);
    const priorByHome = new Map(prior.map(pairing => [pairing.home, pairing]));
    const currentByHome = new Map(current.map(pairing => [pairing.home, pairing]));

    for (const [home, matchup] of currentByHome) {
      const old = priorByHome.get(home);
      if (!old) {
        changes.push({
          type: matchup.away == null ? "tba_added" : "matchup_added",
          week: officialWeek.week ?? officialWeek.week_num ?? null,
          homeTeamNum: home,
          awayTeamNum: matchup.away,
        });
      } else if (old.away !== matchup.away) {
        const resolvedTba = old.away == null && matchup.away != null;
        changes.push({
          type: resolvedTba ? "tba_resolved" : "matchup_changed",
          week: officialWeek.week ?? officialWeek.week_num ?? null,
          homeTeamNum: home,
          fromAwayTeamNum: old.away,
          toAwayTeamNum: matchup.away,
        });
      }
    }

    for (const [home, matchup] of priorByHome) {
      if (!currentByHome.has(home)) {
        changes.push({
          type: "matchup_removed",
          week: officialWeek.week ?? officialWeek.week_num ?? null,
          homeTeamNum: home,
          awayTeamNum: matchup.away,
        });
      }
    }
  }

  for (const [key, savedWeek] of savedWeeks) {
    if (!officialWeeks.has(key)) {
      changes.push({ type: "week_removed", week: savedWeek.week ?? savedWeek.week_num ?? null, date: savedWeek.date ?? null });
    }
  }

  const count = type => changes.filter(change => change.type === type).length;
  return {
    status: changes.length ? "changes_found" : "no_changes",
    changes,
    summary: {
      added: count("week_added") + count("matchup_added") + count("tba_added"),
      removed: count("week_removed") + count("matchup_removed"),
      changed: count("matchup_changed"),
      dateChanges: count("date_changed"),
      tbaResolutions: count("tba_resolved"),
    },
    limitations: [
      "Previously imported TBA pairings are not retained by the current schedule database schema, so historical TBA resolutions cannot be inferred when the saved pairing is absent.",
    ],
  };
}
