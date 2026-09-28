import { supabase } from "./supabaseClient";

// Legacy compatibility helpers retained from the prior version.
export function normalizeUSDate(str) {
  if (!str) return str;
  const parts = String(str).trim().split("/");
  if (parts.length !== 3) return str; // not a recognizable M/D/YYYY shape -- leave as-is rather than guess
  const [m, d, y] = parts;
  const mNum = parseInt(m, 10), dNum = parseInt(d, 10);
  if (Number.isNaN(mNum) || Number.isNaN(dNum) || !/^\d+$/.test(y)) return str;
  return `${String(mNum).padStart(2, "0")}/${String(dNum).padStart(2, "0")}/${y}`;
}
function parseUSDate(str) {
  if (!str) return null;
  const parts = String(str).trim().split("/").map(Number);
  if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return null;
  return new Date(parts[2], parts[0] - 1, parts[1]);
}
export function shortPlayerName(player) {
  if (!player) return "";
  if (!player.hasAccount || !player.firstName) return player.name ?? "";
  const lastInitial = player.lastName ? `${player.lastName.trim().charAt(0)}.` : "";
  return `${player.firstName}${lastInitial ? " " + lastInitial : ""}`.trim();
}


export async function isBootstrapNeeded() {
  const { data } = await supabase.rpc("is_bootstrap_needed");
  return !!data;
}

export async function signInWithGoogle(redirectTo) {
  const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  return !error;
}

export async function claimInviteCode(code) {
  const { data, error } = await supabase.rpc("claim_invite_code", { p_code: code });
  if (error) return { error: error.message };
  return { role: data?.[0]?.role, team_id: data?.[0]?.team_id };
}

// ─── Auth / Profile ─────────────────────────────────────────────────────────
export async function getProfile(userId) {
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  return data;
}
export async function updateOwnUsername(userId, username) {
  const { error } = await supabase.from("profiles").update({ username }).eq("id", userId);
  return !error;
}
export async function updateOwnPhone(userId, phoneNumber) {
  const { error } = await supabase.from("profiles").update({ phone_number: phoneNumber || null }).eq("id", userId);
  return !error;
}
// Returns { ok: true } or { ok: false, reason: "not_found" | "already_claimed" | "error" }
export async function setOwnPlayerNumber(playerNum) {
  const { error } = await supabase.rpc("set_own_player_number", { p_player_num: playerNum });
  if (!error) return { ok: true };
  if (error.message?.includes("PLAYER_NOT_FOUND")) return { ok: false, reason: "not_found" };
  if (error.message?.includes("PLAYER_ALREADY_CLAIMED")) return { ok: false, reason: "already_claimed" };
  return { ok: false, reason: "error" };
}
// Manager-only self-service: sets or clears the manager's own team_id (the
// team they personally play on, separate from admin scope, which role
// alone governs). Captains/players get team_id through invite codes or
// setProfileRole instead -- this RPC is manager-only. See section 42.
export async function setOwnTeamId(teamId) {
  const { data, error } = await supabase.rpc("set_own_team_id", { p_team_id: teamId || null });
  if (error) return { ok: false, reason: "ERROR" };
  const row = data?.[0];
  return row ?? { ok: false, reason: "ERROR" };
}
export async function validateInviteCode(code) {
  const { data, error } = await supabase.rpc("validate_invite_code", { p_code: code });
  if (error || !data || data.length === 0) return null;
  return data[0]; // { role, team_id, team_name }
}
export async function isUsernameTaken(username) {
  const { data } = await supabase.rpc("is_username_taken", { p_username: username });
  return !!data;
}
export async function listMakeupPendingMatches(divisionId) {
  const { data } = await supabase.from("completed_matches").select("*")
    .eq("division_id", divisionId).eq("is_makeup_pending", true).order("created_at", { ascending: false });
  return data ?? [];
}

// Seeds live_match from an already-archived makeup-pending row so scoring
// can continue for whatever tables are still outstanding. Already-completed
// tables (and their original players/ratings) are left untouched -- that
// part of the scoresheet is done. Outstanding tables are cleared back to
// blank so the draft picks from CURRENT rosters/ratings (not whatever was
// current the night the makeup was first reported), matching how a real
// makeup date works: it's scored with the ratings in effect that week.
export async function resumeMakeupMatch(matchRow) {
  const pairingId = matchRow.state?.schedulePairingId;
  if (!pairingId) return false;
  const [homeRoster, awayRoster] = await Promise.all([
    listRosterForTeam(matchRow.team_home_id),
    listRosterForTeam(matchRow.team_away_id),
  ]);
  const state = matchRow.state ?? {};
  let eligByNum = {};
  if (state.isPlayoff && matchRow.division_id) {
    eligByNum = eligibilityByPlayerNum(await listPlayoffEligibility(matchRow.division_id));
  }
  const attachElig = (roster) => roster.filter(p => p.rating != null).map(p => ({ ...p, eligCode: eligByNum[p.num]?.code ?? null }));
  const seed = {
    ...state,
    teamHome: { ...state.teamHome, roster: attachElig(homeRoster) },
    teamAway: { ...state.teamAway, roster: attachElig(awayRoster) },
    sets: (state.sets ?? []).map(s => s.complete ? s : { setNum: s.setNum, playerHome: null, playerAway: null, complete: false, winnerSlot: null, racks: [] }),
    phase: "lineup",
    makeup: null,
    resumingMatchId: matchRow.id,
    archiving: false,
    confirmedHome: false, confirmedAway: false, disputedBy: null, disputeNote: null,
    // Fresh claim needed for the resumed session -- who's around tonight for
    // a makeup may not be who scored the original attempt.
    scorerHome: null, scorerAway: null, unavailableHome: false, unavailableAway: false,
  };
  return setLiveMatch(pairingId, seed);
}

// ─── Playoffs ───────────────────────────────────────────────────────────────
// Final standings, seeded 1..N, real teams only (skips synthetic "manual:name"
// rows from a standings import that was never matched to a real team --
// those can't anchor a real schedule_pairing).
export async function computeFinalStandings(divisionId) {
  const [matches, adj] = await Promise.all([listCompletedMatches(divisionId), listStandingsAdjustments(divisionId)]);
  return computeStandings(matches, adj).filter(s => typeof s.teamId === "string" && !s.teamId.startsWith("manual:"));
}

async function createPlayoffWeek(divisionId, label) {
  const { data, error } = await supabase.from("schedule_weeks")
    .insert({ division_id: divisionId, date: new Date().toLocaleDateString("en-US"), is_playoff: true, playoff_label: label })
    .select().single();
  return error ? null : data;
}
async function createPlayoffPairing(weekId, homeTeamId, awayTeamId) {
  const { data, error } = await supabase.from("schedule_pairings")
    .insert({ week_id: weekId, home_team_id: homeTeamId, away_team_id: awayTeamId }).select().single();
  return error ? null : data;
}

export async function generateChampionshipBracket(divisionId) {
  const existing = await listPlayoffBrackets(divisionId);
  if (existing.some(m => m.bracket_type === "championship")) return { error: "A championship bracket already exists for this division." };

  const standings = await computeFinalStandings(divisionId);
  if (standings.length < 4) return { error: "Need at least 4 teams with standings to seed a championship bracket." };
  const [s1, s2, s3, s4] = standings;

  const week = await createPlayoffWeek(divisionId, "Championship Semifinals");
  if (!week) return { error: "Could not create the playoff week." };
  const [pairing1, pairing2] = await Promise.all([
    createPlayoffPairing(week.id, s1.teamId, s4.teamId),
    createPlayoffPairing(week.id, s2.teamId, s3.teamId),
  ]);
  if (!pairing1 || !pairing2) return { error: "Could not create the semifinal matchups." };

  const { data: finalMatch } = await supabase.from("playoff_matches").insert({
    division_id: divisionId, bracket_type: "championship", bracket_group: "championship",
    bracket_label: "Division Championship", round: "final", slot_num: 1,
  }).select().single();

  const { error } = await supabase.from("playoff_matches").insert([
    { division_id: divisionId, bracket_type: "championship", bracket_group: "championship", bracket_label: "Division Championship",
      round: "semifinal", slot_num: 1, seed_home: 1, seed_away: 4, team_home_id: s1.teamId, team_away_id: s4.teamId,
      schedule_pairing_id: pairing1.id, feeds_into_match_id: finalMatch?.id ?? null, feeds_into_slot: "home" },
    { division_id: divisionId, bracket_type: "championship", bracket_group: "championship", bracket_label: "Division Championship",
      round: "semifinal", slot_num: 2, seed_home: 2, seed_away: 3, team_home_id: s2.teamId, team_away_id: s3.teamId,
      schedule_pairing_id: pairing2.id, feeds_into_match_id: finalMatch?.id ?? null, feeds_into_slot: "away" },
  ]);
  return error ? { error: "Could not save the bracket." } : { ok: true };
}

// Suggests consolation groupings of 4 (5th-place-through-last within this
// division). If the count doesn't divide evenly by 4, pulls in the leftover
// teams from other divisions in the same season with the same format + day,
// so every division's consolation teams get a fair bracket instead of an
// awkward small one. Returned as a proposal for the manager to review/edit
// before committing -- nothing is written yet.
export async function previewConsolationBrackets(divisionId) {
  const { data: thisDivision } = await supabase.from("divisions").select("id, season_id, seasons(format, day)").eq("id", divisionId).single();
  if (!thisDivision) return { error: "Division not found.", brackets: [] };

  const { data: sisterDivisions } = await supabase.from("divisions")
    .select("id").eq("season_id", thisDivision.season_id);
  // Only divisions sharing this division's season (same format+day, since
  // it's one season_id per format/day combo in how seasons are modeled here).
  const divisionIds = (sisterDivisions ?? []).map(d => d.id);

  const pools = await Promise.all(divisionIds.map(async (divId) => {
    const standings = await computeFinalStandings(divId);
    return { divisionId: divId, consolationTeams: standings.slice(4) }; // 5th place onward
  }));

  let pool = pools.find(p => p.divisionId === divisionId)?.consolationTeams ?? [];
  const otherPools = pools.filter(p => p.divisionId !== divisionId && p.consolationTeams.length > 0);

  // If this division's own consolation count doesn't divide evenly by 4,
  // borrow leftover teams from other divisions (same season) to fill brackets.
  const remainder = pool.length % 4;
  if (remainder !== 0 && remainder !== pool.length) {
    let need = 4 - remainder;
    for (const other of otherPools) {
      while (need > 0 && other.consolationTeams.length > 0) {
        pool = [...pool, other.consolationTeams.shift()];
        need--;
      }
      if (need === 0) break;
    }
  }

  const letters = "ABCDEFGH";
  const brackets = [];
  for (let i = 0; i < pool.length; i += 4) {
    const group = pool.slice(i, i + 4);
    brackets.push({ label: `Consolation Bracket ${letters[brackets.length] ?? brackets.length + 1}`, teams: group });
  }
  return { brackets, unassigned: pool.length % 4 === pool.length ? pool : [] };
}

// Commits manager-reviewed consolation bracket groupings. Each bracket:
// { label, teams: [{teamId, name, ...}] } sorted best-seed-first.
// 4 teams -> normal semis+final. 3 -> top seed gets a bye into the final,
// other two play a semi. 2 -> straight to final, no semi. 1 -> declared
// winner immediately (no match at all).
export async function generateConsolationBrackets(divisionId, brackets) {
  for (const bracket of brackets) {
    const teams = bracket.teams;
    if (teams.length === 0) continue;
    const group = `consolation-${bracket.label.replace(/\s+/g, "-").toLowerCase()}`;

    if (teams.length === 1) {
      await supabase.from("playoff_matches").insert({
        division_id: divisionId, bracket_type: "consolation", bracket_group: group, bracket_label: bracket.label,
        round: "final", slot_num: 1, team_home_id: teams[0].teamId, winner_team_id: teams[0].teamId,
      });
      continue;
    }
    if (teams.length === 2) {
      const week = await createPlayoffWeek(divisionId, bracket.label);
      const pairing = week ? await createPlayoffPairing(week.id, teams[0].teamId, teams[1].teamId) : null;
      await supabase.from("playoff_matches").insert({
        division_id: divisionId, bracket_type: "consolation", bracket_group: group, bracket_label: bracket.label,
        round: "final", slot_num: 1, team_home_id: teams[0].teamId, team_away_id: teams[1].teamId,
        schedule_pairing_id: pairing?.id ?? null,
      });
      continue;
    }

    const { data: finalMatch } = await supabase.from("playoff_matches").insert({
      division_id: divisionId, bracket_type: "consolation", bracket_group: group, bracket_label: bracket.label, round: "final", slot_num: 1,
    }).select().single();

    if (teams.length === 3) {
      // Top seed byes straight into the final; the other two play a semi.
      const week = await createPlayoffWeek(divisionId, bracket.label);
      const pairing = week ? await createPlayoffPairing(week.id, teams[1].teamId, teams[2].teamId) : null;
      await supabase.from("playoff_matches").insert([
        { division_id: divisionId, bracket_type: "consolation", bracket_group: group, bracket_label: bracket.label,
          round: "semifinal", slot_num: 1, is_bye_home: true, team_home_id: teams[0].teamId,
          winner_team_id: teams[0].teamId, feeds_into_match_id: finalMatch?.id ?? null, feeds_into_slot: "home" },
        { division_id: divisionId, bracket_type: "consolation", bracket_group: group, bracket_label: bracket.label,
          round: "semifinal", slot_num: 2, team_home_id: teams[1].teamId, team_away_id: teams[2].teamId,
          schedule_pairing_id: pairing?.id ?? null, feeds_into_match_id: finalMatch?.id ?? null, feeds_into_slot: "away" },
      ]);
      // Bye winner is already known -- fill the final's home slot now.
      if (finalMatch) await supabase.from("playoff_matches").update({ team_home_id: teams[0].teamId }).eq("id", finalMatch.id);
      continue;
    }

    // 4 (or more, in case of an odd pooling edge case -- take the first 4 by seed)
    const week = await createPlayoffWeek(divisionId, bracket.label);
    const [pairing1, pairing2] = week ? await Promise.all([
      createPlayoffPairing(week.id, teams[0].teamId, teams[3].teamId),
      createPlayoffPairing(week.id, teams[1].teamId, teams[2].teamId),
    ]) : [null, null];
    await supabase.from("playoff_matches").insert([
      { division_id: divisionId, bracket_type: "consolation", bracket_group: group, bracket_label: bracket.label,
        round: "semifinal", slot_num: 1, team_home_id: teams[0].teamId, team_away_id: teams[3].teamId,
        schedule_pairing_id: pairing1?.id ?? null, feeds_into_match_id: finalMatch?.id ?? null, feeds_into_slot: "home" },
      { division_id: divisionId, bracket_type: "consolation", bracket_group: group, bracket_label: bracket.label,
        round: "semifinal", slot_num: 2, team_home_id: teams[1].teamId, team_away_id: teams[2].teamId,
        schedule_pairing_id: pairing2?.id ?? null, feeds_into_match_id: finalMatch?.id ?? null, feeds_into_slot: "away" },
    ]);
  }
  return true;
}

export async function listPlayoffBrackets(divisionId) {
  const { data } = await supabase.from("playoff_matches").select("*, schedule_pairings(id)")
    .eq("division_id", divisionId).order("bracket_group").order("round").order("slot_num");
  return data ?? [];
}

// Called after a playoff semifinal (or 2-team consolation final) archives.
// Records the winner and, if this feeds a later round, fills in that round's
// team slot -- creating its schedule_pairing once both sides are known.
export async function advancePlayoffBracket(schedulePairingId, winnerTeamId) {
  const { data: match } = await supabase.from("playoff_matches").select("*").eq("schedule_pairing_id", schedulePairingId).maybeSingle();
  if (!match) return; // not a playoff match -- nothing to do

  const winnerSeed = winnerTeamId === match.team_home_id ? match.seed_home : match.seed_away;
  await supabase.from("playoff_matches").update({ winner_team_id: winnerTeamId, winner_seed: winnerSeed }).eq("id", match.id);

  if (!match.feeds_into_match_id) return;
  const field = match.feeds_into_slot === "home" ? "team_home_id" : "team_away_id";
  const seedField = match.feeds_into_slot === "home" ? "seed_home" : "seed_away";
  await supabase.from("playoff_matches").update({ [field]: winnerTeamId, [seedField]: winnerSeed }).eq("id", match.feeds_into_match_id);

  const { data: target } = await supabase.from("playoff_matches").select("*").eq("id", match.feeds_into_match_id).single();
  if (target && target.team_home_id && target.team_away_id && !target.schedule_pairing_id) {
    // Both sides known -- schedule the final. Home field goes to the better (lower-number) seed.
    const homeIsBetter = (target.seed_home ?? 999) <= (target.seed_away ?? 999);
    const week = await createPlayoffWeek(target.division_id, target.bracket_label + " Final");
    const pairing = week ? await createPlayoffPairing(week.id, homeIsBetter ? target.team_home_id : target.team_away_id, homeIsBetter ? target.team_away_id : target.team_home_id) : null;
    if (pairing) {
      await supabase.from("playoff_matches").update({
        schedule_pairing_id: pairing.id,
        team_home_id: homeIsBetter ? target.team_home_id : target.team_away_id,
        team_away_id: homeIsBetter ? target.team_away_id : target.team_home_id,
      }).eq("id", target.id);
    }
  }
}

export async function listProfiles() {
  const { data } = await supabase.from("profiles").select("*").order("created_at");
  return data ?? [];
}
export async function listTeamCaptains() {
  const { data, error } = await supabase.rpc("list_team_captains");
  if (error || !data) return {};
  const map = {};
  for (const row of data) map[row.team_id] = { username: row.username, phone: row.phone_number };
  return map;
}
export async function setProfileActive(userId, isActive) {
  const { error } = await supabase.from("profiles").update({ is_active: isActive }).eq("id", userId);
  return !error;
}
export async function setProfileRole(userId, role, teamId) {
  const { error } = await supabase.from("profiles").update({ role, team_id: role === "captain" ? (teamId || null) : null, is_claimed: true }).eq("id", userId);
  return !error;
}
export async function listUserLastSignIns() {
  const { data, error } = await supabase.rpc("list_user_last_sign_ins");
  if (error || !data) return {};
  const map = {};
  for (const row of data) map[row.id] = row.last_sign_in_at;
  return map;
}
export async function runStaleUserCleanup() {
  const { error } = await supabase.rpc("deactivate_stale_users");
  return !error;
}

// ─── Invite codes ───────────────────────────────────────────────────────────
export async function listInviteCodes() {
  const { data } = await supabase.from("invite_codes").select("*").order("created_at", { ascending: false });
  return data ?? [];
}
export async function createInviteCode(code) {
  const { error } = await supabase.from("invite_codes").insert(code);
  return !error;
}
// Captain flow: generate a player-role code for one of their own roster
// players, optionally capturing/updating that player's contact email first
// (ready for actual sending once that's built -- for now the code is just
// shared manually, same as every other invite code).
function generateCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

export async function generatePlayerInviteCode(teamId, playerNum, email) {
  if (email && email.trim()) {
    await supabase.from("players").update({ email: email.trim() }).eq("num", playerNum);
  }
  const code = {
    code: generateCode(), role: "player", team_id: teamId, player_num: playerNum,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const { error } = await supabase.from("invite_codes").insert(code);
  return error ? null : code;
}
export async function listTeamInviteCodes(teamId) {
  const { data } = await supabase.from("invite_codes").select("*").eq("team_id", teamId).order("created_at", { ascending: false });
  return data ?? [];
}
export async function revokeInviteCode(code) {
  const { error } = await supabase.from("invite_codes").delete().eq("code", code);
  return !error;
}

// ─── Seasons ────────────────────────────────────────────────────────────────
export async function listSeasons() {
  const { data } = await supabase.from("seasons").select("*, divisions(*)").order("created_at");
  return data ?? [];
}
export async function createSeason(season) {
  const { data, error } = await supabase.from("seasons").insert(season).select().single();
  return error ? null : data;
}
export async function deleteSeason(seasonId) {
  const { error } = await supabase.from("seasons").delete().eq("id", seasonId);
  return !error;
}
export async function setSeasonActive(seasonId, isActive) {
  const { error } = await supabase.from("seasons").update({ is_active: isActive }).eq("id", seasonId);
  return !error;
}
export async function setPlayoffsStartDate(seasonId, date) {
  const { error } = await supabase.from("seasons").update({ playoffs_start_date: date || null }).eq("id", seasonId);
  return !error;
}

// ─── Divisions ──────────────────────────────────────────────────────────────
export async function addDivision(seasonId, num, name) {
  const { data, error } = await supabase.from("divisions").insert({ season_id: seasonId, num, name }).select().single();
  return error ? null : data;
}
export async function removeDivision(divisionId) {
  const { error } = await supabase.from("divisions").delete().eq("id", divisionId);
  return !error;
}

// Finds a division within a specific season. Team numbers are intentionally
// scoped to this division/season; never route an IBA schedule by a globally
// unique team number.
export async function findDivisionInSeason(seasonId, num, name) {
  let query = supabase.from("divisions").select("*").eq("season_id", seasonId);
  if (num) query = query.eq("num", String(num));
  const { data } = await query.maybeSingle();
  if (data) return data;
  if (!name) return null;
  const { data: rows } = await supabase.from("divisions").select("*").eq("season_id", seasonId).eq("name", name).limit(1);
  return rows?.[0] ?? null;
}

// Idempotent season-rooted import for one IBA schedule. The caller supplies
// the already-parsed division/team/schedule structure from the IBA website.
// This is deliberately separate from the old manual paste path so both paths
// can converge on the same persistence functions without changing existing
// scoring/history data.
export async function importIbaScheduleDivision(seasonId, division) {
  if (!seasonId || !division) return { ok: false, error: "Missing season or division." };
  let target = await findDivisionInSeason(seasonId, division.num, division.name);
  if (!target) target = await addDivision(seasonId, division.num, division.name || "");
  if (!target) return { ok: false, error: "Could not create the division." };

  const { data: existingWeeks } = await supabase.from("schedule_weeks").select("id").eq("division_id", target.id).limit(1);
  if (existingWeeks?.length) {
    return { ok: false, error: "A schedule already exists for this division. Use the existing manual re-import flow until schedule change detection is added.", divisionId: target.id, existingSchedule: true };
  }
  const incomingTeams = (division.teams ?? []).map(t => ({
    teamNum: String(t.teamNum ?? "").trim(),
    name: String(t.name ?? "").trim(),
    venue: String(t.venue ?? "").trim(),
    isBye: !!t.isBye,
  })).filter(t => t.teamNum && t.name);
  if (incomingTeams.length) {
    const ok = await saveTeams(target.id, incomingTeams);
    if (!ok) return { ok: false, error: "Division was found, but teams could not be saved.", divisionId: target.id };
  }
  const teams = await listTeams(target.id);
  const ordered = [...teams].sort((a,b) => {
    const an = Number(a.teamNum), bn = Number(b.teamNum);
    return (Number.isFinite(an) && Number.isFinite(bn)) ? an - bn : String(a.teamNum).localeCompare(String(b.teamNum));
  });
  const weeks = (division.weeks ?? []).map(w => ({
    week: w.week ?? null, date: w.date ?? "", special: w.special ?? null,
    pairings: (w.pairings ?? []).map(p => ({ home: Number(p.home), away: Number(p.away) })).filter(p => Number.isFinite(p.home) && Number.isFinite(p.away)),
  }));
  if (weeks.length) await replaceSchedule(target.id, weeks, ordered);
  const playoffWeeks = weeks.filter(w => `${w.special ?? ""}`.toLowerCase().includes("playoff"));
  return { ok: true, divisionId: target.id, divisionNum: target.num, divisionName: target.name, teamCount: ordered.length, weekCount: weeks.length, playoffWeeks: playoffWeeks.length };
}
export async function updateDivision(divisionId, num, name) {
  const { error } = await supabase.from("divisions").update({ num, name }).eq("id", divisionId);
  return !error;
}
// Lightweight team counts per division -- used by the Seasons page to know
// which season(s) still need teams imported, without pulling full team rows.
export async function countTeamsByDivisions(divisionIds) {
  if (!divisionIds.length) return {};
  const { data } = await supabase.from("teams").select("division_id").in("division_id", divisionIds);
  const counts = {};
  (data ?? []).forEach(t => { counts[t.division_id] = (counts[t.division_id] ?? 0) + 1; });
  return counts;
}

export async function listActiveTeamsByNumbers(teamNums) {
  const nums = [...new Set((teamNums ?? []).filter(Boolean))];
  if (!nums.length) return { byNum: {}, ambiguous: [] };
  const { data } = await supabase
    .from("teams")
    .select("id, division_id, team_num, name, venue, is_bye, divisions(seasons(is_active))")
    .in("team_num", nums);
  const byNum = {};
  const ambiguous = [];
  for (const row of data ?? []) {
    if (!row.divisions?.seasons?.is_active) continue;
    (byNum[row.team_num] ??= []).push({
      id: row.id, divisionId: row.division_id, teamNum: row.team_num, name: row.name, venue: row.venue ?? "", isBye: !!row.is_bye,
    });
  }
  for (const [num, rows] of Object.entries(byNum)) if (rows.length > 1) ambiguous.push(num);
  return { byNum, ambiguous };
}

export async function listAllTeamsWithContext() {
  const { data } = await supabase
    .from("teams")
    .select("id, name, team_num, is_bye, roster_submitted_at, roster_submitted_by, profiles(username), divisions(num, name, seasons(type, year, format, day, is_active))")
    .order("team_num");
  return (data ?? []).map(t => ({
    id: t.id, name: t.name, teamNum: t.team_num, isBye: t.is_bye,
    context: t.divisions ? `Div ${t.divisions.num} · ${t.divisions.seasons?.type ?? ""} ${t.divisions.seasons?.year ?? ""}` : "",
    isActiveSeason: !!t.divisions?.seasons?.is_active,
    rosterSubmittedAt: t.roster_submitted_at, rosterSubmittedBy: t.profiles?.username ?? null,
  }));
}

// ─── Teams ──────────────────────────────────────────────────────────────────
// Ordered by id (text): team ids are same-length numeric strings within a
// division (e.g. "15101".."15112"), so lexicographic order matches numeric
// order -- which is exactly the 1..N position scheme the schedule format
// uses ("1 vs 2"). This lets pairings resolve to real team ids without a
// separate sort-order column.
export async function listTeams(divisionId) {
  const { data } = await supabase.from("teams").select("*").eq("division_id", divisionId).order("team_num");
  return (data ?? []).map(t => ({ id: t.id, teamNum: t.team_num, name: t.name, venue: t.venue ?? "", isBye: t.is_bye, rosterSubmittedAt: t.roster_submitted_at }));
}
// Teams already saved (real uuid `id`) upsert-by-id, so an edit updates that
// exact row. Freshly parsed teams (no `id` yet) upsert against the
// (division_id, team_num) unique constraint instead -- this correctly
// updates the existing row in place if you re-paste the same division's
// list, and inserts a brand-new row (fresh uuid) for a genuinely new team.
// Team numbers are only unique WITHIN a division, never globally -- the same
// number can (and will) mean a completely different team in another
// division or a later season.
export async function saveTeams(divisionId, teams) {
  const withId = teams.filter(t => t.id)
    .map(t => ({ id: t.id, division_id: divisionId, team_num: t.teamNum, name: t.name, venue: t.venue ?? "", is_bye: !!t.isBye }));
  const withoutId = teams.filter(t => !t.id)
    .map(t => ({ division_id: divisionId, team_num: t.teamNum, name: t.name, venue: t.venue ?? "", is_bye: !!t.isBye }));
  let ok = true;
  if (withId.length) {
    const { error } = await supabase.from("teams").upsert(withId, { onConflict: "id" });
    if (error) ok = false;
  }
  if (withoutId.length) {
    const { error } = await supabase.from("teams").upsert(withoutId, { onConflict: "division_id,team_num" });
    if (error) ok = false;
  }
  return ok;
}
export async function deleteTeam(teamId) {
  const { error } = await supabase.from("teams").delete().eq("id", teamId);
  return !error;
}

// ─── Locations ──────────────────────────────────────────────────────────────
export async function listLocations() {
  const { data } = await supabase.from("locations").select("*").order("name");
  return data ?? [];
}
export async function createLocation(name, address = {}) {
  const { street = "", city = "", state = "", zip = "" } = address;
  const { data, error } = await supabase.from("locations")
    .insert({ name, street, city, state, zip }).select().single();
  return error ? null : data;
}
export async function updateLocation(id, name, address = {}) {
  const { street = "", city = "", state = "", zip = "" } = address;
  const { error } = await supabase.from("locations").update({ name, street, city, state, zip }).eq("id", id);
  return !error;
}
export async function deleteLocation(id) {
  const { error } = await supabase.from("locations").delete().eq("id", id);
  return !error;
}

// ─── Schedule ───────────────────────────────────────────────────────────────
export async function listSchedule(divisionId, teams) {
  const { data: weeks } = await supabase
    .from("schedule_weeks")
    .select("*, schedule_pairings(*)")
    .eq("division_id", divisionId)
    .order("week_num", { ascending: true, nullsFirst: false });
  const idxOf = teamId => teams.findIndex(t => t.id === teamId) + 1;
  return (weeks ?? []).map(w => ({
    id: w.id,
    week: w.week_num,
    date: w.date,
    special: w.special,
    isPlayoff: w.is_playoff,
    playoffLabel: w.playoff_label,
    pairings: (w.schedule_pairings ?? []).map(p => ({
      id: p.id,
      home: idxOf(p.home_team_id),
      away: idxOf(p.away_team_id),
      homeTeamId: p.home_team_id,
      awayTeamId: p.away_team_id,
    })),
  }));
}
// parsedWeeks: output of parseSchedule() (positional 1-based home/away indices).
// teams: the division's current team list, in the same order the schedule's
// numbering assumes -- positions are resolved to real team ids here, once,
// so nothing downstream needs to think about position again.
export async function replaceSchedule(divisionId, parsedWeeks, teams) {
  await supabase.from("schedule_weeks").delete().eq("division_id", divisionId);
  for (const w of parsedWeeks) {
    const { data: weekRow, error } = await supabase
      .from("schedule_weeks")
      .insert({ division_id: divisionId, week_num: w.week, date: w.date, special: w.special ?? null })
      .select().single();
    if (error || !weekRow) continue;
    const pairingRows = w.pairings
      .map(p => ({ week_id: weekRow.id, home_team_id: teams[p.home - 1]?.id, away_team_id: teams[p.away - 1]?.id }))
      .filter(p => p.home_team_id && p.away_team_id);
    if (pairingRows.length) await supabase.from("schedule_pairings").insert(pairingRows);
  }
}

// Manual pairing edits -- lets a manager fix or add a single matchup (BYE
// teams included as valid opponents) without re-pasting the whole schedule.
export async function addSchedulePairing(weekId, homeTeamId, awayTeamId) {
  const { error } = await supabase.from("schedule_pairings").insert({ week_id: weekId, home_team_id: homeTeamId, away_team_id: awayTeamId });
  return !error;
}
export async function updateSchedulePairing(pairingId, homeTeamId, awayTeamId) {
  const { error } = await supabase.from("schedule_pairings").update({ home_team_id: homeTeamId, away_team_id: awayTeamId }).eq("id", pairingId);
  return !error;
}
export async function deleteSchedulePairing(pairingId) {
  const { error } = await supabase.from("schedule_pairings").delete().eq("id", pairingId);
  return !error;
}

// ─── Players / ratings / rosters ────────────────────────────────────────────
export async function listRostersForTeams(teamIds) {
  if (teamIds.length === 0) return {};
  const { data: rosterRows } = await supabase
    .from("rosters")
    .select("team_id, player_num, players(num, name, nickname)")
    .in("team_id", teamIds);
  const nums = [...new Set((rosterRows ?? []).map(r => r.player_num))];
  let ratingByNum = {};
  if (nums.length) {
    const { data: ratingRows } = await supabase.from("player_current_ratings").select("player_num, rating").in("player_num", nums);
    ratingByNum = Object.fromEntries((ratingRows ?? []).map(r => [r.player_num, r.rating]));
  }
  const byTeam = {};
  for (const teamId of teamIds) byTeam[teamId] = [];
  for (const r of rosterRows ?? []) {
    byTeam[r.team_id] = byTeam[r.team_id] ?? [];
    byTeam[r.team_id].push({
      num: r.player_num,
      name: r.players?.name ?? "",
      nickname: r.players?.nickname ?? "",
      rating: ratingByNum[r.player_num] ?? null,
    });
  }
  return byTeam; // { teamId: [{num,name,nickname,rating}, ...] }
}

export async function listRosterForTeam(teamId) {
  const { data: rosterRows } = await supabase
    .from("rosters")
    .select("player_num, players(num, name, nickname, email)")
    .eq("team_id", teamId);
  const nums = (rosterRows ?? []).map(r => r.player_num);
  if (nums.length === 0) return [];
  // player_current_ratings is a view, not a real FK-linked table, so it can't be
  // embedded in the query above via PostgREST's automatic relationship inference --
  // fetch it separately and merge client-side instead.
  const [{ data: ratingRows }, { data: linkedRows }] = await Promise.all([
    supabase.from("player_current_ratings").select("player_num, rating").in("player_num", nums),
    supabase.rpc("list_linked_player_nums", { p_nums: nums }),
  ]);
  const ratingByNum = Object.fromEntries((ratingRows ?? []).map(r => [r.player_num, r.rating]));
  const linkedSet = new Set((linkedRows ?? []).map(r => r.player_num));
  return rosterRows.map(r => ({
    num: r.player_num,
    name: r.players?.name ?? "",
    nickname: r.players?.nickname ?? "",
    email: r.players?.email ?? "",
    rating: ratingByNum[r.player_num] ?? null,
    hasAccount: linkedSet.has(r.player_num),
  }));
}
export async function listRosterHistory(playerNum) {
  const { data } = await supabase
    .from("player_ratings")
    .select("*")
    .eq("player_num", playerNum)
    .order("week_key", { ascending: false });
  return data ?? [];
}
export async function setPlayerRating(playerNum, weekKey, label, rating, source) {
  const { error } = await supabase
    .from("player_ratings")
    .upsert({ player_num: playerNum, week_key: weekKey, label, rating, source, updated_at: new Date().toISOString() },
      { onConflict: "player_num,week_key" });
  return !error;
}
export async function moveRosterPlayer(playerNum, fromTeamId, toTeamId) {
  await supabase.from("rosters").delete().eq("team_id", fromTeamId).eq("player_num", playerNum);
  const { error } = await supabase.from("rosters").upsert({ team_id: toTeamId, player_num: playerNum });
  return !error;
}

// ── Captain-scoped team management (Manage My Team page) ──
// A captain may rename their own team and add/remove players on their own
// roster only -- enforced by RLS (see schema section 14), this is just the
// client-side plumbing. Newly-added players get a synthetic "C-" id since
// they won't have a real IBA player number yet; a manager can reconcile
// them with the real number on the next weekly ratings import.
export async function renameTeam(teamId, newName) {
  const { error } = await supabase.from("teams").update({ name: newName }).eq("id", teamId);
  return !error;
}
export async function addPlayerToTeam(teamId, { name, nickname }) {
  const num = `C-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const { error: playerErr } = await supabase.from("players").insert({ num, name, nickname: nickname || null });
  if (playerErr) return null;
  const { error: rosterErr } = await supabase.from("rosters").insert({ team_id: teamId, player_num: num });
  if (rosterErr) return null;
  return { num, name, nickname: nickname || "", rating: null };
}
// Adds an EXISTING player (already in the registry, from a search result or
// a past roster) to a team -- no new players row, just the roster link.
export async function addExistingPlayerToRoster(teamId, playerNum) {
  const { error } = await supabase.from("rosters").insert({ team_id: teamId, player_num: playerNum });
  return !error;
}
// League-wide player name search, for a captain looking up someone who
// isn't already on their roster (e.g. picked up from another team).
export async function searchPlayers(query) {
  if (!query || query.trim().length < 2) return [];
  const { data } = await supabase.from("players").select("num, name, nickname")
    .ilike("name", `%${query.trim()}%`).order("name").limit(20);
  if (!data?.length) return [];
  const nums = data.map(p => p.num);
  const { data: ratingRows } = await supabase.from("player_current_ratings").select("player_num, rating").in("player_num", nums);
  const ratingByNum = Object.fromEntries((ratingRows ?? []).map(r => [r.player_num, r.rating]));
  return data.map(p => ({ ...p, rating: ratingByNum[p.num] ?? null }));
}
// This account's past (closed) captaincies -- what "players from your last
// team" is built on. Most recent first.
export async function listPastCaptainedTeams(profileId) {
  const { data } = await supabase.from("captaincy_history")
    .select("team_id, started_at, ended_at, teams(name, division_id, divisions(num, seasons(type, year)))")
    .eq("profile_id", profileId).not("ended_at", "is", null).order("started_at", { ascending: false });
  return (data ?? []).map(r => ({
    teamId: r.team_id,
    teamName: r.teams?.name ?? "Unknown team",
    context: r.teams?.divisions ? `Div ${r.teams.divisions.num} · ${r.teams.divisions.seasons?.type ?? ""} ${r.teams.divisions.seasons?.year ?? ""}` : "",
    endedAt: r.ended_at,
  }));
}
export async function submitTeamRoster(teamId, profileId) {
  const { error } = await supabase.from("teams").update({ roster_submitted_at: new Date().toISOString(), roster_submitted_by: profileId }).eq("id", teamId);
  return !error;
}
export async function removePlayerFromTeam(teamId, playerNum) {
  const { error } = await supabase.from("rosters").delete().eq("team_id", teamId).eq("player_num", playerNum);
  return !error;
}

// Bulk import: parsed = output of parseLeagueRoster() -- { registry, rosters, teams, needsRating, ambiguousRoster }.
// The pasted report identifies teams by their printed number, but numbers
// are only unique within a division/season -- the same number can exist in
// more than one currently-active division. Matching is scoped to active
// seasons (you're only ever importing weekly data for a season that's
// currently running) and any number that still matches more than one team
// is reported back as ambiguous rather than guessed at.
export async function bulkImportPlayers(parsed, weekTag) {
  const teamNums = Object.keys(parsed.rosters);
  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, division_id, team_num, divisions(seasons(is_active))")
    .in("team_num", teamNums);
  const activeRows = (teamRows ?? []).filter(r => r.divisions?.seasons?.is_active);

  const byNum = {};
  const ambiguousTeamIds = [];
  for (const row of activeRows) {
    if (byNum[row.team_num]) { if (!ambiguousTeamIds.includes(row.team_num)) ambiguousTeamIds.push(row.team_num); continue; }
    byNum[row.team_num] = row;
  }
  for (const num of ambiguousTeamIds) delete byNum[num]; // don't guess -- route neither match

  const knownNums = new Set(Object.keys(byNum));
  const unmatchedTeamIds = teamNums.filter(n => !knownNums.has(n) && !ambiguousTeamIds.includes(n));
  const byDivision = {};
  for (const row of Object.values(byNum)) {
    byDivision[row.division_id] = (byDivision[row.division_id] ?? 0) + 1;
  }

  // Players + ratings
  const playerRows = Object.values(parsed.registry).map(p => ({ num: p.num, name: p.name, nickname: p.nickname ?? "" }));
  if (playerRows.length) await supabase.from("players").upsert(playerRows);

  const ratingRows = Object.values(parsed.registry)
    .filter(p => p.rating != null)
    .map(p => ({ player_num: p.num, week_key: weekTag.weekKey, label: weekTag.label, rating: p.rating, source: "import", updated_at: new Date().toISOString() }));
  if (ratingRows.length) await supabase.from("player_ratings").upsert(ratingRows, { onConflict: "player_num,week_key" });

  // needsRating players still need a players-table row (so they exist to show up), just no rating row.
  const needsRatingRows = (parsed.needsRating ?? []).map(p => ({ num: p.num, name: p.name, nickname: p.nickname ?? "" }));
  if (needsRatingRows.length) await supabase.from("players").upsert(needsRatingRows);

  // Rosters -- routed by the real team id resolved above, never by the raw number.
  const rosterRows = [];
  for (const [teamNum, nums] of Object.entries(parsed.rosters)) {
    const row = byNum[teamNum];
    if (!row) continue;
    for (const num of nums) rosterRows.push({ team_id: row.id, player_num: num });
  }
  if (rosterRows.length) await supabase.from("rosters").upsert(rosterRows, { onConflict: "team_id,player_num" });

  const updatedDivisions = Object.entries(byDivision).map(([divisionId, teamCount]) => ({ divisionId, teamCount }));
  // Players/ratings for an unmatched team's roster were still upserted above
  // (that part never depended on team routing) -- only the roster LINKAGE
  // (which team_id each player_num belongs to) is missing. Carrying the
  // parsed name/roster forward here means a reconciliation UI can fix just
  // that linkage without asking for a full re-paste of the report.
  const unmatchedTeams = unmatchedTeamIds.map(num => ({
    teamNum: num,
    teamName: parsed.teams?.[num]?.name ?? null,
    playerNums: parsed.rosters[num] ?? [],
  }));
  return { updatedDivisions, unmatchedTeamIds, unmatchedTeams, ambiguousTeamIds, weekTag };
}

// Reconciliation, path 1: the unmatched team number was actually a typo (or
// the team was set up under a slightly different number) -- route its
// already-imported roster to a real, existing team instead. Only touches
// the roster linkage; players/ratings were already saved by the original
// bulkImportPlayers call regardless of team match.
export async function reconcileUnmatchedTeamToExisting(teamId, playerNums) {
  if (!playerNums || playerNums.length === 0) return true;
  const rows = playerNums.map(num => ({ team_id: teamId, player_num: num }));
  const { error } = await supabase.from("rosters").upsert(rows, { onConflict: "team_id,player_num" });
  return !error;
}

// Reconciliation, path 2: the team genuinely doesn't exist yet -- create it
// under the given division (using the report's own parsed name, if it had
// one) and route the already-imported roster straight to it.
export async function reconcileUnmatchedTeamAsNew(divisionId, teamNum, teamName, playerNums) {
  const { data: team, error } = await supabase.from("teams")
    .insert({ division_id: divisionId, team_num: teamNum, name: teamName || `Team ${teamNum}`, is_bye: false })
    .select().single();
  if (error || !team) return false;
  if (playerNums && playerNums.length > 0) {
    const rows = playerNums.map(num => ({ team_id: team.id, player_num: num }));
    await supabase.from("rosters").upsert(rows, { onConflict: "team_id,player_num" });
  }
  return true;
}

// ─── Match history (archive) ────────────────────────────────────────────────
// Builds a completed_matches row from a finished live_match state and inserts it.
// Called once both sides have confirmed in Live Entry.
export async function archiveMatch(state, divisionId) {
  const isMakeup = !!(state.makeup?.confirmedHome && state.makeup?.confirmedAway);
  const completedCount = (state.sets ?? []).filter(s => s.complete).length;
  // A makeup match keeps the real score for whatever tables were actually
  // played (matchSideTotal only counts complete sets already) -- totals only
  // go null when literally nothing was played, so there's no misleading 0-0.
  const homeTotal = isMakeup && completedCount === 0 ? null : matchSideTotal(state, "home");
  const awayTotal = isMakeup && completedCount === 0 ? null : matchSideTotal(state, "away");
  const { homePoints, awayPoints } = computeMatchPoints(state);
  const row = {
    division_id: divisionId ?? null,
    season_label: state.seasonLabel ?? null,
    week_num: state.weekNum ?? null,
    week_date: state.weekDate ?? null,
    venue: state.venue ?? null,
    format: state.format ?? "masters",
    team_home_id: state.teamHome?.id ?? null,
    team_away_id: state.teamAway?.id ?? null,
    team_home_name: state.teamHome?.name ?? "",
    team_away_name: state.teamAway?.name ?? "",
    team_home_total: homeTotal,
    team_away_total: awayTotal,
    team_home_points: isMakeup && completedCount === 0 ? null : homePoints,
    team_away_points: isMakeup && completedCount === 0 ? null : awayPoints,
    state,
    source: "live",
    is_makeup_pending: isMakeup,
  };
  // Finishing a previously-reported makeup updates that same scoresheet row
  // in place instead of creating a second, duplicate match for the same
  // pairing/week.
  if (state.resumingMatchId) {
    const updateRow = { ...row, reopened_at: null, reopened_by: null };
    const { data, error } = await supabase.from("completed_matches").update(updateRow).eq("id", state.resumingMatchId).select().single();
    return error ? null : data;
  }
  const { data, error } = await supabase.from("completed_matches").insert(row).select().single();
  return error ? null : data;
}

// Sets won per side -- the simplest, format-agnostic "who won the match" total.
// (Full point-value scoring with margin/add-on/win-bonus/rating-bonus lives in
// the scoresheet view itself, computed from the same state at render time.)
// ─── Forfeit points ─────────────────────────────────────────────────────────
// Same lookup used live in LiveEntryApp.jsx -- kept here too since the
// deadline-passed forfeit flow runs from the admin side, not live scoring.
export const FORFEIT_POINTS = {
  masters:  { regular: 100, playoff: 200 },
  advanced: { regular: 150, playoff: 250 },
  open:     { regular: 125, playoff: (rating) => 100 + (rating ?? 0) },
};
export function isPlayoffMatch(matchLike) {
  if (!matchLike.playoffsStartDate || !matchLike.weekDate) return false;
  return new Date(matchLike.weekDate) >= new Date(matchLike.playoffsStartDate);
}
export function computeForfeitPoints(matchLike, receivingPlayerRating) {
  const format = (matchLike.format || "masters").toLowerCase();
  const tier = FORFEIT_POINTS[format] ?? FORFEIT_POINTS.masters;
  const val = isPlayoffMatch(matchLike) ? tier.playoff : tier.regular;
  return typeof val === "function" ? val(receivingPlayerRating) : val;
}

// Converts every still-empty table on a deadline-passed makeup-pending match
// into a forfeit: the short team's named player gets 0, the other team's
// named player gets the forfeit-point value for this match's format/tier.
// Already-completed tables (played for real, or already forfeited earlier)
// are left untouched. Once every table has a result, is_makeup_pending clears
// and the match is a normal final record from here on.
export async function applyForfeitToRemainingTables(matchRow, assignments) {
  const shortTeam = matchRow.state?.makeup?.shortTeam;
  if (!shortTeam) return false;
  const receivingSide = shortTeam === "home" ? "away" : "home";
  const bySetNum = Object.fromEntries(assignments.map(a => [a.setNum, a]));
  const matchLike = { format: matchRow.state?.format, weekDate: matchRow.week_date, playoffsStartDate: matchRow.state?.playoffsStartDate };
  const newSets = (matchRow.state?.sets ?? []).map(s => {
    if (s.complete) return s;
    const a = bySetNum[s.setNum];
    if (!a) return s;
    const points = computeForfeitPoints(matchLike, a.receivingPlayer.rating);
    const forfeiting = { num: a.forfeitingPlayer.num, name: a.forfeitingPlayer.name, nickname: a.forfeitingPlayer.nickname, rating: a.forfeitingPlayer.rating };
    const receiving = { num: a.receivingPlayer.num, name: a.receivingPlayer.name, nickname: a.receivingPlayer.nickname, rating: a.receivingPlayer.rating };
    return {
      ...s,
      playerHome: shortTeam === "home" ? forfeiting : receiving,
      playerAway: shortTeam === "away" ? forfeiting : receiving,
      racks: [], complete: true, winnerSlot: receivingSide,
      forfeited: true, forfeitedBy: shortTeam, forfeitPoints: points,
    };
  });
  const newState = { ...matchRow.state, sets: newSets };
  const homeTotal = newSets.filter(s => s.winnerSlot === "home").length;
  const awayTotal = newSets.filter(s => s.winnerSlot === "away").length;
  const { homePoints, awayPoints } = computeMatchPoints(newState);
  const { error } = await supabase.from("completed_matches").update({
    state: newState, team_home_total: homeTotal, team_away_total: awayTotal,
    team_home_points: homePoints, team_away_points: awayPoints, is_makeup_pending: false,
  }).eq("id", matchRow.id);
  if (!error && matchRow.state?.schedulePairingId && homeTotal !== awayTotal) {
    const winnerId = homeTotal > awayTotal ? matchRow.team_home_id : matchRow.team_away_id;
    await advancePlayoffBracket(matchRow.state.schedulePairingId, winnerId);
  }
  return !error;
}

function matchSideTotal(state, side) {
  return (state.sets ?? []).filter(s => s.winnerSlot === side).length;
}

function isUnratedRatingDb(rating) { return rating != null && rating <= 2; }

// Real accumulated scoring points per side -- same margin/add-on/win-bonus
// formula the scoresheet displays, computed here so it can be stored on the
// match row and summed into standings, putting live-scored matches on the
// same points basis as an imported week's "Total Points" column.
const TEAM_RATING_LIMIT = 325;
function ratingForTeamTotal(rating, format) {
  if (isUnratedRatingDb(rating)) return format === "open" ? 45 : 50;
  return rating ?? 0;
}
function teamRatingBonusPenalty(state, side) {
  const format = (state.format || "masters").toLowerCase();
  if (format === "masters") return 0;
  const total = (state.sets ?? []).filter(s => s.complete).reduce((sum, s) => {
    const player = side === "home" ? s.playerHome : s.playerAway;
    return player ? sum + ratingForTeamTotal(player.rating, format) : sum;
  }, 0);
  const diff = TEAM_RATING_LIMIT - total;
  return diff >= 0 ? diff : -(Math.abs(diff) * 5);
}

export function computeMatchPoints(state) {
  const format = (state.format || "masters").toLowerCase();
  const isMasters = format === "masters";
  const fixedTarget = format === "open" ? 45 : 50;
  let homePoints = 0, awayPoints = 0;
  for (const s of state.sets ?? []) {
    if (!s.complete) continue;
    if (s.forfeited) {
      if (s.forfeitedBy === "home") awayPoints += s.forfeitPoints ?? 0;
      else if (s.forfeitedBy === "away") homePoints += s.forfeitPoints ?? 0;
      continue;
    }
    const home = s.playerHome, away = s.playerAway;
    if (!home || !away) continue;
    const eitherUnrated = isUnratedRatingDb(home.rating) || isUnratedRatingDb(away.rating);
    const targetHome = eitherUnrated ? fixedTarget : home.rating;
    const targetAway = eitherUnrated ? fixedTarget : away.rating;
    const runHome = (s.racks ?? []).reduce((t, r) => t + (r.home ?? 0), 0);
    const runAway = (s.racks ?? []).reduce((t, r) => t + (r.away ?? 0), 0);
    if (s.winnerSlot === "home") {
      const margin = Math.max(0, (targetAway ?? 0) - runAway);
      const addOn = margin * 3;
      homePoints += isMasters ? (addOn + 100) : (runHome + addOn + 100);
      awayPoints += isMasters ? 0 : runAway;
    } else if (s.winnerSlot === "away") {
      const margin = Math.max(0, (targetHome ?? 0) - runHome);
      const addOn = margin * 3;
      awayPoints += isMasters ? (addOn + 100) : (runAway + addOn + 100);
      homePoints += isMasters ? 0 : runHome;
    }
  }
  if (!isMasters) {
    homePoints += teamRatingBonusPenalty(state, "home");
    awayPoints += teamRatingBonusPenalty(state, "away");
  }
  return { homePoints, awayPoints };
}

export async function listCompletedMatches(divisionId) {
  const { data } = await supabase
    .from("completed_matches")
    .select("*")
    .eq("division_id", divisionId)
    .order("confirmed_at", { ascending: false });
  return data ?? [];
}

// One team's own slice of its division's schedule + completed matches --
// powers the Leagues dashboard's Next Match / Upcoming / Previous cards.
// "Previous" comes from real completed_matches rather than inferring from
// the schedule by date, so a makeup played on a different night than
// originally scheduled still shows up correctly.
export async function getTeamScheduleOverview(teamId) {
  const { data: teamRow } = await supabase.from("teams").select("id,name,venue,division_id").eq("id", teamId).maybeSingle();
  if (!teamRow) return null;
  const teams = await listTeams(teamRow.division_id);
  const [schedule, completed] = await Promise.all([
    listSchedule(teamRow.division_id, teams),
    listCompletedMatches(teamRow.division_id),
  ]);
  const myCompleted = completed.filter(m => m.team_home_id === teamId || m.team_away_id === teamId);
  const myWeeks = schedule
    .map(w => ({ ...w, pairings: w.pairings.filter(p => p.homeTeamId === teamId || p.awayTeamId === teamId) }))
    .filter(w => w.pairings.length > 0);
  return { team: teamRow, teams, myWeeks, myCompleted };
}

export async function getCompletedMatch(id) {
  const { data } = await supabase.from("completed_matches").select("*").eq("id", id).maybeSingle();
  return data;
}

// ─── Lineup planner (captain-only scheduling, team-scoped visibility) ─────
// Purely a communication/planning tool -- who's expected to shoot which
// week -- entirely optional and never required. Does NOT gate live-entry
// draft or roster eligibility in any way; a week with no plan on file
// behaves exactly as it always has. Visibility (via RLS's is_on_team()) is
// scoped to that team (captain, its own players, and managers), never
// leaguewide. See section 43 migration.

// Free-text schedule dates are M/D/YYYY (same convention as everywhere else
// in this app) -- used only for chronological sort, matching the same
// parse-then-sort pattern already used on the dashboards.
function parseSlashDate(str) {
  if (!str) return null;
  const parts = str.split("/").map(Number);
  if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return null;
  const [m, d, y] = parts;
  return new Date(y, m - 1, d);
}

// One row per (team, schedule week) the captain has planned, each with its
// list of planned players (name/nickname/rating included for display) and
// optional note -- sorted chronologically by the real schedule week's date.
export async function listTeamLineupPlans(teamId) {
  const { data } = await supabase
    .from("lineup_plans")
    .select("id, schedule_week_id, note, updated_at, schedule_weeks(week_num, date), lineup_plan_players(player_num, players(name, nickname))")
    .eq("team_id", teamId);
  const plans = (data ?? []).map(p => ({
    id: p.id,
    scheduleWeekId: p.schedule_week_id,
    weekNum: p.schedule_weeks?.week_num ?? null,
    weekDate: p.schedule_weeks?.date ?? "",
    note: p.note ?? "",
    updatedAt: p.updated_at,
    players: (p.lineup_plan_players ?? []).map(pp => ({
      num: pp.player_num, name: pp.players?.name ?? "", nickname: pp.players?.nickname ?? "",
    })),
  }));
  return plans.sort((a, b) => (parseSlashDate(a.weekDate) ?? 0) - (parseSlashDate(b.weekDate) ?? 0));
}

// Creates or replaces the plan for one (team, schedule week) -- the full
// player list is always replaced wholesale (delete-then-insert, same
// pattern moveRosterPlayer already uses) rather than diffed, since the
// captain UI is a simple checkbox list + save, not incremental edits.
// Saving with an empty player list and no note is equivalent to having no
// plan at all for that week, so it's cleaned up rather than left as an
// empty row.
export async function upsertLineupPlan(teamId, scheduleWeekId, note, playerNums, profileId) {
  const trimmedNote = (note ?? "").trim();
  if (playerNums.length === 0 && !trimmedNote) {
    const { data: existing } = await supabase.from("lineup_plans").select("id")
      .eq("team_id", teamId).eq("schedule_week_id", scheduleWeekId).maybeSingle();
    if (existing) await supabase.from("lineup_plans").delete().eq("id", existing.id);
    return true;
  }
  const { data: plan, error: planErr } = await supabase.from("lineup_plans")
    .upsert({ team_id: teamId, schedule_week_id: scheduleWeekId, note: trimmedNote || null, created_by: profileId, updated_at: new Date().toISOString() },
      { onConflict: "team_id,schedule_week_id" })
    .select().single();
  if (planErr || !plan) return false;
  await supabase.from("lineup_plan_players").delete().eq("lineup_plan_id", plan.id);
  if (playerNums.length > 0) {
    const rows = playerNums.map(num => ({ lineup_plan_id: plan.id, team_id: teamId, player_num: num }));
    const { error: playersErr } = await supabase.from("lineup_plan_players").insert(rows);
    if (playersErr) return false;
  }
  return true;
}

// Clears an entire week's plan (captain deciding not to plan that week
// after all) -- lineup_plan_players cascades with it.
export async function deleteLineupPlan(planId) {
  const { error } = await supabase.from("lineup_plans").delete().eq("id", planId);
  return !error;
}

// Every unavailability row on file for a team (any week, any player) --
// the captain's Lineup Planner filters this down to the week it's showing;
// a player's own "My Availability" view filters it down to just their own
// player_num. See section 44.
export async function listTeamUnavailability(teamId) {
  const { data } = await supabase
    .from("lineup_unavailability")
    .select("id, schedule_week_id, player_num, reason, players(name, nickname)")
    .eq("team_id", teamId);
  return (data ?? []).map(u => ({
    id: u.id, scheduleWeekId: u.schedule_week_id, playerNum: u.player_num,
    playerName: u.players?.name ?? "", playerNickname: u.players?.nickname ?? "",
    reason: u.reason ?? "",
  }));
}

// Self-service: a player marking themselves unavailable for one of their
// team's weeks (or a captain/manager logging it on their behalf). Upserts
// on (schedule_week_id, player_num) -- re-marking the same week just
// updates the reason rather than creating a duplicate.
export async function setUnavailability(teamId, scheduleWeekId, playerNum, reason, profileId) {
  const { error } = await supabase.from("lineup_unavailability")
    .upsert({ team_id: teamId, schedule_week_id: scheduleWeekId, player_num: playerNum, reason: (reason ?? "").trim() || null, created_by: profileId, updated_at: new Date().toISOString() },
      { onConflict: "schedule_week_id,player_num" });
  return !error;
}

// Clears a previously-marked unavailability (the player is available again
// after all, or the captain/manager is correcting an entry).
export async function clearUnavailability(teamId, scheduleWeekId, playerNum) {
  const { error } = await supabase.from("lineup_unavailability")
    .delete().eq("team_id", teamId).eq("schedule_week_id", scheduleWeekId).eq("player_num", playerNum);
  return !error;
}

export async function saveManualMatch(row) {
  const { data, error } = await supabase.from("completed_matches").insert({ ...row, source: "manual" }).select().single();
  return error ? null : data;
}

export async function deleteCompletedMatch(id) {
  const { error } = await supabase.from("completed_matches").delete().eq("id", id);
  return !error;
}

// ─── Reopening a confirmed match for correction ────────────────────────────
// Single gated entry point (security-definer RPC) -- manager any time,
// captain only same-day. See section 29 migration for the exact rule.
export async function reopenMatchForEditing(matchId) {
  const { data, error } = await supabase.rpc("reopen_match_for_editing", { p_match_id: matchId });
  if (error) return { ok: false, reason: "ERROR" };
  const row = data?.[0];
  return row ?? { ok: false, reason: "ERROR" };
}

// Recomputes match-level totals from a full state (with the corrected set
// already merged in) -- shared by both the captain (propose/confirm) and
// manager (apply-direct) paths below so a one-set edit always rolls up the
// same way archiveMatch's first pass does, format-specific scoring included.
function recomputeMatchTotals(state) {
  const sets = state.sets ?? [];
  const homeTotal = sets.filter(s => s.winnerSlot === "home").length;
  const awayTotal = sets.filter(s => s.winnerSlot === "away").length;
  const { homePoints, awayPoints } = computeMatchPoints(state);
  return { homeTotal, awayTotal, homePoints, awayPoints };
}

// Captain path, step 1: propose a corrected version of ONE set (pre-filled
// with what was actually tracked, edited by the captain) -- NOT applied yet.
// Sits as pending_correction until the OTHER team's captain reviews it, so
// the fix carries the same two-sides-agree guarantee the original score
// did, without re-scoring the 4 sets that weren't wrong.
export async function proposeSetCorrection(matchId, updatedSet, proposedByProfileId, proposedByTeam) {
  const { error } = await supabase.from("completed_matches").update({
    pending_correction: {
      setNum: updatedSet.setNum, updatedSet, proposedBy: proposedByProfileId,
      proposedByTeam, proposedAt: new Date().toISOString(),
    },
  }).eq("id", matchId);
  return !error;
}

// Captain path, step 2: the OTHER captain accepts or rejects the pending
// proposal. Accepting merges the corrected set into state.sets, recomputes
// match totals from the full set list, and logs a before/after entry.
// Rejecting just clears the proposal -- nothing about the match changes.
export async function respondToSetCorrection(matchId, accept) {
  const { data: prior } = await supabase.from("completed_matches")
    .select("state,team_home_total,team_away_total,team_home_points,team_away_points,correction_history,pending_correction")
    .eq("id", matchId).maybeSingle();
  if (!prior || !prior.pending_correction) return false;

  if (!accept) {
    const { error } = await supabase.from("completed_matches")
      .update({ pending_correction: null, reopened_at: null, reopened_by: null }).eq("id", matchId);
    return !error;
  }

  const { setNum, updatedSet, proposedBy } = prior.pending_correction;
  const sets = (prior.state?.sets ?? []).map(s => s.setNum === setNum ? updatedSet : s);
  const mergedState = { ...prior.state, sets };
  const totals = recomputeMatchTotals(mergedState);
  const entry = {
    at: new Date().toISOString(), by: proposedBy, reason: `Set ${setNum} corrected`,
    before: { homeTotal: prior.team_home_total, awayTotal: prior.team_away_total, homePoints: prior.team_home_points, awayPoints: prior.team_away_points },
    after: { homeTotal: totals.homeTotal, awayTotal: totals.awayTotal, homePoints: totals.homePoints, awayPoints: totals.awayPoints },
  };
  const { error } = await supabase.from("completed_matches").update({
    state: mergedState,
    team_home_total: totals.homeTotal, team_away_total: totals.awayTotal,
    team_home_points: totals.homePoints, team_away_points: totals.awayPoints,
    correction_history: [...(prior.correction_history ?? []), entry],
    pending_correction: null, reopened_at: null, reopened_by: null,
  }).eq("id", matchId);
  return !error;
}

// Manager path: apply a corrected set immediately, no proposal/confirm step
// -- re-coordinating both captains days later isn't realistic, so the
// manager's authority stands in for it. Same recompute + audit log as above.
export async function applySetCorrectionDirect(matchId, updatedSet, reason) {
  const { data: prior } = await supabase.from("completed_matches")
    .select("state,team_home_total,team_away_total,team_home_points,team_away_points,correction_history,reopened_by")
    .eq("id", matchId).maybeSingle();
  if (!prior) return false;
  const sets = (prior.state?.sets ?? []).map(s => s.setNum === updatedSet.setNum ? updatedSet : s);
  const mergedState = { ...prior.state, sets };
  const totals = recomputeMatchTotals(mergedState);
  const entry = {
    at: new Date().toISOString(), by: prior.reopened_by ?? null, reason: reason || `Set ${updatedSet.setNum} corrected`,
    before: { homeTotal: prior.team_home_total, awayTotal: prior.team_away_total, homePoints: prior.team_home_points, awayPoints: prior.team_away_points },
    after: { homeTotal: totals.homeTotal, awayTotal: totals.awayTotal, homePoints: totals.homePoints, awayPoints: totals.awayPoints },
  };
  const { error } = await supabase.from("completed_matches").update({
    state: mergedState,
    team_home_total: totals.homeTotal, team_away_total: totals.awayTotal,
    team_home_points: totals.homePoints, team_away_points: totals.awayPoints,
    correction_history: [...(prior.correction_history ?? []), entry],
    pending_correction: null, reopened_at: null, reopened_by: null,
  }).eq("id", matchId);
  return !error;
}

// Lets a captain back out of a reopen without proposing anything (e.g. they
// meant a different set, or realized the number was actually right).
export async function cancelReopen(matchId) {
  const { error } = await supabase.from("completed_matches")
    .update({ reopened_at: null, reopened_by: null, pending_correction: null }).eq("id", matchId);
  return !error;
}

// ─── Standings & MVP (pure client-side aggregation over archived matches) ──
// Data volume for a weekly league is small (tens of matches per season), so
// this is computed in JS from already-fetched rows rather than a SQL view --
// simpler to read, and just as fast at this scale.
// ─── Standings & MVP (pure client-side aggregation over archived matches) ──
// Data volume for a weekly league is small (tens of matches per season), so
// this is computed in JS from already-fetched rows rather than a SQL view --
// simpler to read, and just as fast at this scale.
//
// Ranks by accumulated points (totalPoints), matching the real IBA Division
// Standings report -- not by win/loss record, which the real report doesn't
// even track. Wins/losses/sets are still tracked as secondary info.
export function computeStandings(matches, adjustments = []) {
  const byTeam = {}; // key -> { teamId, name, wins, losses, setsFor, setsAgainst, totalPoints, setsPlayed }
  const bump = (id, name) => { if (!byTeam[id]) byTeam[id] = { teamId: id, name, wins: 0, losses: 0, setsFor: 0, setsAgainst: 0, totalPoints: 0, setsPlayed: 0 }; };
  for (const m of matches) {
    if (!m.team_home_id || !m.team_away_id) continue;
    bump(m.team_home_id, m.team_home_name);
    bump(m.team_away_id, m.team_away_name);
    if (m.is_makeup_pending) continue; // not finished yet (even if some tables were played) -- doesn't count toward wins/losses/sets until the makeup is completed
    const h = byTeam[m.team_home_id], a = byTeam[m.team_away_id];
    h.setsFor += m.team_home_total ?? 0; h.setsAgainst += m.team_away_total ?? 0;
    a.setsFor += m.team_away_total ?? 0; a.setsAgainst += m.team_home_total ?? 0;
    h.totalPoints += m.team_home_points ?? 0; a.totalPoints += m.team_away_points ?? 0;
    const setsThisMatch = (m.team_home_total ?? 0) + (m.team_away_total ?? 0);
    h.setsPlayed += setsThisMatch; a.setsPlayed += setsThisMatch;
    if (m.team_home_total > m.team_away_total) { h.wins++; a.losses++; }
    else if (m.team_away_total > m.team_home_total) { a.wins++; h.losses++; }
  }
  // Imported weeks (real IBA report snapshots, one per team per week -- see
  // standings_adjustments_current) add their points/sets on top of anything
  // computed from real archived matches, same additive model as before.
  // Keyed by team_id when the imported team name matched a real team, else
  // by name so it still shows up rather than silently vanishing.
  for (const adj of adjustments) {
    const key = adj.team_id ?? `manual:${adj.team_name}`;
    bump(key, adj.team_name);
    byTeam[key].wins += adj.wins ?? 0;
    byTeam[key].losses += adj.losses ?? 0;
    byTeam[key].setsFor += adj.sets_for ?? 0;
    byTeam[key].setsAgainst += adj.sets_against ?? 0;
    byTeam[key].totalPoints += adj.total_points ?? 0;
    byTeam[key].setsPlayed += adj.sets_played ?? 0;
  }
  return Object.values(byTeam)
    .map(t => ({ ...t, pointsPerSet: t.setsPlayed ? Math.round((t.totalPoints / t.setsPlayed) * 10) / 10 : 0 }))
    .sort((x, y) => y.totalPoints - x.totalPoints);
}

// MVP ranking = points scored + 200 per set win (0 for a forfeit win) - 200
// per set loss -- verified exactly against real IBA MVP Standings report
// data. Real matches compute this themselves (forfeit status is known here);
// imported weeks use the report's own pre-computed ranking total instead of
// guessing, since an import doesn't reveal which of a player's wins were
// forfeits (which would change the bonus).
export function computeMvp(matches, adjustments = []) {
  const byPlayer = {}; // key -> { num, name, sets, wins, losses, forfeitWins, pointsScored, mvpRanking }
  const bump = (num, name) => { if (!byPlayer[num]) byPlayer[num] = { num, name, sets: 0, wins: 0, losses: 0, forfeitWins: 0, pointsScored: 0, mvpRanking: 0 }; };
  for (const m of matches) {
    const format = (m.state?.format || m.format || "masters").toLowerCase();
    const isMasters = format === "masters";
    const fixedTarget = format === "open" ? 45 : 50;
    for (const s of m.state?.sets ?? []) {
      if (!s.complete) continue;
      const home = s.playerHome, away = s.playerAway;
      if (!home || !away) continue;
      bump(home.num, home.name); bump(away.num, away.name);
      byPlayer[home.num].sets++; byPlayer[away.num].sets++;

      if (s.forfeited) {
        const winner = s.forfeitedBy === "home" ? away : home;
        const loser = s.forfeitedBy === "home" ? home : away;
        byPlayer[winner.num].wins++; byPlayer[winner.num].forfeitWins++;
        byPlayer[winner.num].pointsScored += s.forfeitPoints ?? 0;
        byPlayer[winner.num].mvpRanking += s.forfeitPoints ?? 0; // forfeit win: no +200 bonus
        byPlayer[loser.num].losses++;
        byPlayer[loser.num].mvpRanking -= 200;
        continue;
      }

      const runHome = (s.racks ?? []).reduce((t, r) => t + (r.home ?? 0), 0);
      const runAway = (s.racks ?? []).reduce((t, r) => t + (r.away ?? 0), 0);
      const eitherUnrated = isUnratedRatingDb(home.rating) || isUnratedRatingDb(away.rating);
      const targetHome = eitherUnrated ? fixedTarget : home.rating;
      const targetAway = eitherUnrated ? fixedTarget : away.rating;

      if (s.winnerSlot === "home") {
        const margin = Math.max(0, (targetAway ?? 0) - runAway);
        const homePoints = isMasters ? (margin * 3 + 100) : (runHome + margin * 3 + 100);
        byPlayer[home.num].pointsScored += homePoints;
        byPlayer[away.num].pointsScored += isMasters ? 0 : runAway;
        byPlayer[home.num].wins++; byPlayer[away.num].losses++;
        byPlayer[home.num].mvpRanking += homePoints + 200;
        byPlayer[away.num].mvpRanking += (isMasters ? 0 : runAway) - 200;
      } else if (s.winnerSlot === "away") {
        const margin = Math.max(0, (targetHome ?? 0) - runHome);
        const awayPoints = isMasters ? (margin * 3 + 100) : (runAway + margin * 3 + 100);
        byPlayer[away.num].pointsScored += awayPoints;
        byPlayer[home.num].pointsScored += isMasters ? 0 : runHome;
        byPlayer[away.num].wins++; byPlayer[home.num].losses++;
        byPlayer[away.num].mvpRanking += awayPoints + 200;
        byPlayer[home.num].mvpRanking += (isMasters ? 0 : runHome) - 200;
      }
    }
  }
  // Imported weeks: trust the report's own pre-computed ranking total.
  for (const adj of adjustments) {
    const key = adj.player_num ?? `manual:${adj.player_name}`;
    bump(key, adj.player_name);
    byPlayer[key].wins += adj.wins ?? 0;
    byPlayer[key].losses += adj.losses ?? 0;
    byPlayer[key].sets += (adj.wins ?? 0) + (adj.losses ?? 0);
    byPlayer[key].pointsScored += adj.total_points ?? 0;
    byPlayer[key].mvpRanking += adj.mvp_ranking_points ?? 0;
  }
  return Object.values(byPlayer).sort((x, y) => y.mvpRanking - x.mvpRanking);
}

// One player's own slice of computeMvp's scan -- same trusted formula the
// real MVP standings use, just narrowed to a single player_num instead of
// ranking everyone. Scoped to the player's CURRENT team's division (v1
// simplification -- a player's full history across every division they've
// ever played in would need a broader query; noted as a natural next step,
// not built here).
export async function getMyStats(profile) {
  if (!profile?.team_id || !profile?.player_num) return null;
  const { data: teamRow } = await supabase.from("teams").select("division_id").eq("id", profile.team_id).maybeSingle();
  if (!teamRow) return null;
  const [matches, adjustments] = await Promise.all([
    listCompletedMatches(teamRow.division_id),
    listMvpAdjustments(teamRow.division_id),
  ]);
  const ranked = computeMvp(matches, adjustments);
  return ranked.find(p => p.num === profile.player_num)
    ?? { num: profile.player_num, sets: 0, wins: 0, losses: 0, forfeitWins: 0, pointsScored: 0, mvpRanking: 0 };
}

// ─── Standings / MVP seed imports ───────────────────────────────────────────
export async function listStandingsAdjustments(divisionId) {
  const { data } = await supabase.from("standings_adjustments_current").select("*").eq("division_id", divisionId);
  return data ?? [];
}
// Importing a new week always adds a new row per team (division_id, team_name,
// week_key) -- same accumulate-over-time behavior as player_ratings.
// Re-importing the SAME week updates just that week's row, not a duplicate.
// listStandingsAdjustments only ever sees each team's latest week (via the
// standings_adjustments_current view), so history accumulates underneath
// without inflating what standings computation actually uses.
// Matches by team NUMBER (the real report's "Team" column), not name -- far
// more reliable than fuzzy name matching, and it's what the report actually
// gives us.
export async function importStandingsForWeek(divisionId, rows, teams, weekTag) {
  const teamByNum = new Map((teams ?? []).map(t => [t.teamNum, t.id]));
  const inserted = rows.map(r => ({
    division_id: divisionId,
    team_id: teamByNum.get(r.teamNum) ?? null,
    team_num: r.teamNum,
    team_name: r.teamName,
    points_last_wk: r.pointsLastWk, total_points: r.totalPoints, sets_played: r.setsPlayed,
    week_key: weekTag.weekKey, label: weekTag.label,
  }));
  if (inserted.length === 0) return true;
  const { error } = await supabase.from("standings_adjustments").upsert(inserted, { onConflict: "division_id,team_name,week_key" });
  return !error;
}

export async function listMvpAdjustments(divisionId) {
  const { data } = await supabase.from("mvp_adjustments_current").select("*").eq("division_id", divisionId);
  return data ?? [];
}
// Player numbers are now validated against the real registry (players.num)
// rather than left unmatched -- the real MVP report includes a genuine
// player number, no guessing required. Unrecognized numbers still import
// (falls back to the name-keyed "manual:" row) rather than being dropped.
export async function importMvpForWeek(divisionId, rows, weekTag) {
  const nums = rows.map(r => r.playerNum).filter(Boolean);
  const { data: knownPlayers } = nums.length ? await supabase.from("players").select("num").in("num", nums) : { data: [] };
  const knownNums = new Set((knownPlayers ?? []).map(p => p.num));
  const inserted = rows.map(r => ({
    division_id: divisionId,
    player_num: knownNums.has(r.playerNum) ? r.playerNum : null,
    player_name: r.playerName,
    team_num: r.teamNum,
    wins: r.wins, losses: r.losses, total_points: r.pointsScored, mvp_ranking_points: r.mvpRankingPoints,
    week_key: weekTag.weekKey, label: weekTag.label,
  }));
  if (inserted.length === 0) return true;
  const { error } = await supabase.from("mvp_adjustments").upsert(inserted, { onConflict: "division_id,player_name,week_key" });
  return !error;
}

// ─── Playoff eligibility (Division Playoffs - Roster and Handicap Report) ──
// Only ever pasted during playoff weeks -- see parsePlayoffEligibility() in
// AdminApp.jsx for the report parser. Same append-a-week-snapshot model as
// ratings/standings/MVP: one row per (division, player, week), upserted so
// re-importing the same week updates it. Player numbers are validated
// against the real players registry the same way the MVP importer does --
// an unmatched number still imports under its player_name, but can't be
// tied back to a specific roster player for live-scoring gating (see
// eligibilityByPlayerNum below).
export const ELIGIBILITY_REASONS = {
  E: "Eligible for playoffs.",
  T: "Ineligible — less than 4 sets played with this team.",
  A: "Ineligible — no membership application on file.",
  S: "Ineligible — too few calculated scores in rating history.",
};

export async function importPlayoffEligibilityForWeek(divisionId, rows, weekTag) {
  const nums = rows.map(r => r.num).filter(Boolean);
  const { data: knownPlayers } = nums.length ? await supabase.from("players").select("num").in("num", nums) : { data: [] };
  const knownNums = new Set((knownPlayers ?? []).map(p => p.num));
  const inserted = rows.map(r => ({
    division_id: divisionId,
    player_num: knownNums.has(r.num) ? r.num : null,
    player_name: r.name,
    team_num: r.teamNum,
    elig_code: r.eligCode,
    week_key: weekTag.weekKey, label: weekTag.label,
  }));
  const unmatchedCount = rows.filter(r => r.num && !knownNums.has(r.num)).length;
  if (inserted.length === 0) return { ok: true, unmatchedCount: 0 };
  const { error } = await supabase.from("player_playoff_eligibility").upsert(inserted, { onConflict: "division_id,player_name,week_key" });
  return { ok: !error, unmatchedCount };
}

export async function listPlayoffEligibility(divisionId) {
  if (!divisionId) return [];
  const { data } = await supabase.from("player_playoff_eligibility_current").select("*").eq("division_id", divisionId);
  return data ?? [];
}

// { [player_num]: { code: 'E'|'T'|'A'|'S', weekKey, label } } -- only rows
// that actually resolved to a real player_num can gate a specific roster
// player's draft eligibility; an unmatched (name-only) row can't be tied to
// anyone in particular, so it's left out of this map even though it still
// exists in the raw table for reference.
export function eligibilityByPlayerNum(rows) {
  const map = {};
  for (const r of rows ?? []) {
    if (r.player_num) map[r.player_num] = { code: r.elig_code, weekKey: r.week_key, label: r.label };
  }
  return map;
}


// ─── Live match ─────────────────────────────────────────────────────────────
// One row per scheduled pairing (id = schedule_pairings.id) -- lets multiple
// matches be scored concurrently instead of sharing one global slot.
export async function getLiveMatch(pairingId) {
  if (!pairingId) return null;
  const { data } = await supabase.from("live_match").select("state").eq("id", pairingId).maybeSingle();
  return data?.state ?? null;
}
// Writes go through a security-definer RPC, not a direct table write -- it's
// the single real enforcement point for "can this person touch this match
// right now" (manager, holds either side's claim, or the row doesn't exist
// yet). See section 33 migration.
export async function setLiveMatch(pairingId, state) {
  if (!pairingId) return false;
  const { data, error } = await supabase.rpc("write_live_match_state", { p_pairing_id: pairingId, p_state: state });
  return !error && data === true;
}

// Which side (if any) a profile is eligible to score for on this match --
// either a direct account-to-team link, or a roster-number link (covers
// both ways someone ends up connected to a team in this app). Managers are
// eligible for either side (full authority), never blocked by the claim
// system.
export function eligibleSide(match, profile) {
  if (!profile) return null;
  if (profile.team_id === match.teamHome?.id) return "home";
  if (profile.team_id === match.teamAway?.id) return "away";
  if (profile.player_num) {
    if (match.teamHome?.roster?.some(p => p.num === profile.player_num)) return "home";
    if (match.teamAway?.roster?.some(p => p.num === profile.player_num)) return "away";
  }
  return null;
}

// Claim (or take over) a side -- unconditional, no approval step. Whoever
// taps this most recently owns it; the same person can reclaim it later if
// someone else took over in the meantime. Eligibility (team_id or roster
// number match) is checked server-side in the RPC, not trusted from the
// client -- see section 33 migration.
export async function claimScoringSide(pairingId, side) {
  const { data, error } = await supabase.rpc("claim_scoring_side", { p_pairing_id: pairingId, p_side: side });
  return !error && data === true;
}

// Marks the OTHER side as having no one available to score -- lets the one
// active side's confirmation alone finalize the match instead of waiting on
// a confirmation that's never coming. No validation against the other
// team's roster itself, by design -- but the RPC does require the caller to
// currently hold the opposing side's claim (or be a manager), so a stranger
// can't lock an actively-scored side out this way.
export async function markSideUnavailable(pairingId, side) {
  const { data, error } = await supabase.rpc("mark_side_unavailable", { p_pairing_id: pairingId, p_side: side });
  return !error && data === true;
}

// ─── Practice mode ──────────────────────────────────────────────────────────
// A real league player's latest rating -- used to auto-fill Match mode for a
// picked-from-search opponent, and for the signed-in player's own rating.
export async function getPlayerRating(playerNum) {
  if (!playerNum) return null;
  const { data } = await supabase.from("player_current_ratings").select("rating").eq("player_num", playerNum).maybeSingle();
  return data?.rating ?? null;
}

// Previously-typed-in (no-login) opponents, most recently created first --
// so a name doesn't have to be retyped every session.
export async function listMyPracticeOpponents(profileId) {
  const { data } = await supabase.from("practice_opponents").select("*").eq("created_by", profileId).order("created_at", { ascending: false });
  return data ?? [];
}
// Reuses an existing opponent with the same name (case-insensitive) instead
// of creating a duplicate every time the same person is typed in again.
export async function findOrCreatePracticeOpponent(profileId, name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { data: existing } = await supabase.from("practice_opponents").select("*")
    .eq("created_by", profileId).ilike("name", trimmed).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase.from("practice_opponents").insert({ created_by: profileId, name: trimmed }).select().single();
  return error ? null : data;
}
// Narrow search (id + username only) so any player can look up an account to
// link a practice opponent to -- doesn't expose phone/email like listProfiles().
export async function searchProfilesByUsername(query) {
  if (!query || query.trim().length < 2) return [];
  const { data, error } = await supabase.rpc("search_profiles_by_username", { p_query: query.trim() });
  return error ? [] : (data ?? []);
}
// Manual link only -- never inferred by name match. Once linked, that
// opponent's past and future practice games are understood to be against
// the real account (the app resolves display/head-to-head off whichever of
// opponent_player_num/opponent_id/linked_profile_id is present).
export async function linkPracticeOpponent(opponentId, profileId) {
  const { error } = await supabase.from("practice_opponents").update({ linked_profile_id: profileId }).eq("id", opponentId);
  return !error;
}

export async function savePracticeGame(row) {
  const { data, error } = await supabase.from("practice_games").insert(row).select().single();
  return error ? null : data;
}
export async function listMyPracticeGames(profileId) {
  const { data } = await supabase.from("practice_games").select("*").eq("created_by", profileId).order("played_at", { ascending: false });
  return data ?? [];
}

// ─── Shot tracking ("Track a Rack") ─────────────────────────────────────────
// Optional, granular shot-level detail -- entirely separate from the actual
// confirmed score/result. context_type + context_id is a loose (no-FK)
// polymorphic pointer into whichever table the play is happening in
// (live_match, completed_matches for a manual entry, or practice_games) --
// see section 45 for the reasoning. Never required, never blocks anything,
// never seen by the other team as part of dual-confirm.
export async function logShotEvent(event) {
  const { data, error } = await supabase.from("shot_events").insert(event).select().single();
  return error ? null : data;
}
export async function listShotEvents(contextType, contextId, setNum) {
  let q = supabase.from("shot_events").select("*").eq("context_type", contextType).eq("context_id", contextId);
  if (setNum != null) q = q.eq("set_num", setNum);
  const { data } = await q.order("created_at");
  return data ?? [];
}
export async function deleteShotEvent(id) {
  const { error } = await supabase.from("shot_events").delete().eq("id", id);
  return !error;
}
// Every event this player has ever been tracked for, across league
// (live + manual) and practice alike -- what My Stats' Advanced Stats card
// (and any future team/tournament breakdown) aggregates over.
export async function listMyShotEvents(playerNum) {
  if (!playerNum) return [];
  const { data } = await supabase.from("shot_events").select("*").eq("player_num", playerNum).order("created_at", { ascending: false });
  return data ?? [];
}

// Pure aggregation over a list of shot_events rows -- shared by My Stats and
// any future stats section so the breakdown math never drifts between them.
export function computeShotStats(events) {
  const shots = events.filter(e => e.category === "shot");
  const breaks = events.filter(e => e.category === "break");
  const safeties = events.filter(e => e.category === "safety");
  const runouts = events.filter(e => e.category === "runout");
  const makes = shots.filter(e => e.outcome === "make").length;
  const tagStat = (tag) => {
    const list = shots.filter(e => (e.tags ?? []).includes(tag));
    const made = list.filter(e => e.outcome === "make").length;
    return { attempts: list.length, makes: made, pct: list.length ? Math.round((made / list.length) * 100) : 0 };
  };
  const safeMade = safeties.filter(e => e.outcome === "successful").length;
  return {
    totalShots: shots.length,
    makes, misses: shots.filter(e => e.outcome === "miss").length,
    makePct: shots.length ? Math.round((makes / shots.length) * 100) : 0,
    scratches: events.filter(e => e.is_scratch).length,
    fouls: events.filter(e => e.is_foul).length,
    miscues: events.filter(e => e.is_miscue).length,
    byDistance: { short: tagStat("short"), medium: tagStat("medium"), long: tagStat("long") },
    byCut: { left: tagStat("cut_left"), right: tagStat("cut_right") },
    byTechnique: { jump: tagStat("jump"), kick: tagStat("kick"), bank: tagStat("bank") },
    safeties: { attempts: safeties.length, successful: safeMade, pct: safeties.length ? Math.round((safeMade / safeties.length) * 100) : 0 },
    breaks: { attempts: breaks.length, made: breaks.filter(e => e.outcome === "make").length, scratches: breaks.filter(e => e.is_scratch).length },
    runouts: runouts.length,
  };
}

// Resolves player_num -> {name, nickname} for a batch of nums. Fetched
// separately and merged client-side (not embedded via PostgREST) because
// shot_events has TWO foreign keys into players (player_num and
// opponent_player_num), which is exactly the kind of ambiguous-relationship
// case this app already avoids elsewhere -- e.g. player_current_ratings --
// by fetching separately rather than trying to embed.
export async function getPlayerNameMap(nums) {
  const clean = [...new Set(nums.filter(Boolean))];
  if (clean.length === 0) return {};
  const { data } = await supabase.from("players").select("num, name, nickname").in("num", clean);
  return Object.fromEntries((data ?? []).map(p => [p.num, { name: p.name, nickname: p.nickname ?? "" }]));
}

// Narrows a list of shot_events down to one game type and/or one play type
// (context_type) -- shared filter used by every stats view below so "8-ball
// only" / "league only" behaves identically everywhere.
export function filterShotEvents(events, { gameType, playType } = {}) {
  return events.filter(e =>
    (!gameType || e.game_type === gameType) &&
    (!playType || e.context_type === playType)
  );
}

// One player's own events, grouped by opponent -- the head-to-head
// breakdown in My Stats. Events with no resolvable opponent (e.g. a
// practice game against a manually-typed, no-account opponent) land in an
// explicit "Unknown / Manual Opponent" bucket rather than being dropped.
export async function computeHeadToHead(events) {
  const byOpp = {};
  for (const e of events) {
    const key = e.opponent_player_num || "unknown";
    (byOpp[key] ??= []).push(e);
  }
  const names = await getPlayerNameMap(Object.keys(byOpp).filter(k => k !== "unknown"));
  return Object.entries(byOpp)
    .map(([key, evs]) => ({
      opponentNum: key === "unknown" ? null : key,
      name: key === "unknown" ? "Unknown / Manual Opponent" : (names[key]?.name ?? key),
      nickname: key === "unknown" ? "" : (names[key]?.nickname ?? ""),
      stats: computeShotStats(evs),
    }))
    .sort((a, b) => b.stats.totalShots - a.stats.totalShots);
}

// Every shot event tracked anywhere, leaguewide, across every play type and
// game type -- powers the leaderboard. No season/division scoping yet
// (all-time) -- a natural next refinement once this has real volume behind
// it; noted here rather than silently guessed at.
export async function listAllShotEvents() {
  const { data } = await supabase.from("shot_events").select("*").order("created_at", { ascending: false });
  return data ?? [];
}

// Groups a list of shot_events by player_num and computes each player's
// stats + display name -- the leaderboard's core aggregation, but general
// enough for any future "rank players by X" view.
export async function computeLeaderboard(events) {
  const byPlayer = {};
  for (const e of events) (byPlayer[e.player_num] ??= []).push(e);
  const names = await getPlayerNameMap(Object.keys(byPlayer));
  return Object.entries(byPlayer).map(([num, evs]) => ({
    playerNum: num, name: names[num]?.name ?? num, nickname: names[num]?.nickname ?? "",
    stats: computeShotStats(evs),
  }));
}

// Every shot event tied to a team's roster (via the denormalized team_id
// column on shot_events) -- powers the captain-facing Team Stats view.
export async function listTeamShotEvents(teamId) {
  const { data } = await supabase.from("shot_events").select("*").eq("team_id", teamId).order("created_at", { ascending: false });
  return data ?? [];
}

// Team-wide rollup plus a per-player breakdown, sorted by who has the most
// tracked shots -- companion to listTeamShotEvents.
export async function computeTeamShotBreakdown(events) {
  const byPlayer = {};
  for (const e of events) (byPlayer[e.player_num] ??= []).push(e);
  const names = await getPlayerNameMap(Object.keys(byPlayer));
  const perPlayer = Object.entries(byPlayer)
    .map(([num, evs]) => ({ playerNum: num, name: names[num]?.name ?? num, stats: computeShotStats(evs) }))
    .sort((a, b) => b.stats.totalShots - a.stats.totalShots);
  return { team: computeShotStats(events), perPlayer };
}

// Every division across every season, flattened with a human-readable
// season label attached -- powers the leaderboard's division picker.
// Reuses listSeasons() (already fetches seasons with nested divisions)
// rather than a second query.
export async function listAllDivisionsFlat() {
  const seasons = await listSeasons();
  const divs = [];
  for (const s of seasons) {
    for (const d of (s.divisions ?? [])) {
      divs.push({ id: d.id, num: d.num, name: d.name, isActive: s.is_active,
        seasonLabel: `${s.type} ${s.year} · ${s.format} · ${s.day}` });
    }
  }
  return divs;
}

// Plain CSV of raw shot_events rows, names resolved via nameMap (from
// getPlayerNameMap) where available, falling back to the bare player_num.
// Pure and synchronous -- callers resolve names first, once, and pass the
// map in, rather than this function doing its own round trip per call.
export function shotEventsToCSV(events, nameMap = {}) {
  const header = ["Date", "Player", "Opponent", "Play Type", "Game Type", "Category", "Outcome", "Scratch", "Foul", "Miscue", "Tags"];
  const nameFor = (num) => num ? (nameMap[num]?.name ?? num) : "";
  const rows = events.map(e => [
    new Date(e.created_at).toLocaleString(),
    nameFor(e.player_num), nameFor(e.opponent_player_num),
    e.context_type === "practice_game" ? "Practice" : "League",
    e.game_type ?? "", e.category, e.outcome ?? "",
    e.is_scratch ? "Y" : "", e.is_foul ? "Y" : "", e.is_miscue ? "Y" : "",
    (e.tags ?? []).join("/"),
  ]);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [header, ...rows].map(r => r.map(esc).join(",")).join("\n");
}

// Triggers a browser download of a CSV string -- no server round trip, no
// new dependency, works the same on desktop and mobile browsers.
export function downloadCSV(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Player profile (season/career scoping, team history) ─────────────────
// Every team a player has ever been rostered on, with its division/season
// context -- generic over ANY player_num, not just the signed-in user, so
// it powers both My Stats (yourself) and Player Lookup (anyone). Reuses the
// same "rosters never get deleted across seasons" fact already relied on
// elsewhere. One row per team, not merged/deduped by season -- a rare
// mid-season team change shows as two distinct rows, which is correct
// (they really were on two different rosters), and the UI groups rows by
// season_id itself where a single "which season" selection is needed.
export async function listPlayerTeamHistory(playerNum) {
  const { data: rosterRows } = await supabase.from("rosters").select("team_id").eq("player_num", playerNum);
  const teamIds = [...new Set((rosterRows ?? []).map(r => r.team_id))];
  if (teamIds.length === 0) return [];
  const { data: teamRows } = await supabase.from("teams")
    .select("id, name, team_num, division_id, divisions(id, num, name, season_id, seasons(id, type, year, format, day, is_active))")
    .in("id", teamIds);
  return (teamRows ?? []).map(t => {
    const d = t.divisions, s = d?.seasons;
    return {
      teamId: t.id, teamName: t.name, teamNum: t.team_num,
      divisionId: d?.id ?? null, divisionNum: d?.num ?? null, divisionName: d?.name ?? "",
      seasonId: s?.id ?? null, seasonType: s?.type ?? "", seasonYear: s?.year ?? null,
      seasonFormat: s?.format ?? "", seasonDay: s?.day ?? "", isActive: !!s?.is_active,
    };
  }).sort((a, b) => (b.isActive - a.isActive) || ((b.seasonYear ?? 0) - (a.seasonYear ?? 0)));
}

// Win/loss/points/MVP-ranking record aggregated across one or more
// divisions -- pass a single division's id for "this season only," or
// every division a player has ever played in (from listPlayerTeamHistory)
// for a true career record. Generalizes what getMyStats() used to do
// single-division-only; getMyStats() is left as-is since nothing else
// calls it, but My Stats and Player Lookup both use this instead now.
export async function getStatsForDivisions(playerNum, divisionIds) {
  const zero = { num: playerNum, sets: 0, wins: 0, losses: 0, forfeitWins: 0, pointsScored: 0, mvpRanking: 0 };
  if (!divisionIds || divisionIds.length === 0) return zero;
  const results = await Promise.all(divisionIds.map(id => Promise.all([listCompletedMatches(id), listMvpAdjustments(id)])));
  const allMatches = results.flatMap(r => r[0]);
  const allAdjustments = results.flatMap(r => r[1]);
  const ranked = computeMvp(allMatches, allAdjustments);
  return ranked.find(p => p.num === playerNum) ?? zero;
}

// One team's wins/losses/points/sets-for/sets-against within its division's
// real standings, plus its rank -- runs the exact same computeStandings()
// formula the division's own Standings tab uses (points-based, matching the
// real IBA report), scoped to the whole division so the rank is accurate,
// then picks out just this one team's row. Powers Team Lookup's record card.
export async function getTeamStandingsRow(teamId, divisionId) {
  const [matches, adjustments] = await Promise.all([listCompletedMatches(divisionId), listStandingsAdjustments(divisionId)]);
  const standings = computeStandings(matches, adjustments);
  const idx = standings.findIndex(s => s.teamId === teamId);
  if (idx === -1) return null;
  return { ...standings[idx], rank: idx + 1, totalTeams: standings.length };
}

// One player's MVP rank within a single division's real MVP standings --
// same pattern as getTeamStandingsRow above, just individuals instead of
// teams, and reusing computeMvp() (the exact formula the real MVP tab
// ranks by) rather than a separate calculation.
export async function getPlayerMvpRankRow(playerNum, divisionId) {
  const [matches, adjustments] = await Promise.all([listCompletedMatches(divisionId), listMvpAdjustments(divisionId)]);
  const ranked = computeMvp(matches, adjustments);
  const idx = ranked.findIndex(p => p.num === playerNum);
  if (idx === -1) return null;
  return { ...ranked[idx], rank: idx + 1, totalPlayers: ranked.length };
}

// ─── Playoff eligibility (section 41 — Division Playoffs Roster & Handicap
// Report import) ─────────────────────────────────────────────────────────
// One player's most recent imported eligibility row for a division (E/T/A/S
// code) -- null if that report has never been imported for this division or
// this player never resolved to a real player_num in it.
export async function getPlayerPlayoffEligibility(playerNum, divisionId) {
  const { data } = await supabase.from("player_playoff_eligibility_current")
    .select("*").eq("division_id", divisionId).eq("player_num", playerNum).maybeSingle();
  return data;
}
// Every player's latest eligibility row for a division at once -- powers a
// team roster view without one query per player. Rows with no resolved
// player_num (an unmatched name from the import) are still included; callers
// that key off player_num should filter those out themselves.
export async function listPlayoffEligibilityForDivision(divisionId) {
  const { data } = await supabase.from("player_playoff_eligibility_current").select("*").eq("division_id", divisionId);
  return data ?? [];
}

// ─── Team-vs-team head-to-head ─────────────────────────────────────────────
// Pure aggregation over a list of completed_matches rows (typically a
// team's own getTeamScheduleOverview().myCompleted, already fetched) --
// groups by opponent and tallies wins/losses/points. Teams are never reused
// across seasons in this schema (a fresh uuid every season), so a team's own
// match history is already scoped to exactly one season/division -- this
// never needs a season/division parameter of its own.
export function computeTeamHeadToHead(matches, teamId) {
  const byOpp = {};
  for (const m of matches) {
    if (m.team_home_id !== teamId && m.team_away_id !== teamId) continue;
    if (m.is_makeup_pending) continue; // not finished -- doesn't count toward the record yet
    const isHome = m.team_home_id === teamId;
    const oppId = isHome ? m.team_away_id : m.team_home_id;
    if (!oppId) continue;
    const oppName = isHome ? m.team_away_name : m.team_home_name;
    const myTotal = isHome ? m.team_home_total : m.team_away_total;
    const oppTotal = isHome ? m.team_away_total : m.team_home_total;
    const myPts = isHome ? m.team_home_points : m.team_away_points;
    const oppPts = isHome ? m.team_away_points : m.team_home_points;
    if (!byOpp[oppId]) byOpp[oppId] = { teamId: oppId, name: oppName, wins: 0, losses: 0, matchesPlayed: 0, myPoints: 0, oppPoints: 0 };
    const row = byOpp[oppId];
    row.matchesPlayed++;
    row.myPoints += myPts ?? 0;
    row.oppPoints += oppPts ?? 0;
    if ((myTotal ?? 0) > (oppTotal ?? 0)) row.wins++;
    else if ((oppTotal ?? 0) > (myTotal ?? 0)) row.losses++;
  }
  return Object.values(byOpp).sort((a, b) => b.matchesPlayed - a.matchesPlayed);
}

