import { useState, useEffect, useRef } from "react";
import {
  Users, Calendar, ChevronDown, ChevronUp, Plus, Trash2,
  Check, AlertCircle, Edit2, X, Settings, LogOut,
  Key, Eye, EyeOff, Copy, ChevronRight, Star, ArrowLeftRight
} from "lucide-react";
import { supabase } from "./supabaseClient";
import * as db from "./db";
import Scoresheet from "./Scoresheet";
import { useAuth } from "./AuthContext";
import { PageHeader, SubTabBar, SubTabBtn, AccessDenied, shellCss, TabBar } from "./Shell";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { parseStandingsImport, parseMvpImport, parseLeagueRoster } from "./ibaParsers";
import IbaAutoSyncPanel from "./IbaAutoSyncPanel";
import IbaScheduleImportPanel from "./IbaScheduleImportPanel";
// SetEntry is the exact same rack-by-rack (innings, safeties, timeouts)
// entry component live scoring uses -- reused here (not re-implemented) so
// manual match entry stays byte-for-byte consistent with live scoring math,
// and liveEntryCss brings its supporting classes (.set-entry, .player-bar,
// .rack-entry-form, .draft-roster-list, .coinflip-choices, etc).
import { SetEntry, css as liveEntryCss } from "./LiveEntryApp";

// ─── Season helpers ───────────────────────────────────────────────────────────
const SEASON_TYPES   = ["Summer", "Winter", "Spring"];
const SEASON_FORMATS = ["Masters", "Advanced", "Open"];
const SEASON_DAYS    = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const CURRENT_YEAR   = new Date().getFullYear();
const YEARS = [CURRENT_YEAR - 1, CURRENT_YEAR, CURRENT_YEAR + 1];

// Retained from Old version for zero-loss preservation; used by legacy/team import forms.
const US_STATE_CODES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
  "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
  "WV","WI","WY",
];

function seasonLabel(s) { return `${s.type} · ${s.year} · ${s.format} · ${s.day}`; }

// ─── Roles ────────────────────────────────────────────────────────────────────
const ROLES = {
  manager:    { label: "League Manager", color: "#F59E0B", bg: "#2A1F00", border: "#92400E" },
  captain:    { label: "Team Captain",   color: "#5FCF9E", bg: "#16332A", border: "#1F6B4A" },
  player:     { label: "Player",         color: "#6FA8DC", bg: "#16273A", border: "#1E3A5F" },
};

function generateCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

// ─── Playoff eligibility codes (section 41 import) ─────────────────────────
// Shared between Team Lookup (per-roster-player badges) and Player Lookup /
// My Stats (the player's own eligibility card) so the wording never drifts.
const PLAYOFF_ELIG_LABELS = {
  E: "Eligible",
  T: "Ineligible — fewer than 4 sets played with this team",
  A: "Ineligible — no membership application on file",
  S: "Ineligible — too few calculated scores in rating history",
};

// ─── Parsers ──────────────────────────────────────────────────────────────────
function parseTeams(raw) {
  const teams = [];
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\t+/);
    if (parts.length >= 2) {
      const teamNum = parts[0].trim(), name = parts[1].trim(), venue = parts[2]?.trim() ?? "";
      if (teamNum && name) teams.push({ teamNum, name, venue, isBye: /\bBYE\b/i.test(name) });
    }
  }
  return teams;
}

// Highest numeric team number in the list, plus 1 -- used to auto-generate a
// BYE team's number when an import comes in with an odd number of teams
// (every real division needs an even count so pairings always have an
// opponent). Team numbers are only meaningful within a single division/
// season -- this never looks outside the list it's given.
function nextTeamNumber(teamsList) {
  const nums = teamsList.map(t => parseInt(t.teamNum, 10)).filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return String(max + 1);
}

function parseSchedule(raw) {
  const weeks = []; let current = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const weekMatch = trimmed.match(/^(\d+)\s+([\d/]+)\s*(.*)/);
    if (weekMatch) {
      if (current) weeks.push(current);
      const note = weekMatch[3].trim();
      current = { week: parseInt(weekMatch[1]), date: weekMatch[2], pairings: [], note };
      if (note && !note.match(/^\d/)) current.special = note;
      continue;
    }
    const holidayMatch = trimmed.match(/^([\d/]+)\s+(.+)/);
    if (holidayMatch && !trimmed.match(/^(\d+)\s/)) {
      if (current) weeks.push(current);
      current = { week: null, date: holidayMatch[1], pairings: [], special: holidayMatch[2] };
      continue;
    }
    if (trimmed.includes("vs") && current) {
      const pairs = trimmed.split(/\s+/).filter(p => p.includes("vs"));
      for (const p of pairs) {
        const [home, away] = p.split("vs").map(Number);
        if (!isNaN(home) && !isNaN(away)) current.pairings.push({ home, away });
      }
    }
  }
  if (current) weeks.push(current);
  return weeks;
}

// Scans a parsed schedule for a week flagged as "Playoffs" in its label
// (e.g. a schedule row like "18  6/12/2025  Playoffs") and returns that
// week's date as YYYY-MM-DD, or null if no such week is present. If more
// than one week mentions "playoff" (e.g. separate rounds), the earliest
// date wins -- that's when playoffs start.
function detectPlayoffsStartDate(parsedWeeks) {
  const playoffWeeks = (parsedWeeks ?? []).filter(w => {
    const label = `${w.special ?? ""} ${w.note ?? ""}`.toLowerCase();
    return label.includes("playoff") && w.date;
  });
  if (!playoffWeeks.length) return null;
  const earliest = playoffWeeks.reduce((a, b) => parseDate(a.date) <= parseDate(b.date) ? a : b);
  try {
    const key = isoDateKey(earliest.date);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

function parsePlayers(raw) {
  const players = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t+|\s{2,}/);
    if (parts.length >= 2) {
      const name = parts[0].trim(), rating = parseInt(parts[parts.length - 1]);
      if (name && !isNaN(rating)) players.push({ name, rating });
    } else {
      const m = trimmed.match(/^(.+?)\s+(\d+)$/);
      if (m) players.push({ name: m[1].trim(), rating: parseInt(m[2]) });
    }
  }
  return players;
}

// ==================================================================
// Playoff eligibility report ("Division Playoffs - Roster and Handicap
// Report") -- a different report than the regular weekly ratings one,
// issued only during playoff weeks. Structurally close to the regular
// report's multi-column layout above (parseMultiColumnRateFirst) -- teams
// declared 3-across on a "Team NNNNN Name" header line, then data rows with
// one entry per team per line -- but each entry is "Rate Num Elig Name"
// instead of "Rate Num Play Win Name", and there's no Play/Win column at
// all. Only this one layout is handled for now, since it's the only
// version of this specific report seen so far -- if a shifted/single-
// column variant of THIS report ever shows up (the way the regular roster
// report has one), it needs a second strategy added here the same way
// parseSingleColumnTeams was added alongside parseMultiColumnRateFirst,
// not guessed at ahead of time.
//
// Returns { weekLabel, rows: [{ teamNum, teamName, num, name, nickname, eligCode }] }
function parsePlayoffEligibility(raw) {
  const weekMatch = raw.match(/For\s+Week:\s*(\d+)/i);
  const weekLabel = weekMatch ? `Playoffs Week ${weekMatch[1]}` : "Playoffs";

  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const rows = [];
  let currentTeams = []; // [{num, name}, ...] declared on the most recent "Team NNNNN Name" header row, left to right

  const CHROME_RE = [
    /^Division Playoffs/i, /^For\s+Week:/i, /^Ratings current as of/i,
    /^Players noted/i, /^T=Less than/i, /^-{5,}/,
    /^Rate\s+Num\s+Elig\s+Name$/i,
    /^(Wed|Thu|Mon|Tue|Fri|Sat|Sun)\s/i, // e.g. "Wed North Masters" league/season label line
    /Division #/i,
    /^(Summer|Winter|Spring)\s/i,
    /Sports Bar$/i, // venue line -- not needed for eligibility, safe to drop
  ];

  for (const line of lines) {
    if (CHROME_RE.some(re => re.test(line))) continue;

    const teamHeaders = [...line.matchAll(/\bTeam\s+(\d{5})\s+(.*?)(?=\s+Team\s+\d{5}\b|$)/gi)];
    if (teamHeaders.length > 0) {
      currentTeams = teamHeaders.map(m => ({ num: m[1], name: m[2].trim() }));
      continue;
    }

    if (currentTeams.length === 0) continue;

    // One "<rate> <num> <E|T|A|S> <name...>" entry per active team, left to
    // right on this line -- same anchor-based splitting idea as the regular
    // report's multi-column parser, just with a single eligibility LETTER
    // where that one has two Play/Win numbers.
    const anchorRe = /(?:^|\s)(\d{1,3})\s+(\d{5})\s+([ETAS])\s+/g;
    const anchors = [];
    let m;
    while ((m = anchorRe.exec(line)) !== null) {
      anchors.push({ pos: m.index, num: m[2], elig: m[3], nameStart: m.index + m[0].length });
    }
    if (anchors.length === 0) continue;

    anchors.forEach((a, i) => {
      const nameEnd = i + 1 < anchors.length ? anchors[i + 1].pos : line.length;
      const parsed = cleanName(line.slice(a.nameStart, nameEnd));
      if (!parsed) return;
      const team = currentTeams[i] ?? currentTeams[currentTeams.length - 1];
      rows.push({ teamNum: team.num, teamName: team.name, num: a.num, name: parsed.name, nickname: parsed.nickname, eligCode: a.elig });
    });
  }

  return { weekLabel, rows };
}




function parseDate(str) {
  const [m, d, y] = str.split("/").map(Number);
  return new Date(y, m - 1, d);
}
function findCurrentWeek(schedule) {
  const today = new Date(); today.setHours(0,0,0,0);
  const real = schedule.filter(w => w.week && w.pairings.length > 0);
  return real.find(w => parseDate(w.date) >= today) ?? real[real.length - 1] ?? null;
}

// ─── Rating week helpers ────────────────────────────────────────────────────
function isoDateKey(mmddyyyy) {
  const [m, d, y] = mmddyyyy.split("/").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function todayIsoKey() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
function currentWeekTag(schedule) {
  const wk = findCurrentWeek(schedule ?? []);
  if (wk && wk.week) return { weekKey: isoDateKey(wk.date), label: `Week ${wk.week} · ${wk.date}` };
  return { weekKey: todayIsoKey(), label: `As of ${new Date().toLocaleDateString()}` };
}
function scheduleWeekOptions(schedule) {
  return (schedule ?? [])
    .filter(w => w.week && w.pairings.length > 0)
    .map(w => ({ weekKey: isoDateKey(w.date), label: `Week ${w.week} · ${w.date}` }))
    .sort((a, b) => a.weekKey < b.weekKey ? -1 : 1);
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function AdminApp({ page }) {
  const { profile, logout, refreshProfile } = useAuth();
  return (
    <div className="app">
      <style>{css}</style>
      <style>{shellCss}</style>
      {!profile ? <Loader/> : <WorkspaceApp page={page} profile={profile} onLogout={logout} onProfileRefresh={refreshProfile} />}
      {profile && <TabBar />}
    </div>
  );
}

// ─── Workspace App (page router driven by main.jsx routes) ────────────────────
function WorkspaceApp({ page, profile, onLogout, onProfileRefresh }) {
  const isManager = profile.role === "manager";
  const isCaptain = profile.role === "captain";
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [seasons, setSeasons] = useState([]);
  const [seasonsLoading, setSeasonsLoading] = useState(true);

  const [viewingSeason, setViewingSeason] = useState(null);
  const [viewingDiv, setViewingDiv]       = useState(null);

  const [viewTeams, setViewTeams]       = useState([]);
  const [viewSchedule, setViewSchedule] = useState([]);
  const [viewRosters, setViewRosters]   = useState({}); // { teamId: [{num,name,nickname,rating}] }
  const [playoffEligibility, setPlayoffEligibility] = useState({}); // { player_num: {code, weekKey, label} }
  const [divisionLoading, setDivisionLoading] = useState(false);
  const [captainsByTeam, setCaptainsByTeam] = useState({}); // { teamId: {username, phone} }
  const [locations, setLocations] = useState([]);
  const refreshLocations = () => db.listLocations().then(setLocations);
  const [divisionTeamCounts, setDivisionTeamCounts] = useState({}); // { divisionId: teamCount } -- powers the Seasons page's "still needs teams" check

  const [manageSubTab, setManageSubTab]   = useState("teams");
  const [weeklySubTab, setWeeklySubTab]   = useState("ratings");
  const [infoSubTab, setInfoSubTab]       = useState("teams");
  const [accessSubTab, setAccessSubTab]   = useState("users");
  const [accessCounts, setAccessCounts]   = useState({ users: 0, codes: 0 });
  const [seasonsSubTab, setSeasonsSubTab] = useState("create");
  const [myTeamSubTab, setMyTeamSubTab]   = useState("roster");

  const activeSeasons = seasons.filter(s => s.is_active);
  // A season is still waiting on teams if it has at least one division and
  // zero teams across all of them -- drives each active season card's
  // "Next: Import Teams" button. More than one active season can need this
  // at once, so this is the full set, not just the first match.
  const seasonIdsNeedingTeams = new Set(
    activeSeasons.filter(s => {
      const divs = s.divisions ?? [];
      if (divs.length === 0) return false;
      return divs.reduce((sum, d) => sum + (divisionTeamCounts[d.id] ?? 0), 0) === 0;
    }).map(s => s.id)
  );

  const refreshSeasons = async () => {
    const list = await db.listSeasons();
    setSeasons(list);
    return list;
  };

  useEffect(() => {
    const allDivisionIds = seasons.flatMap(s => (s.divisions ?? []).map(d => d.id));
    if (allDivisionIds.length === 0) { setDivisionTeamCounts({}); return; }
    db.countTeamsByDivisions(allDivisionIds).then(setDivisionTeamCounts);
  }, [seasons]);

  useEffect(() => {
    refreshSeasons().then(list => {
      const requestedId = searchParams.get("season");
      const requested = requestedId ? list.find(s => s.id === requestedId) : null;
      const target = requested ?? list.find(s => s.is_active);
      if (target) {
        setViewingSeason(target);
        setViewingDiv(target.divisions?.[0] ?? null);
      }
      setSeasonsLoading(false);
    });
    db.listTeamCaptains().then(setCaptainsByTeam);
    refreshLocations();
  }, []);

  const loadDivisionData = async (div) => {
    if (!div) { setViewTeams([]); setViewSchedule([]); setViewRosters({}); setPlayoffEligibility({}); return; }
    setDivisionLoading(true);
    const teams = await db.listTeams(div.id);
    const [schedule, rostersByTeam, eligRows] = await Promise.all([
      db.listSchedule(div.id, teams),
      db.listRostersForTeams(teams.map(t => t.id)),
      db.listPlayoffEligibility(div.id),
    ]);
    setViewTeams(teams);
    setViewSchedule(schedule);
    setViewRosters(rostersByTeam);
    setPlayoffEligibility(db.eligibilityByPlayerNum(eligRows));
    setDivisionLoading(false);
  };

  useEffect(() => {
    loadDivisionData(viewingDiv);
  }, [viewingSeason?.id, viewingDiv?.id]);

  const isViewingActive = !!viewingSeason?.is_active;

  const handleSeasonView = (s, div) => {
    setViewingSeason(s);
    setViewingDiv(div ?? s.divisions?.[0] ?? null);
  };

  const refreshCurrentDivision = () => loadDivisionData(viewingDiv);

  // ── Season / division management ──
  const handleCreateSeason = async (season) => {
    const created = await db.createSeason(season);
    if (created) await refreshSeasons();
    return created;
  };
  const handleDeleteSeason = async (seasonId) => { await db.deleteSeason(seasonId); await refreshSeasons(); };
  const handleToggleActive = async (season) => {
    await db.setSeasonActive(season.id, !season.is_active);
    const list = await refreshSeasons();
    if (!season.is_active) {
      const fresh = list.find(s => s.id === season.id);
      if (fresh) handleSeasonView(fresh, fresh.divisions?.[0] ?? null);
    }
  };
  const handleAddDivision = async (season, num, name) => {
    await db.addDivision(season.id, num, name);
    await refreshSeasons();
  };
  const handleUpdateDivision = async (divisionId, num, name) => {
    const ok = await db.updateDivision(divisionId, num, name);
    await refreshSeasons();
    return ok;
  };
  const handleSetPlayoffsDate = async (seasonId, date) => {
    await db.setPlayoffsStartDate(seasonId, date);
    await refreshSeasons();
  };
  const handleRemoveDivision = async (divisionId) => {
    await db.removeDivision(divisionId);
    const list = await refreshSeasons();
    if (viewingDiv?.id === divisionId) {
      const fresh = list.find(s => s.id === viewingSeason?.id);
      handleSeasonView(fresh ?? viewingSeason, fresh?.divisions?.[0] ?? null);
    }
  };

  // ── Teams ──
  const handleSaveTeams = async (teams) => {
    if (!viewingDiv) return false;
    const ok = await db.saveTeams(viewingDiv.id, teams);
    await refreshCurrentDivision();
    return ok;
  };
  const handleDeleteTeam = async (teamId) => {
    await db.deleteTeam(teamId);
    await refreshCurrentDivision();
  };

  // ── Captains (assigned from the Teams tab's edit row) ──
  const refreshCaptains = () => db.listTeamCaptains().then(setCaptainsByTeam);
  const handleAssignCaptain = async (teamId, newProfileId, previousCaptainId) => {
    // Hand off first, so a team never briefly ends up with two captains at
    // once if the promote step below fails partway through.
    if (previousCaptainId && previousCaptainId !== newProfileId) {
      await db.setProfileRole(previousCaptainId, "player", null);
    }
    const ok = await db.setProfileRole(newProfileId, "captain", teamId);
    if (ok) await refreshCaptains();
    return ok;
  };
  const handleRemoveCaptain = async (profileId, teamId) => {
    const ok = await db.setProfileRole(profileId, "player", teamId);
    if (ok) await refreshCaptains();
    return ok;
  };
  const handleGenerateCaptainInvite = async (teamId, labelName) => {
    const code = {
      code: generateCode(), role: "captain", team_id: teamId, label_name: labelName || null,
      expires_at: new Date(Date.now() + 7*24*60*60*1000).toISOString(),
    };
    const ok = await db.createInviteCode(code);
    return ok ? code : null;
  };

  // ── Schedule ──
  const handleSaveSchedule = async (parsedWeeks) => {
    if (!viewingDiv) return;
    await db.replaceSchedule(viewingDiv.id, parsedWeeks, viewTeams);
    await refreshCurrentDivision();
    // A real IBA schedule marks its playoff week(s) right in the pasted
    // text (e.g. "18  6/12/2025  Playoffs") -- pull the date straight from
    // there instead of asking the manager to enter it separately. Only
    // overwrites when this particular import actually contains a playoff
    // week, so re-importing a schedule that doesn't mention playoffs (a
    // partial/mid-season re-paste, say) won't blank out a date that was
    // already set from an earlier import.
    if (viewingSeason) {
      const detected = detectPlayoffsStartDate(parsedWeeks);
      if (detected) await handleSetPlayoffsDate(viewingSeason.id, detected);
    }
  };
  const handleAddPairing = async (weekId, homeTeamId, awayTeamId) => {
    await db.addSchedulePairing(weekId, homeTeamId, awayTeamId);
    await refreshCurrentDivision();
  };
  const handleUpdatePairing = async (pairingId, homeTeamId, awayTeamId) => {
    await db.updateSchedulePairing(pairingId, homeTeamId, awayTeamId);
    await refreshCurrentDivision();
  };
  const handleDeletePairing = async (pairingId) => {
    await db.deleteSchedulePairing(pairingId);
    await refreshCurrentDivision();
  };

  // ── Players / rosters / ratings ──
  const handleBulkImport = async (parsed) => {
    const weekTag = currentWeekTag(viewSchedule);
    const result = await db.bulkImportPlayers(parsed, weekTag);
    await refreshCurrentDivision();
    return result;
  };
  const handleManualRating = async (num, weekKey, weekLabel, rating) => {
    await db.setPlayerRating(num, weekKey, weekLabel, rating, "manual");
    await refreshCurrentDivision();
  };
  const handleMovePlayer = async (num, fromTeamId, toTeamId) => {
    await db.moveRosterPlayer(num, fromTeamId, toTeamId);
    await refreshCurrentDivision();
  };

  // Players with no rating yet (needsRating) are deliberately excluded here --
  // they shouldn't be draftable into a live match, since scoring races to a
  // player's rating. They still show up in the Players tab to be fixed by hand.
  const resolveRoster = (teamId) => (viewRosters[teamId] ?? []).filter(p => p.rating != null);

  if (seasonsLoading) return <><PageHeader title="IBA Admin"/><div className="tab-content"><Loader/></div></>;

  // ── "me" — everyone, always allowed ──
  if (page === "me") {
    return (
      <>
        <PageHeader title="My Profile" />
        <div className="tab-content"><AccountSettings profile={profile} onProfileRefresh={onProfileRefresh} /></div>
      </>
    );
  }

  // ── Create or Update Seasons — manager only ──
  if (page === "seasons") {
    if (!isManager) return <><PageHeader title="Create or Update Seasons"/><div className="tab-content"><AccessDenied/></div></>;
    return (
      <>
        <PageHeader title="Create or Update Seasons" />
        <SubTabBar>
          <SubTabBtn active={seasonsSubTab==="create"} onClick={()=>setSeasonsSubTab("create")}>Create a Season</SubTabBtn>
          <SubTabBtn active={seasonsSubTab==="active"} onClick={()=>setSeasonsSubTab("active")}>Active Seasons</SubTabBtn>
          <SubTabBtn active={seasonsSubTab==="inactive"} onClick={()=>setSeasonsSubTab("inactive")}>Inactive Seasons</SubTabBtn>
        </SubTabBar>
        <div className="tab-content">
          <SeasonsTab seasons={seasons} subTab={seasonsSubTab}
            onCreateSeason={handleCreateSeason} onDeleteSeason={handleDeleteSeason} onToggleActive={handleToggleActive}
            onAddDivision={handleAddDivision} onRemoveDivision={handleRemoveDivision} onUpdateDivision={handleUpdateDivision}
            seasonIdsNeedingTeams={seasonIdsNeedingTeams} onImportTeams={(seasonId)=>navigate(`/manage?season=${seasonId}`)}
            onSeasonCreated={()=>setSeasonsSubTab("inactive")}
            onImportIbaSchedule={refreshSeasons} />
        </div>
      </>
    );
  }

  // ── Manage Season Data — manager only, full edit ──
  if (page === "manage") {
    if (!isManager) return <><PageHeader title="Manage Season Data"/><div className="tab-content"><AccessDenied/></div></>;
    return (
      <>
        <PageHeader title="Manage Season Data" />
        <SubTabBar>
          <SubTabBtn active={manageSubTab==="teams"} onClick={()=>setManageSubTab("teams")}>Teams</SubTabBtn>
          <SubTabBtn active={manageSubTab==="schedule"} onClick={()=>setManageSubTab("schedule")}>Schedule</SubTabBtn>
          <SubTabBtn active={manageSubTab==="players"} onClick={()=>setManageSubTab("players")}>Players & Ratings</SubTabBtn>
          <SubTabBtn active={manageSubTab==="playoffs"} onClick={()=>setManageSubTab("playoffs")}>Playoffs</SubTabBtn>
          <SubTabBtn active={manageSubTab==="locations"} onClick={()=>setManageSubTab("locations")}>Locations</SubTabBtn>
        </SubTabBar>
        <div className="tab-content">
          {manageSubTab!=="players" && manageSubTab!=="locations" && manageSubTab!=="playoffs" && (
            <SeasonDivBanner seasons={seasons} activeSeasons={activeSeasons}
              viewingSeason={viewingSeason} viewingDiv={viewingDiv} onView={handleSeasonView} readOnly={!isViewingActive} />
          )}
          {manageSubTab==="teams" && (
            <TeamsTab key={viewingDiv?.id ?? "none"} teams={viewTeams}
              onSave={isViewingActive && viewingDiv ? handleSaveTeams : null}
              onDeleteTeam={isViewingActive && viewingDiv ? handleDeleteTeam : null}
              readOnly={!isViewingActive} onNext={()=>setManageSubTab("schedule")} captainsByTeam={captainsByTeam} locations={locations}
              onAssignCaptain={isViewingActive ? handleAssignCaptain : null}
              onRemoveCaptain={isViewingActive ? handleRemoveCaptain : null}
              onGenerateCaptainInvite={isViewingActive ? handleGenerateCaptainInvite : null} />
          )}
          {manageSubTab==="schedule" && (
            <ScheduleTab key={viewingDiv?.id ?? "none"} schedule={viewSchedule} teams={viewTeams}
              onSave={isViewingActive && viewingDiv ? handleSaveSchedule : null}
              onAddPairing={isViewingActive && viewingDiv ? handleAddPairing : null}
              onUpdatePairing={isViewingActive && viewingDiv ? handleUpdatePairing : null}
              onDeletePairing={isViewingActive && viewingDiv ? handleDeletePairing : null}
              readOnly={!isViewingActive} onNext={()=>setManageSubTab("players")} />
          )}
          {manageSubTab==="players" && (
            <PlayersTab teams={viewTeams} rosters={viewRosters} schedule={viewSchedule} eligByNum={playoffEligibility}
              divisionId={viewingDiv?.id ?? null} onReconciled={refreshCurrentDivision}
              onBulkImport={isViewingActive && viewingDiv ? handleBulkImport : null}
              onManualRating={isViewingActive && viewingDiv ? handleManualRating : null}
              onMovePlayer={isViewingActive && viewingDiv ? handleMovePlayer : null}
              lockedTeamId={null} readOnly={!isViewingActive} />
          )}
          {manageSubTab==="playoffs" && viewingDiv && (
            <PlayoffsTab divisionId={viewingDiv.id} teams={viewTeams} />
          )}
          {manageSubTab==="playoffs" && !viewingDiv && (
            <div className="empty-state">Pick a division from the Season tab first.</div>
          )}
          {manageSubTab==="locations" && (
            <LocationsTab locations={locations} onRefresh={refreshLocations} />
          )}
        </div>
      </>
    );
  }

  // ── Update Weekly League Data — manager only ──
  if (page === "weekly") {
    if (!isManager) return <><PageHeader title="Update Weekly League Data"/><div className="tab-content"><AccessDenied/></div></>;
    return (
      <>
        <PageHeader title="Update Weekly League Data" />
        <SubTabBar>
          <SubTabBtn active={weeklySubTab==="ratings"} onClick={()=>setWeeklySubTab("ratings")}>Import Ratings</SubTabBtn>
          <SubTabBtn active={weeklySubTab==="standings"} onClick={()=>setWeeklySubTab("standings")}>Import Team Standings</SubTabBtn>
          <SubTabBtn active={weeklySubTab==="mvp"} onClick={()=>setWeeklySubTab("mvp")}>Import MVP Standings</SubTabBtn>
          <SubTabBtn active={weeklySubTab==="eligibility"} onClick={()=>setWeeklySubTab("eligibility")}>Playoff Eligibility</SubTabBtn>
        </SubTabBar>
        <div className="tab-content">
          <SeasonDivBanner seasons={seasons} activeSeasons={activeSeasons}
            viewingSeason={viewingSeason} viewingDiv={viewingDiv} onView={handleSeasonView} readOnly={!isViewingActive} />
          {isViewingActive && isManager && viewingSeason && (
            <IbaAutoSyncPanel season={viewingSeason} schedule={viewSchedule} onComplete={refreshCurrentDivision} />
          )}
          {!viewingDiv
            ? <div className="empty-state">Pick a division above to import weekly data.</div>
            : weeklySubTab==="ratings"
            ? <PlayersTab teams={viewTeams} rosters={viewRosters} schedule={viewSchedule} eligByNum={playoffEligibility}
                divisionId={viewingDiv?.id ?? null} onReconciled={refreshCurrentDivision}
                onBulkImport={isViewingActive ? handleBulkImport : null}
                onManualRating={isViewingActive ? handleManualRating : null}
                onMovePlayer={isViewingActive ? handleMovePlayer : null}
                lockedTeamId={null} readOnly={!isViewingActive} />
            : weeklySubTab==="eligibility"
            ? <SeedPlayoffEligibilityImport divisionId={viewingDiv.id} existingCount={Object.keys(playoffEligibility).length} onImported={refreshCurrentDivision} />
            : <WeeklyImportPanel divisionId={viewingDiv.id} teams={viewTeams} mode={weeklySubTab} />
          }
        </div>
      </>
    );
  }

  // ── Current League Matches — manager, captain, player ──
  if (page === "matches") {
    return (
      <>
        <PageHeader title="Current League Matches" />
        <div className="tab-content">
          <SeasonDivBanner seasons={seasons} activeSeasons={activeSeasons}
            viewingSeason={viewingSeason} viewingDiv={viewingDiv} onView={handleSeasonView} />
          {activeSeasons.length === 0
            ? <div className="empty-state">No active season yet.</div>
            : divisionLoading ? <Loader/> :
              <TonightTab teams={viewTeams} schedule={viewSchedule} resolveRoster={resolveRoster}
                activeSeason={viewingSeason} viewingDiv={viewingDiv} isViewingActive={isViewingActive}
                myProfile={profile} isManager={isManager} />
          }
        </div>
      </>
    );
  }

  // ── Team & Player Information — view-only, manager/captain/player ──
  if (page === "teaminfo") {
    return (
      <>
        <PageHeader title="Team & Player Information" />
        <SubTabBar>
          <SubTabBtn active={infoSubTab==="teams"} onClick={()=>setInfoSubTab("teams")}>Teams</SubTabBtn>
          <SubTabBtn active={infoSubTab==="schedule"} onClick={()=>setInfoSubTab("schedule")}>Schedule</SubTabBtn>
          <SubTabBtn active={infoSubTab==="players"} onClick={()=>setInfoSubTab("players")}>Players & Ratings</SubTabBtn>
        </SubTabBar>
        <div className="tab-content">
          {infoSubTab!=="players" && (
            <SeasonDivBanner seasons={seasons} activeSeasons={activeSeasons}
              viewingSeason={viewingSeason} viewingDiv={viewingDiv} onView={handleSeasonView} readOnly />
          )}
          {infoSubTab==="teams" && <TeamsTab teams={viewTeams} onSave={null} onDeleteTeam={null} readOnly onNext={null} hideReadOnlyBanner captainsByTeam={captainsByTeam} />}
          {infoSubTab==="schedule" && (
            <ScheduleTab schedule={viewSchedule} teams={viewTeams}
              onSave={null} onAddPairing={null} onUpdatePairing={null} onDeletePairing={null}
              readOnly onNext={null} hideReadOnlyBanner />
          )}
          {infoSubTab==="players" && (
            <PlayersTab teams={viewTeams} rosters={viewRosters} schedule={viewSchedule} eligByNum={playoffEligibility}
              onBulkImport={null} onManualRating={null} onMovePlayer={null}
              lockedTeamId={null} readOnly hideReadOnlyBanner />
          )}
        </div>
      </>
    );
  }

  // ── Manage My Team — captain only ──
  if (page === "myteam") {
    if (!isCaptain) return <><PageHeader title="Manage My Team"/><div className="tab-content"><AccessDenied/></div></>;
    return (
      <>
        <PageHeader title="Manage My Team" />
        <SubTabBar>
          <SubTabBtn active={myTeamSubTab==="roster"} onClick={()=>setMyTeamSubTab("roster")}>Roster</SubTabBtn>
          <SubTabBtn active={myTeamSubTab==="lineup"} onClick={()=>setMyTeamSubTab("lineup")}>Lineup Planner</SubTabBtn>
          <SubTabBtn active={myTeamSubTab==="stats"} onClick={()=>setMyTeamSubTab("stats")}>Team Stats</SubTabBtn>
        </SubTabBar>
        <div className="tab-content">
          {myTeamSubTab === "roster" && <ManageMyTeamPage teamId={profile.team_id} profileId={profile.id} />}
          {myTeamSubTab === "lineup" && <LineupPlannerPanel teamId={profile.team_id} profileId={profile.id} />}
          {myTeamSubTab === "stats" && <TeamStatsPanel teamId={profile.team_id} />}
        </div>
      </>
    );
  }

  // ── Advanced Stats Leaderboard — leaguewide, every role ──
  if (page === "leaderboard") {
    return <LeaderboardPage />;
  }

  // ── Manage App Access — manager only ──
  if (page === "access") {
    if (!isManager) return <><PageHeader title="Manage App Access"/><div className="tab-content"><AccessDenied/></div></>;
    return (
      <>
        <PageHeader title="Manage App Access" />
        <SubTabBar>
          <SubTabBtn active={accessSubTab==="users"} onClick={()=>setAccessSubTab("users")}>Users ({accessCounts.users})</SubTabBtn>
          <SubTabBtn active={accessSubTab==="codes"} onClick={()=>setAccessSubTab("codes")}>Codes ({accessCounts.codes})</SubTabBtn>
        </SubTabBar>
        <div className="tab-content">
          <AccountsTab currentUserId={profile.id} subTab={accessSubTab} onCounts={setAccessCounts} />
        </div>
      </>
    );
  }

  // ── Coming-soon placeholders ──
  if (page === "players") return <PlayerLookupPage />;
  if (page === "teamlookup") return <TeamLookupPage />;
  if (page === "matchlkp") {
    return (
      <>
        <PageHeader title="Match Lookup / History" />
        <div className="tab-content">
          <SeasonDivBanner seasons={seasons} activeSeasons={activeSeasons}
            viewingSeason={viewingSeason} viewingDiv={viewingDiv} onView={handleSeasonView} />
          {!viewingDiv
            ? <div className="empty-state">Pick a division above to see standings & match history.</div>
            : <HistoryTab divisionId={viewingDiv.id} teams={viewTeams} isManager={isManager} playoffsStartDate={viewingSeason?.playoffs_start_date} myProfile={profile}
                seasonFormat={(viewingSeason?.format || "masters").toLowerCase()} seasonLabelText={viewingSeason ? seasonLabel(viewingSeason) : null} />
          }
        </div>
      </>
    );
  }
  if (page === "stats") return <MyStatsPage profile={profile} />;

  return <><PageHeader title="IBA Pool App"/><div className="tab-content"><AccessDenied/></div></>;
}

function ComingSoonPage({ title }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="tab-content">
        <div className="empty-state">Coming soon.</div>
      </div>
    </>
  );
}

// A simple personal win-loss record and basic stats, derived from real
// matches/sets the same way the real MVP standings are computed -- not a
// separate formula. Scoped to the player's current team's division; the
// advanced, all-time-across-every-type-of-play stats page is a later build.
const GAME_TYPE_FILTERS = [{ key: null, label: "All Games" }, { key: "8ball", label: "8-Ball" }, { key: "9ball", label: "9-Ball" }, { key: "10ball", label: "10-Ball" }, { key: "ultimate", label: "Ultimate" }];
const PLAY_TYPE_FILTERS = [{ key: "all", label: "All Play" }, { key: "league", label: "League" }, { key: "practice", label: "Practice" }];

function matchesPlayType(event, playType) {
  if (playType === "all") return true;
  if (playType === "league") return event.context_type === "live_match" || event.context_type === "manual_match";
  return event.context_type === "practice_game";
}

// Shared rendering for one computed shotStats object -- the stat-box grid
// plus distance/cut/technique breakdown. Used by My Stats, the leaderboard
// entry detail, and the Team Stats rollup, so the layout stays consistent
// everywhere this data shows up.
function ShotStatsBlock({ stats }) {
  return (
    <>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:6}}>
        {[
          { label: "Shots", value: stats.totalShots },
          { label: "Makes", value: stats.makes },
          { label: "Make %", value: `${stats.makePct}%` },
          { label: "Scratches", value: stats.scratches },
          { label: "Fouls", value: stats.fouls },
          { label: "Miscues", value: stats.miscues },
          { label: "Runouts", value: stats.runouts },
          { label: "Breaks", value: stats.breaks.attempts },
          { label: "Safety %", value: stats.safeties.attempts ? `${stats.safeties.pct}%` : "—" },
        ].map(b => (
          <div key={b.label} style={{textAlign:"center",background:"#141414",border:"1px solid #2A2A2A",borderRadius:10,padding:"12px 6px"}}>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:18,fontWeight:700,color:"#5FCF9E"}}>{b.value}</div>
            <div style={{fontSize:9.5,color:"#8A8A8A",marginTop:3,textTransform:"uppercase",letterSpacing:"0.03em"}}>{b.label}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:10}}>
        {[
          { label: "By Distance", data: stats.byDistance, keys: [["short","Short"],["medium","Medium"],["long","Long"]] },
          { label: "By Cut", data: stats.byCut, keys: [["left","Left"],["right","Right"]] },
          { label: "By Technique", data: stats.byTechnique, keys: [["jump","Jump"],["kick","Kick"],["bank","Bank"]] },
        ].map(group => (
          <div key={group.label}>
            <div style={{fontSize:10,fontWeight:700,color:"#6A6A6A",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>{group.label}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {group.keys.map(([key, label]) => {
                const d = group.data[key];
                return d.attempts > 0 ? (
                  <span key={key} className="player-rating-badge" style={{fontSize:11}}>{label}: {d.makes}/{d.attempts} ({d.pct}%)</span>
                ) : null;
              })}
              {group.keys.every(([key]) => group.data[key].attempts === 0) && <span style={{fontSize:11,color:"#5A5A5A"}}>No data yet</span>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function FilterChips({ options, value, onChange }) {
  return (
    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
      {options.map(o => (
        <button key={String(o.key)} className={`chip ${value === o.key ? "chip--active" : ""}`} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

function seasonLabelFor(row) {
  return `${row.seasonType} · ${row.seasonFormat} · ${row.seasonDay}`;
}

// ─── Player Stats Profile (shared) ─────────────────────────────────────────
// One player's full picture: bio header, season/career scope picker, win-
// loss/MVP record for that scope, team history (every roster they've ever
// been on), rating history, and Track a Rack advanced stats + head-to-head
// -- all respecting the same scope selection. Used by both My Stats
// (yourself) and Player Lookup (anyone, including side-by-side comparison)
// so the two never drift into showing different things for the same data.
//
// Scope is "By Season" (a specific year + season the player actually has
// team history in) or "Career (All-Time)". Practice games have no season
// concept at all, so they're included under Career but excluded whenever a
// specific season is selected -- called out inline rather than silently
// dropped.
function PlayerStatsProfile({ playerNum, currentTeamId = null }) {
  const navigate = useNavigate();
  const [nameInfo, setNameInfo] = useState(null);
  const [currentRating, setCurrentRating] = useState(null);
  const [teamHistory, setTeamHistory] = useState(undefined); // undefined = loading
  const [ratingHistory, setRatingHistory] = useState([]);
  const [rawEvents, setRawEvents] = useState(undefined); // undefined = loading, null = none tracked

  const [scopeMode, setScopeMode] = useState("season"); // "career" | "season"
  const [selectedYear, setSelectedYear] = useState(null);
  const [selectedSeasonId, setSelectedSeasonId] = useState(null);

  const [seasonRecord, setSeasonRecord] = useState(undefined);
  const [mvpRankRow, setMvpRankRow] = useState(undefined); // undefined = loading/n-a, null = no data for this scope
  const [playoffElig, setPlayoffElig] = useState(undefined); // undefined = loading/n-a, null = nothing imported for this scope
  const [gameTypeFilter, setGameTypeFilter] = useState(null);
  const [playTypeFilter, setPlayTypeFilter] = useState("all");
  const [headToHead, setHeadToHead] = useState([]);

  useEffect(() => {
    if (!playerNum) return;
    db.getPlayerNameMap([playerNum]).then(m => setNameInfo(m[playerNum] ?? { name: playerNum, nickname: "" }));
    db.getPlayerRating(playerNum).then(setCurrentRating);
    db.listRosterHistory(playerNum).then(setRatingHistory);
    db.listMyShotEvents(playerNum).then(events => setRawEvents(events.length ? events : null));
    db.listPlayerTeamHistory(playerNum).then(history => {
      setTeamHistory(history);
      const current = history.find(t => t.teamId === currentTeamId) ?? history[0];
      if (current) { setScopeMode("season"); setSelectedYear(current.seasonYear); setSelectedSeasonId(current.seasonId); }
      else setScopeMode("career");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerNum]);

  const years = [...new Set((teamHistory ?? []).map(t => t.seasonYear).filter(Boolean))].sort((a, b) => b - a);
  const seasonOptionsForYear = (year) => {
    const rows = (teamHistory ?? []).filter(t => t.seasonYear === year);
    const bySeasonId = new Map();
    for (const r of rows) {
      if (!bySeasonId.has(r.seasonId)) bySeasonId.set(r.seasonId, { seasonId: r.seasonId, label: seasonLabelFor(r), divisionIds: [] });
      bySeasonId.get(r.seasonId).divisionIds.push(r.divisionId);
    }
    return [...bySeasonId.values()];
  };

  const activeDivisionIds = scopeMode === "career"
    ? [...new Set((teamHistory ?? []).map(t => t.divisionId).filter(Boolean))]
    : (seasonOptionsForYear(selectedYear).find(s => s.seasonId === selectedSeasonId)?.divisionIds ?? []);

  useEffect(() => {
    if (teamHistory === undefined) return;
    setSeasonRecord(undefined);
    db.getStatsForDivisions(playerNum, activeDivisionIds).then(setSeasonRecord);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerNum, scopeMode, selectedSeasonId, teamHistory]);

  // MVP rank and playoff eligibility are both scoped to a single division's
  // real standings/report -- meaningless across a career spanning multiple
  // divisions, so both stay null outside "by season" with exactly one
  // division in scope (the normal case; a mid-season team change would be
  // the rare exception, and this just omits the card rather than guessing).
  const singleScopedDivisionId = scopeMode === "season" && activeDivisionIds.length === 1 ? activeDivisionIds[0] : null;

  useEffect(() => {
    if (teamHistory === undefined) return;
    if (!singleScopedDivisionId) { setMvpRankRow(null); return; }
    setMvpRankRow(undefined);
    db.getPlayerMvpRankRow(playerNum, singleScopedDivisionId).then(row => setMvpRankRow(row ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerNum, singleScopedDivisionId, teamHistory]);

  useEffect(() => {
    if (teamHistory === undefined) return;
    if (!singleScopedDivisionId) { setPlayoffElig(null); return; }
    setPlayoffElig(undefined);
    db.getPlayerPlayoffEligibility(playerNum, singleScopedDivisionId).then(row => setPlayoffElig(row ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerNum, singleScopedDivisionId, teamHistory]);

  const scopedSeasonRow = singleScopedDivisionId ? (teamHistory ?? []).find(t => t.divisionId === singleScopedDivisionId) : null;
  const scopedSeasonLabel = scopedSeasonRow ? `Div ${scopedSeasonRow.divisionNum} · ${seasonLabelFor(scopedSeasonRow)} ${scopedSeasonRow.seasonYear}` : "";

  const scopedEvents = rawEvents
    ? (scopeMode === "career" ? rawEvents : rawEvents.filter(e => activeDivisionIds.includes(e.division_id)))
    : [];
  const filteredEvents = scopedEvents.filter(e => (!gameTypeFilter || e.game_type === gameTypeFilter) && matchesPlayType(e, playTypeFilter));
  const shotStats = rawEvents ? db.computeShotStats(filteredEvents) : null;

  useEffect(() => {
    if (!rawEvents) { setHeadToHead([]); return; }
    db.computeHeadToHead(filteredEvents).then(setHeadToHead);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawEvents, gameTypeFilter, playTypeFilter, scopeMode, selectedSeasonId]);

  const winPct = seasonRecord && seasonRecord.sets > 0 ? Math.round((seasonRecord.wins / seasonRecord.sets) * 100) : null;
  const statBoxes = seasonRecord ? [
    { label: "Sets Played", value: seasonRecord.sets },
    { label: "Wins", value: seasonRecord.wins },
    { label: "Losses", value: seasonRecord.losses },
    { label: "Win %", value: winPct != null ? `${winPct}%` : "—" },
    { label: "Points Scored", value: seasonRecord.pointsScored },
    { label: "MVP Ranking Pts", value: seasonRecord.mvpRanking },
  ] : [];

  const exportAll = () => {
    const nameMap = { [playerNum]: nameInfo ?? { name: playerNum }, ...Object.fromEntries(headToHead.filter(h => h.opponentNum).map(h => [h.opponentNum, { name: h.name }])) };
    db.downloadCSV(`${nameInfo?.name ?? playerNum}-advanced-stats.csv`, db.shotEventsToCSV(filteredEvents, nameMap));
  };

  if (teamHistory === undefined) return <Loader />;

  return (
    <>
      <div className="card">
        <div style={{fontSize:16,fontWeight:700,color:"#E0E0E0"}}>
          {nameInfo?.name ?? playerNum}{nameInfo?.nickname ? <span style={{color:"#6A6A6A",fontWeight:500}}> "{nameInfo.nickname}"</span> : ""}
        </div>
        {currentRating != null && <div style={{fontSize:11,color:"#9A9A9A",marginTop:2}}>Current Rating: {currentRating}</div>}
      </div>

      <div className="card">
        <div className="card__title">Scope</div>
        <div className="seg-control" style={{marginBottom:8}}>
          <button className={`seg-btn ${scopeMode==="season"?"seg-btn--active":""}`} onClick={()=>setScopeMode("season")}>By Season</button>
          <button className={`seg-btn ${scopeMode==="career"?"seg-btn--active":""}`} onClick={()=>setScopeMode("career")}>Career (All-Time)</button>
        </div>
        {scopeMode === "season" && (
          years.length === 0 ? <div className="dash-empty">No season history on file.</div> : (
            <div style={{display:"flex",gap:8}}>
              <select className="input input--select" style={{flex:1}} value={selectedYear ?? ""} onChange={e => {
                const y = Number(e.target.value); setSelectedYear(y);
                setSelectedSeasonId(seasonOptionsForYear(y)[0]?.seasonId ?? null);
              }}>
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <select className="input input--select" style={{flex:1}} value={selectedSeasonId ?? ""} onChange={e => setSelectedSeasonId(e.target.value)}>
                {seasonOptionsForYear(selectedYear).map(s => <option key={s.seasonId} value={s.seasonId}>{s.label}</option>)}
              </select>
            </div>
          )
        )}
      </div>

      {seasonRecord === undefined && <Loader />}
      {seasonRecord && (
        <div className="card">
          <div className="card__title">{scopeMode === "career" ? "Career Record" : "Season Record"}</div>
          {seasonRecord.sets === 0
            ? <div className="dash-empty">No matches recorded for this scope.</div>
            : (
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:6}}>
                {statBoxes.map(b => (
                  <div key={b.label} style={{textAlign:"center",background:"#141414",border:"1px solid #2A2A2A",borderRadius:10,padding:"12px 6px"}}>
                    <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:18,fontWeight:700,color:"#5FCF9E"}}>{b.value}</div>
                    <div style={{fontSize:9.5,color:"#8A8A8A",marginTop:3,textTransform:"uppercase",letterSpacing:"0.03em"}}>{b.label}</div>
                  </div>
                ))}
              </div>
            )}
          {mvpRankRow && (
            <div style={{marginTop:10,textAlign:"center",fontSize:12,fontWeight:700,color:"#5FCF9E",background:"#141414",border:"1px solid #2A2A2A",borderRadius:10,padding:"8px 6px"}}>
              #{mvpRankRow.rank} of {mvpRankRow.totalPlayers} in MVP ranking{scopedSeasonLabel ? ` — ${scopedSeasonLabel}` : ""}
            </div>
          )}
        </div>
      )}

      {playoffElig && (
        <div className="card">
          <div className="card__title">Playoff Eligibility</div>
          <div style={{fontSize:13,fontWeight:700,color: playoffElig.elig_code==="E" ? "#5FCF9E" : "#F59E0B"}}>
            {PLAYOFF_ELIG_LABELS[playoffElig.elig_code] ?? playoffElig.elig_code}
          </div>
          {(scopedSeasonLabel || playoffElig.label) && (
            <div style={{fontSize:10.5,color:"#6A6A6A",marginTop:2}}>
              {scopedSeasonLabel}{scopedSeasonLabel && playoffElig.label ? " — " : ""}{playoffElig.label ? `as of ${playoffElig.label}` : ""}
            </div>
          )}
        </div>
      )}

      {teamHistory.length > 0 && (
        <div className="card">
          <div className="card__title">Team History</div>
          <div className="list" style={{marginTop:6}}>
            {teamHistory.map(t => (
              <button key={t.teamId} className="list-row" style={{width:"100%",background:"none",border:"none",textAlign:"left",cursor:"pointer"}}
                onClick={() => navigate(`/team-lookup?team=${t.teamId}`)}>
                <div className="list-row__body">
                  <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                    <span className="list-row__name">{t.teamName}</span>
                    <span className="list-row__sub">Div {t.divisionNum}{t.divisionName ? ` · ${t.divisionName}` : ""} — {seasonLabelFor(t)} {t.seasonYear}{t.isActive ? " · Active" : ""}</span>
                  </div>
                  <ChevronRight size={14} color="#6A6A6A" />
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {ratingHistory.length > 0 && (
        <div className="card">
          <div className="card__title">Rating History</div>
          <div className="list" style={{marginTop:6}}>
            {ratingHistory.map((h, i) => (
              <div key={i} className="list-row">
                <div className="list-row__body">
                  <span className="list-row__name" style={{flex:1}}>{h.label}</span>
                  <span className="player-rating-badge">{h.rating ?? "—"}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {rawEvents === undefined && <Loader />}
      {rawEvents && (
        <>
          <div className="card">
            <div className="card__title">Advanced Stats (Track a Rack)</div>
            <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:4}}>
              <FilterChips options={PLAY_TYPE_FILTERS} value={playTypeFilter} onChange={setPlayTypeFilter} />
              <FilterChips options={GAME_TYPE_FILTERS} value={gameTypeFilter} onChange={setGameTypeFilter} />
            </div>
            {scopeMode === "season" && <div style={{fontSize:10,color:"#6A6A6A",marginBottom:6}}>Practice games aren't tied to a season, so they're excluded while a specific season is selected — switch to Career to include them.</div>}
            {filteredEvents.length === 0
              ? <div className="dash-empty" style={{marginTop:8}}>No tracked shots match this filter.</div>
              : <>
                  <ShotStatsBlock stats={shotStats} />
                  <div style={{display:"flex",gap:8,marginTop:10}} className="no-print">
                    <button className="btn-sm" onClick={() => window.print()}>Print / Save as PDF</button>
                    <button className="btn-sm" onClick={exportAll}>Export CSV</button>
                  </div>
                </>}
          </div>

          {headToHead.length > 0 && (
            <div className="card">
              <div className="card__title">Head-to-Head</div>
              <div className="list" style={{marginTop:6}}>
                {headToHead.map(h => (
                  <div key={h.opponentNum ?? "unknown"} className="list-row">
                    <div className="list-row__body">
                      <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                        <span className="list-row__name">{h.name}{h.nickname ? ` "${h.nickname}"` : ""}</span>
                        <span className="list-row__sub">{h.stats.totalShots} shots · {h.stats.makePct}% makes · {h.stats.runouts} runouts</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {rawEvents === null && (
        <div style={{fontSize:10.5,color:"#6A6A6A",textAlign:"center"}}>
          No advanced stats tracked yet — use "Track a Rack" during a live match, manual entry, or practice to start building this out.
        </div>
      )}
    </>
  );
}

function MyStatsPage({ profile }) {
  if (!profile?.team_id) {
    return (
      <>
        <PageHeader title="My Stats" />
        <div className="tab-content">
          <div className="empty-state">You're not linked to a team yet. Once you are, your stats will show here.</div>
        </div>
      </>
    );
  }
  if (!profile?.player_num) {
    return (
      <>
        <PageHeader title="My Stats" />
        <div className="tab-content">
          <div className="card">
            <div className="card__title">Link Your Player Number</div>
            <div style={{fontSize:12.5,color:"#9A9A9A",lineHeight:1.5,marginBottom:10}}>
              Your stats are tracked by your IBA player number. Link yours from My Profile to see your record here.
            </div>
            <Link to="/me" className="btn-primary" style={{textAlign:"center",textDecoration:"none",display:"block"}}>Go to My Profile</Link>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title="My Stats" />
      <div className="tab-content">
        <PlayerStatsProfile playerNum={profile.player_num} currentTeamId={profile.team_id} />
      </div>
    </>
  );
}

// ─── Player Lookup (leaguewide, every role) ────────────────────────────────
// Search any player, see their full profile (PlayerStatsProfile, shared
// with My Stats), and optionally compare it against a second player's --
// the same component stacked twice with a "vs" divider, so a comparison
// gets everything a solo lookup gets (season/career scope, team history,
// rating history, advanced stats, head-to-head), not a stripped-down view.
function PlayerLookupPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareQuery, setCompareQuery] = useState("");
  const [compareResults, setCompareResults] = useState([]);
  const [compareSelected, setCompareSelected] = useState(null);

  // Incoming link from Team Lookup (a roster row) or anywhere else that
  // knows a player_num -- selects that player straight away instead of
  // requiring a fresh search. Also keeps the URL in sync when a player is
  // picked here, so the profile itself is a shareable/bookmarkable link.
  useEffect(() => {
    const num = searchParams.get("num");
    if (num && selected?.num !== num) setSelected({ num });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    const t = setTimeout(() => { if (query.trim().length >= 2) db.searchPlayers(query).then(setResults); else setResults([]); }, 250);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    const t = setTimeout(() => { if (compareQuery.trim().length >= 2) db.searchPlayers(compareQuery).then(setCompareResults); else setCompareResults([]); }, 250);
    return () => clearTimeout(t);
  }, [compareQuery]);

  const pickPlayer = (p) => { setSelected(p); setQuery(""); setSearchParams({ num: p.num }); };
  const reset = () => { setSelected(null); setCompareOpen(false); setCompareSelected(null); setCompareQuery(""); setSearchParams({}); };

  return (
    <>
      <PageHeader title="Player Lookup" />
      <div className="tab-content">
        {!selected ? (
          <div className="card">
            <div className="card__title">Search Players</div>
            <input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Start typing a name…" autoFocus />
            {results.length > 0 && (
              <div className="list" style={{marginTop:8}}>
                {results.map(p => (
                  <div key={p.num} className="list-row" style={{cursor:"pointer"}} onClick={() => pickPlayer(p)}>
                    <div className="list-row__body">
                      <div style={{flex:1}}>
                        <div className="list-row__name">{p.name}{p.nickname ? ` "${p.nickname}"` : ""}</div>
                        <div className="list-row__sub">{p.rating != null ? `Rating: ${p.rating}` : "No current rating"}</div>
                      </div>
                      <ChevronRight size={14} color="#6A6A6A" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <button className="btn-secondary no-print" onClick={reset}>← New Search</button>
            <PlayerStatsProfile playerNum={selected.num} />

            <div className="card no-print">
              <div className="card__title">Compare</div>
              {!compareOpen && !compareSelected && (
                <button className="btn-secondary" onClick={() => setCompareOpen(true)}>Compare to Another Player</button>
              )}
              {compareOpen && !compareSelected && (
                <>
                  <input className="input" value={compareQuery} onChange={e => setCompareQuery(e.target.value)} placeholder="Search the other player's name…" autoFocus />
                  {compareResults.length > 0 && (
                    <div className="list" style={{marginTop:8}}>
                      {compareResults.filter(p => p.num !== selected.num).map(p => (
                        <div key={p.num} className="list-row" style={{cursor:"pointer"}} onClick={() => { setCompareSelected(p); setCompareQuery(""); }}>
                          <div className="list-row__body"><div className="list-row__name">{p.name}{p.nickname ? ` "${p.nickname}"` : ""}</div></div>
                        </div>
                      ))}
                    </div>
                  )}
                  <button className="btn-sm" style={{marginTop:8}} onClick={() => setCompareOpen(false)}>Cancel</button>
                </>
              )}
            </div>

            {compareSelected && (
              <>
                <div style={{textAlign:"center",fontSize:11,fontWeight:800,color:"#6A6A6A",letterSpacing:"0.05em",textTransform:"uppercase"}}>vs</div>
                <PlayerStatsProfile playerNum={compareSelected.num} />
                <button className="btn-secondary no-print" onClick={() => { setCompareSelected(null); setCompareOpen(false); }}>Remove Comparison</button>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ─── Team Lookup (leaguewide, every role) ──────────────────────────────────
// Browse/search any team, see its advanced-stats rollup (TeamStatsPanel,
// the same component the captain's own Manage My Team uses -- unchanged,
// just given a team picker in front of it). Open to everyone, not
// manager-only: a team's advanced stats already carry no more sensitivity
// than league standings or MVP rankings, which are already leaguewide-
// visible throughout this app.
// Team record + roster + schedule, sitting above the existing TeamStatsPanel
// (advanced stats) -- everything derivable from data already in the app:
// wins/losses/points/rank via the same computeStandings() the real
// Standings tab uses, roster via listRosterForTeam, schedule/results via
// getTeamScheduleOverview (already fully generic over any teamId, not just
// the signed-in player's own team). Single-season by design, matching how
// team identity actually works in this schema -- teams.id is a fresh row
// every season, never reused, so there's no single "team" to show history
// across; this shows exactly the one season this team row belongs to.
function TeamDetailView({ team }) {
  const [overview, setOverview] = useState(undefined); // undefined = loading, null = no schedule
  const [standingsRow, setStandingsRow] = useState(undefined);
  const [roster, setRoster] = useState([]);
  const [captain, setCaptain] = useState(null);
  const [eligByPlayerNum, setEligByPlayerNum] = useState(null); // null = nothing imported for this division

  useEffect(() => {
    db.getTeamScheduleOverview(team.id).then(o => setOverview(o ?? null));
    db.listRosterForTeam(team.id).then(setRoster);
    db.listTeamCaptains().then(map => setCaptain(map[team.id] ?? null));
  }, [team.id]);

  useEffect(() => {
    if (overview === undefined) return;
    if (!overview) { setStandingsRow(null); setEligByPlayerNum(null); return; }
    db.getTeamStandingsRow(team.id, overview.team.division_id).then(row => setStandingsRow(row ?? null));
    db.listPlayoffEligibilityForDivision(overview.team.division_id).then(rows => {
      if (!rows.length) { setEligByPlayerNum(null); return; }
      const map = {};
      for (const r of rows) if (r.player_num) map[r.player_num] = r;
      setEligByPlayerNum(map);
    });
  }, [overview, team.id]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = (overview?.myWeeks ?? [])
    .map(w => { const parts = (w.date||"").split("/").map(Number); return { ...w, _date: parts.length>=3 && !parts.some(isNaN) ? new Date(parts[2],parts[0]-1,parts[1]) : null }; })
    .filter(w => w._date && w._date >= today)
    .sort((a, b) => a._date - b._date);
  const previous = overview?.myCompleted ?? [];
  const headToHead = db.computeTeamHeadToHead(previous, team.id);

  return (
    <>
      {standingsRow === undefined && <Loader />}
      {standingsRow && (
        <div className="card">
          <div className="card__title">Team Record — {standingsRow.rank} of {standingsRow.totalTeams}</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:6}}>
            {[
              { label: "Wins", value: standingsRow.wins },
              { label: "Losses", value: standingsRow.losses },
              { label: "Points", value: standingsRow.totalPoints },
              { label: "Sets For", value: standingsRow.setsFor },
              { label: "Sets Against", value: standingsRow.setsAgainst },
              { label: "Pts / Set", value: standingsRow.pointsPerSet },
            ].map(b => (
              <div key={b.label} style={{textAlign:"center",background:"#141414",border:"1px solid #2A2A2A",borderRadius:10,padding:"12px 6px"}}>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:18,fontWeight:700,color:"#5FCF9E"}}>{b.value}</div>
                <div style={{fontSize:9.5,color:"#8A8A8A",marginTop:3,textTransform:"uppercase",letterSpacing:"0.03em"}}>{b.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {standingsRow === null && <div className="empty-state">No standings yet for this team's division.</div>}

      <div className="card">
        <div className="card__title">Roster ({roster.length}){captain ? ` — Captain @${captain.username}` : ""}</div>
        {roster.length === 0 ? <div className="dash-empty">No roster on file.</div> : (
          <div className="list" style={{marginTop:6}}>
            {roster.map(p => {
              const elig = eligByPlayerNum?.[p.num] ?? null;
              return (
                <div key={p.num} className="list-row">
                  <div className="list-row__body">
                    <div style={{flex:1}}>
                      <Link to={`/player-lookup?num=${p.num}`} className="list-row__name" style={{color:"inherit",textDecoration:"none"}}>
                        {p.name}{p.nickname ? ` "${p.nickname}"` : ""}
                      </Link>
                      {elig && (
                        <div style={{marginTop:3}}>
                          <span className="player-rating-badge" style={{
                            fontSize:9.5, fontWeight:700, padding:"2px 8px",
                            color: elig.elig_code === "E" ? "#5FCF9E" : "#F59E0B",
                            background: elig.elig_code === "E" ? "#16332A" : "#2A1F00",
                          }}>
                            {elig.elig_code === "E" ? "Playoff Eligible" : PLAYOFF_ELIG_LABELS[elig.elig_code] ?? "Not Eligible"}
                          </span>
                        </div>
                      )}
                    </div>
                    <span className="player-rating-badge">{p.rating ?? "—"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__title">Upcoming ({upcoming.length})</div>
        {upcoming.length === 0 ? <div className="dash-empty">No upcoming matches.</div> : (
          <div className="list" style={{marginTop:6}}>
            {upcoming.slice(0, 5).map((w, i) => {
              const pairing = w.pairings[0];
              const oppId = pairing.homeTeamId === team.id ? pairing.awayTeamId : pairing.homeTeamId;
              const oppName = opponentNameFor(pairing, team.id, overview.teams);
              return (
                <div key={i} className="list-row">
                  <div className="list-row__body">
                    <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                      <span className="list-row__name">
                        vs {oppId ? <Link to={`/team-lookup?team=${oppId}`} style={{color:"inherit"}}>{oppName}</Link> : oppName}
                      </span>
                      <span className="list-row__sub">{w.date}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__title">Recent Results ({previous.length})</div>
        {previous.length === 0 ? <div className="dash-empty">No matches played yet.</div> : (
          <div className="list" style={{marginTop:6}}>
            {previous.slice(0, 8).map((m, i) => {
              const isHome = m.team_home_id === team.id;
              const oppId = isHome ? m.team_away_id : m.team_home_id;
              const oppName = isHome ? m.team_away_name : m.team_home_name;
              const myPts = isHome ? m.team_home_points : m.team_away_points;
              const oppPts = isHome ? m.team_away_points : m.team_home_points;
              const result = m.is_makeup_pending ? "Makeup Pending" : (myPts != null && oppPts != null ? `${myPts}–${oppPts}` : "—");
              return (
                <div key={i} className="list-row">
                  <div className="list-row__body">
                    <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                      <span className="list-row__name">
                        vs {oppId ? <Link to={`/team-lookup?team=${oppId}`} style={{color:"inherit"}}>{oppName ?? "—"}</Link> : (oppName ?? "—")}
                      </span>
                      <span className="list-row__sub">{m.week_date || ""} · {result}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {headToHead.length > 0 && (
        <div className="card">
          <div className="card__title">Head-to-Head</div>
          <div style={{fontSize:10,color:"#6A6A6A",marginBottom:2}}>This season only — teams get a fresh roster/id each season, so history doesn't carry across.</div>
          <div className="list" style={{marginTop:6}}>
            {headToHead.map(h => (
              <div key={h.teamId} className="list-row">
                <div className="list-row__body">
                  <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                    <span className="list-row__name"><Link to={`/team-lookup?team=${h.teamId}`} style={{color:"inherit"}}>{h.name}</Link></span>
                    <span className="list-row__sub">{h.matchesPlayed} match{h.matchesPlayed!==1?"es":""} · {h.myPoints}–{h.oppPoints} pts</span>
                  </div>
                  <span className="player-rating-badge">{h.wins}W–{h.losses}L</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <TeamStatsPanel teamId={team.id} />
    </>
  );
}

// Legacy Team Lookup placeholder retained from the Old version for zero-loss compatibility.
// The active `teamlookup` route uses TeamLookupPage; this component remains available
// for any legacy route/import that still references the original placeholder.
function TeamLookupPlaceholder() {
  const [searchParams] = useSearchParams();
  const teamId = searchParams.get("team");
  const [teamName, setTeamName] = useState(null);
  const [loading, setLoading] = useState(!!teamId);

  useEffect(() => {
    if (!teamId) return;
    db.listAllTeamsWithContext().then(all => {
      const t = all.find(x => x.id === teamId);
      setTeamName(t ? t.name : null);
      setLoading(false);
    });
  }, [teamId]);

  return (
    <>
      <PageHeader title="Team Lookup / History" />
      <div className="tab-content">
        <div className="empty-state">
          {!teamId
            ? "Coming soon."
            : loading
            ? "Loading…"
            : `Coming soon — this will show stats & history for ${teamName ?? "this team"}.`}
        </div>
      </div>
    </>
  );
}

function TeamLookupPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const teamId = searchParams.get("team");
  const [allTeams, setAllTeams] = useState(undefined);
  const [query, setQuery] = useState("");

  useEffect(() => { db.listAllTeamsWithContext().then(setAllTeams); }, []);

  const team = teamId && allTeams ? allTeams.find(t => t.id === teamId) : null;

  if (teamId) {
    return (
      <>
        <PageHeader title="Team Lookup" subtitle={team ? `${team.name} · ${team.context}` : undefined} />
        <div className="tab-content">
          <button className="btn-secondary no-print" onClick={() => setSearchParams({})}>← All Teams</button>
          {allTeams === undefined && <Loader />}
          {allTeams && !team && <div className="empty-state">Team not found.</div>}
          {team && <TeamDetailView team={team} />}
        </div>
      </>
    );
  }

  const filtered = (allTeams ?? []).filter(t => !t.isBye && (!query.trim() || t.name.toLowerCase().includes(query.trim().toLowerCase())));

  return (
    <>
      <PageHeader title="Team Lookup" />
      <div className="tab-content">
        {allTeams === undefined && <Loader />}
        {allTeams && (
          <div className="card">
            <div className="card__title">Search Teams</div>
            <input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Start typing a team name…" autoFocus />
            <div className="list" style={{marginTop:8}}>
              {filtered.map(t => (
                <div key={t.id} className="list-row" style={{cursor:"pointer"}} onClick={() => setSearchParams({ team: t.id })}>
                  <div className="list-row__body">
                    <div style={{flex:1}}>
                      <div className="list-row__name">{t.name}</div>
                      <div className="list-row__sub">{t.context}{t.isActiveSeason ? " · Active" : ""}</div>
                    </div>
                    <ChevronRight size={14} color="#6A6A6A" />
                  </div>
                </div>
              ))}
              {filtered.length === 0 && <div className="empty-state" style={{border:"none"}}>No teams match.</div>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Season + Division Banner ─────────────────────────────────────────────────
function SeasonDivBanner({ seasons, activeSeasons, viewingSeason, viewingDiv, onView, readOnly }) {
  const [open, setOpen] = useState(false);
  const isActive = !!viewingSeason?.is_active;
  const divName = viewingDiv ? `Div ${viewingDiv.num}${viewingDiv.name ? " · " + viewingDiv.name : ""}` : "No division";

  return (
    <div className="season-banner">
      <div className="season-banner__row" onClick={() => setOpen(v => !v)}>
        <div>
          <div className="season-banner__label">{isActive ? "Active" : "Viewing (read-only)"}</div>
          <div className="season-banner__name">{viewingSeason ? seasonLabel(viewingSeason) : "No season selected"}</div>
          {viewingDiv && <div className="season-banner__div">{divName}</div>}
        </div>
        <ChevronDown size={14} color="#9A9A9A" style={{transform: open?"rotate(180deg)":"none", transition:"0.2s", flexShrink:0}} />
      </div>
      {open && (
        <div className="season-picker">
          {seasons.map((s) => {
            const divs = s.divisions ?? [];
            return (
              <div key={s.id}>
                <div className={`season-picker__season-header ${s.is_active?"season-picker__season-header--active":""}`}>
                  <span>{seasonLabel(s)}</span>
                  {s.is_active && <span className="active-dot">● Active</span>}
                </div>
                {divs.length === 0 && (
                  <button className="season-picker__btn season-picker__btn--div"
                    onClick={() => { onView(s, null); setOpen(false); }}>
                    No divisions yet
                  </button>
                )}
                {divs.map((d) => {
                  const isThis = viewingSeason?.id === s.id && viewingDiv?.id === d.id;
                  return (
                    <button key={d.id} className={`season-picker__btn season-picker__btn--div ${isThis?"season-picker__btn--active":""}`}
                      onClick={() => { onView(s, d); setOpen(false); }}>
                      Div {d.num}{d.name ? ` · ${d.name}` : ""}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {readOnly && !isActive && (
        <div className="readonly-bar">Read-only — switch to an active season to make changes</div>
      )}
      {isActive && !viewingDiv && (
        <div className="readonly-bar">No division selected — add a division in the Season tab to enable imports</div>
      )}
    </div>
  );
}

// ─── Seasons Tab ──────────────────────────────────────────────────────────────
function SeasonsTab({ seasons, subTab, onCreateSeason, onDeleteSeason, onToggleActive, onAddDivision, onRemoveDivision, onUpdateDivision, seasonIdsNeedingTeams, onImportTeams, onSeasonCreated, onImportIbaSchedule }) {
  const [type, setType]     = useState("Summer");
  const [year, setYear]     = useState(CURRENT_YEAR);
  const [format, setFormat] = useState("Masters");
  const [day, setDay]       = useState("Wednesday");
  const [error, setError]   = useState("");
  const [saved, setSaved]   = useState(false);
  const [divNum, setDivNum] = useState("");
  const [divName, setDivName] = useState("");
  const [expandedSeason, setExpandedSeason] = useState(null);
  const [editingDivId, setEditingDivId] = useState(null);
  const [editDivNum, setEditDivNum] = useState("");
  const [editDivName, setEditDivName] = useState("");
  const [editDivError, setEditDivError] = useState("");

  // Clear any leftover error banner when switching sub-tabs, so an error
  // from one context (e.g. deleting a season) doesn't linger into another
  // (e.g. the Create a Season form).
  useEffect(() => { setError(""); }, [subTab]);

  const createSeason = async () => {
    const exists = seasons.find(x => x.type===type && x.year===parseInt(year) && x.format===format && x.day===day);
    if (exists) { setError("That season already exists."); return; }
    const created = await onCreateSeason({ type, year: parseInt(year), format, day });
    if (!created) { setError("Could not create season."); return; }
    setError(""); setSaved(true); setTimeout(() => setSaved(false), 1800);
    onSeasonCreated?.(created);
    setExpandedSeason(created.id);
  };

  const deleteSeason = async (s) => {
    if (s.is_active) { setError("Deactivate this season before deleting it."); return; }
    await onDeleteSeason(s.id);
  };

  const addDivision = async (s) => {
    if (!divNum.trim()) return;
    const divs = s.divisions ?? [];
    if (divs.find(d => d.num === divNum.trim())) { setError("Division already exists."); return; }
    await onAddDivision(s, divNum.trim(), divName.trim());
    setDivNum(""); setDivName(""); setError("");
  };

  const startEditDivision = (d) => {
    setEditingDivId(d.id); setEditDivNum(d.num ?? ""); setEditDivName(d.name ?? ""); setEditDivError("");
  };
  const cancelEditDivision = () => {
    setEditingDivId(null); setEditDivError("");
  };
  const saveEditDivision = async (s) => {
    if (!editDivNum.trim()) { setEditDivError("Division # is required."); return; }
    const divs = s.divisions ?? [];
    if (divs.find(d => d.id !== editingDivId && d.num === editDivNum.trim())) {
      setEditDivError("Another division already uses that number."); return;
    }
    const ok = await onUpdateDivision(editingDivId, editDivNum.trim(), editDivName.trim());
    if (!ok) { setEditDivError("Could not save changes."); return; }
    setEditingDivId(null); setEditDivError("");
  };

  const list = subTab === "inactive" ? seasons.filter(s => !s.is_active) : seasons.filter(s => s.is_active);

  return (
    <>
      {error && <ErrorMsg>{error}</ErrorMsg>}

      {subTab === "create" && (
        <div className="card">
          <div className="card__title">Create Season</div>
          <div className="field"><Label>Type</Label>
            <div className="seg-control">
              {SEASON_TYPES.map(t => <button key={t} className={`seg-btn ${type===t?"seg-btn--active":""}`} onClick={()=>setType(t)}>{t}</button>)}
            </div>
          </div>
          <div className="field"><Label>Year</Label>
            <div className="seg-control">
              {YEARS.map(y => <button key={y} className={`seg-btn ${year===y?"seg-btn--active":""}`} onClick={()=>setYear(y)}>{y}</button>)}
            </div>
          </div>
          <div className="field"><Label>Format</Label>
            <div className="seg-control">
              {SEASON_FORMATS.map(f => <button key={f} className={`seg-btn ${format===f?"seg-btn--active":""}`} onClick={()=>setFormat(f)}>{f}</button>)}
            </div>
          </div>
          <div className="field"><Label>Day</Label>
            <div className="seg-control" style={{flexWrap:"wrap"}}>
              {SEASON_DAYS.map(d => <button key={d} className={`seg-btn ${day===d?"seg-btn--active":""}`} onClick={()=>setDay(d)}>{d.slice(0,3)}</button>)}
            </div>
          </div>
          <div className="season-preview">
            <Star size={11} color="#F59E0B" /> {type} · {year} · {format} · {day}
          </div>
          <button className="btn-primary" onClick={createSeason}>
            {saved ? <><Check size={13}/> Created!</> : "Create Season"}
          </button>
        </div>
      )}

      {subTab !== "create" && (
        <>
          <SectionHeader title={`${subTab==="inactive"?"Inactive":"Active"} Seasons (${list.length})`} />
          {list.length === 0
            ? <div className="empty-state">No {subTab==="inactive"?"inactive":"active"} seasons{subTab==="inactive"?"":" yet"}.</div>
            : list.map((s) => {
                const isAct        = s.is_active;
                const isExpanded   = expandedSeason === s.id;
                const divs         = s.divisions ?? [];
                const needsTeams   = seasonIdsNeedingTeams?.has(s.id);
                return (
                  <div key={s.id} className={`season-card ${isAct?"season-card--active":""}`}>
                    <div className="season-card__header" onClick={()=>setExpandedSeason(isExpanded?null:s.id)}>
                      <div>
                        <div className="season-card__name">{seasonLabel(s)}</div>
                        <div className="season-card__meta">{divs.length} division{divs.length!==1?"s":""}{isAct?" · ● Active":""}</div>
                      </div>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        {needsTeams && (
                          <button className="btn-sm btn-sm--accent" onClick={e=>{e.stopPropagation();onImportTeams(s.id);}}>
                            Import Teams <ChevronRight size={11}/>
                          </button>
                        )}
                        <button className="btn-sm" onClick={e=>{e.stopPropagation();setExpandedSeason(s.id);}}>
                          IBA Schedule <Calendar size={11}/>
                        </button>
                        <button className={`btn-sm ${isAct?"btn-sm--warn":"btn-sm--accent"}`}
                          onClick={e=>{e.stopPropagation();onToggleActive(s);if(!isAct)setExpandedSeason(s.id);}}>
                          {isAct?"Deactivate":"Set Active"}
                        </button>
                        {!isAct && <button className="btn-icon btn-icon--danger" onClick={e=>{e.stopPropagation();deleteSeason(s);}}><Trash2 size={13}/></button>}
                        {isExpanded ? <ChevronUp size={14} color="#9A9A9A"/> : <ChevronDown size={14} color="#9A9A9A"/>}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="season-card__body">
                        {divs.map((d) => (
                          editingDivId === d.id ? (
                            <div key={d.id} className="div-row div-row--edit">
                              <input className="edit-input" style={{width:70,flex:"none"}} placeholder="Div #" value={editDivNum}
                                onChange={e=>setEditDivNum(e.target.value)} onKeyDown={e=>{ if (e.key==="Enter") saveEditDivision(s); }} />
                              <input className="edit-input" style={{flex:1}} placeholder="Name (e.g. North)" value={editDivName}
                                onChange={e=>setEditDivName(e.target.value)} onKeyDown={e=>{ if (e.key==="Enter") saveEditDivision(s); }} />
                              <button className="btn-icon btn-icon--confirm" onClick={()=>saveEditDivision(s)}><Check size={13}/></button>
                              <button className="btn-icon btn-icon--cancel" onClick={cancelEditDivision}><X size={13}/></button>
                            </div>
                          ) : (
                            <div key={d.id} className="div-row">
                              <span className="div-row__num">Div {d.num}</span>
                              <span className="div-row__name">{d.name || "—"}</span>
                              <button className="btn-icon" onClick={()=>startEditDivision(d)}><Edit2 size={11}/></button>
                              <button className="btn-icon btn-icon--danger" onClick={()=>onRemoveDivision(d.id)}><Trash2 size={11}/></button>
                            </div>
                          )
                        ))}
                        {editDivError && <ErrorMsg>{editDivError}</ErrorMsg>}
                        <div className="div-add-row">
                          <input className="edit-input" style={{width:70,flex:"none"}} placeholder="Div #" value={divNum} onChange={e=>setDivNum(e.target.value)}/>
                          <input className="edit-input" style={{flex:1}} placeholder="Name (e.g. North)" value={divName} onChange={e=>setDivName(e.target.value)}/>
                          <button className="btn-icon btn-icon--confirm" onClick={()=>addDivision(s)} disabled={!divNum.trim()}><Plus size={13}/></button>
                        </div>
                        <IbaScheduleImportPanel season={s} onImported={onImportIbaSchedule} />
                        <div className="field" style={{marginTop:10}}>
                          <Label>Playoffs Start Date</Label>
                          <div style={{fontSize:12.5,color:s.playoffs_start_date?"#E0E0E0":"#6A6A6A",fontWeight:600}}>
                            {s.playoffs_start_date
                              ? new Date(s.playoffs_start_date+"T00:00:00").toLocaleDateString()
                              : "Not yet set"}
                          </div>
                          <div style={{fontSize:10.5,color:"#6A6A6A",marginTop:4}}>
                            {s.playoffs_start_date
                              ? `Makeups are due 2 weeks before this date — deadline ${new Date(new Date(s.playoffs_start_date+"T00:00:00").getTime() - 14*86400000).toLocaleDateString()}.`
                              : "Detected automatically from the week marked \"Playoffs\" when this division's schedule is imported on Manage Season Data."}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
          }
        </>
      )}
    </>
  );
}

// ─── Tonight Tab ──────────────────────────────────────────────────────────────
function TonightTab({ teams, schedule, resolveRoster, activeSeason, viewingDiv, isViewingActive, myProfile, isManager }) {
  const navigate = useNavigate();
  const [launching, setLaunching] = useState(null);
  const currentWeek = findCurrentWeek(schedule);
  const teamByIndex = (n) => teams[n - 1] ?? null;

  const matches = currentWeek?.pairings.map((p, i) => {
    const homeTeam   = teamByIndex(p.home);
    const awayTeam   = teamByIndex(p.away);
    const isBye      = !!(homeTeam?.isBye || awayTeam?.isBye);
    const homeRoster = homeTeam && !isBye ? resolveRoster(homeTeam.id) : [];
    const awayRoster = awayTeam && !isBye ? resolveRoster(awayTeam.id) : [];
    return { idx: i, homeTeam, awayTeam, homeRoster, awayRoster, pairing: p, isBye };
  }) ?? [];

  const buildSeed = (match, eligByNum = {}) => ({
    matchId: `match-w${currentWeek.week}-${match.pairing.home}v${match.pairing.away}-${Date.now()}`,
    schedulePairingId: match.pairing.id ?? null,
    format: activeSeason?.format?.toLowerCase() ?? "masters",
    venue: match.homeTeam.venue || "",
    seasonLabel: activeSeason ? seasonLabel(activeSeason) : null,
    divisionId: viewingDiv?.id ?? null,
    divNum: viewingDiv?.num ?? null,
    divName: viewingDiv?.name ?? null,
    weekNum: currentWeek.week,
    weekDate: currentWeek.date,
    // Drives playoff-eligibility gating in the draft screen -- ONLY set from
    // the schedule week's own is_playoff flag, not derived from
    // playoffsStartDate/weekDate (that pairing already separately powers
    // forfeit-point tiers and is left alone here).
    isPlayoff: !!currentWeek.isPlayoff,
    playoffsStartDate: activeSeason?.playoffs_start_date ?? null,
    teamHome: { id: match.homeTeam.id, name: match.homeTeam.name, roster: match.homeRoster.map(p=>({num:p.num,name:p.name,nickname:p.nickname,rating:p.rating,eligCode:eligByNum[p.num]?.code ?? null})) },
    teamAway: { id: match.awayTeam.id, name: match.awayTeam.name, roster: match.awayRoster.map(p=>({num:p.num,name:p.name,nickname:p.nickname,rating:p.rating,eligCode:eligByNum[p.num]?.code ?? null})) },
    sets: Array(5).fill(null).map((_, si) => ({
      setNum: si + 1, playerHome: null, playerAway: null, racks: [], winnerSlot: null, complete: false,
    })),
    coinFlipLoser: null,
    phase: "lineup",
    confirmedHome: false,
    confirmedAway: false,
    disputedBy: null,
    disputeNote: null,
    scorerHome: null, scorerAway: null, unavailableHome: false, unavailableAway: false,
  });

  // Each scheduled pairing gets its own live session now (concurrent matches
  // are the normal case), so "scoring" a match just means opening/creating
  // that specific pairing's session and going there -- no separate admin
  // "seed" step first.
  const goScoreMatch = async (match) => {
    if (!match.homeTeam || !match.awayTeam || match.isBye || !match.pairing.id) return;
    setLaunching(match.pairing.id);
    const existing = await db.getLiveMatch(match.pairing.id);
    if (!existing) {
      // Eligibility only matters (and is only fetched) for a genuine
      // playoff week -- no reason to query it every time a regular-season
      // match gets launched.
      let eligByNum = {};
      if (currentWeek.isPlayoff && viewingDiv) {
        eligByNum = db.eligibilityByPlayerNum(await db.listPlayoffEligibility(viewingDiv.id));
      }
      const ok = await db.setLiveMatch(match.pairing.id, buildSeed(match, eligByNum));
      if (!ok) { setLaunching(null); alert("Could not start this match — please try again."); return; }
    }
    setLaunching(null);
    navigate(`/live?pairing=${match.pairing.id}`);
  };

  // Which of tonight's matches (if any) belong to the signed-in captain or
  // player's own team -- either a direct account-to-team link, or a
  // roster-number link.
  const myMatches = (!isManager && myProfile) ? matches.filter(m => !m.isBye && m.homeTeam && m.awayTeam && (
    myProfile.team_id === m.homeTeam.id || myProfile.team_id === m.awayTeam.id
    || (myProfile.player_num && (m.homeRoster.some(p=>p.num===myProfile.player_num) || m.awayRoster.some(p=>p.num===myProfile.player_num)))
  )) : [];

  if (!currentWeek) return <div className="empty-state">No schedule loaded. Import one in the Schedule tab.</div>;
  const playableMatches = matches.filter(m => !m.isBye);
  const readyCount = playableMatches.filter(m => m.homeRoster.length >= 5 && m.awayRoster.length >= 5).length;

  return (
    <>
      <div className="tonight-header">
        <div className="tonight-header__week">Week {currentWeek.week}</div>
        <div className="tonight-header__date">{currentWeek.date}</div>
        <div className="tonight-header__status">{readyCount}/{playableMatches.length} matches roster-ready</div>
      </div>
      {!isViewingActive && <div className="readonly-bar">Viewing past season — scoring disabled</div>}

      {!isManager && myProfile && (
        myMatches.length === 0 ? (
          <div className="empty-state">No match scheduled for your team tonight.</div>
        ) : (
          <div className="card" style={{marginBottom:4}}>
            <div className="card__title">Your Match Tonight</div>
            {myMatches.map(m => (
              <button key={m.idx} className="btn-primary" style={{marginTop:6}} disabled={!isViewingActive || launching===m.pairing.id}
                onClick={()=>goScoreMatch(m)}>
                {launching===m.pairing.id ? "Opening…" : `Score: ${m.homeTeam.name} vs ${m.awayTeam.name}`}
              </button>
            ))}
          </div>
        )
      )}

      {matches.map((match, i) => {
        const bothReady = match.homeRoster.length >= 5 && match.awayRoster.length >= 5;
        if (match.isBye) {
          const byeTeam = match.homeTeam?.isBye ? match.awayTeam : match.homeTeam;
          return (
            <div key={i} className="match-card match-card--bye">
              <div className="match-card__bye-label">BYE — No Match</div>
              <div className="match-card__team-name" style={{textAlign:"center"}}>{byeTeam?.name ?? "—"}</div>
            </div>
          );
        }
        const eligible = isManager || myMatches.some(m => m.idx === match.idx);
        return (
          <div key={i} className="match-card">
            <div className="match-card__venue">{match.homeTeam?.venue ?? "—"}</div>
            <div className="match-card__teams">
              <div className="match-card__team match-card__team--home">
                <span className="match-card__team-name">{match.homeTeam?.name ?? `Team ${match.pairing.home}`}</span>
                <RosterBadge count={match.homeRoster.length} />
              </div>
              <span className="match-card__vs">vs</span>
              <div className="match-card__team match-card__team--away">
                <RosterBadge count={match.awayRoster.length} />
                <span className="match-card__team-name">{match.awayTeam?.name ?? `Team ${match.pairing.away}`}</span>
              </div>
            </div>
            {(match.homeRoster.length > 0 || match.awayRoster.length > 0) && (
              <div className="match-card__rosters">
                <RosterColumn roster={match.homeRoster} side="home" />
                <RosterColumn roster={match.awayRoster} side="away" />
              </div>
            )}
            {isViewingActive && eligible && (
              <button className={`match-card__launch ${bothReady?"match-card__launch--ready":""}`}
                onClick={() => goScoreMatch(match)} disabled={!match.homeTeam||!match.awayTeam||launching===match.pairing.id}>
                {launching===match.pairing.id ? "Opening…" : bothReady ? "▶ Score This Match" : "⚠ Score Anyway (incomplete rosters)"}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

function RosterBadge({ count }) {
  return <span className={`roster-badge ${count>=5?"roster-badge--ready":"roster-badge--warn"}`}>{count}p</span>;
}
function RosterColumn({ roster, side }) {
  return (
    <div className={`roster-col roster-col--${side}`}>
      {Array(5).fill(null).map((_,i) => {
        const p = roster[i];
        return (
          <div key={i} className={`roster-slot ${p?"":"roster-slot--empty"}`}>
            {p ? <><span className="roster-slot__name">{p.name}</span><span className="roster-slot__rating">{p.rating}</span></>
               : <span className="roster-slot__tbd">TBD</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── History Tab (standings, MVP, match list -> scoresheet) ───────────────────
// ─── Apply Forfeit (deadline-passed makeup resolution) ────────────────────────
// The short team (from the original makeup report) forfeits every table that
// never got played. For each one, a manager picks that team's forfeiting
// player (any member, 0 points) and the other team's receiving player
// (forfeit points per the format/tier table) -- same attribution rule as a
// live in-match forfeit, just applied administratively once the two-week
// makeup deadline has passed.
function ApplyForfeitPanel({ matchRow, onCancel, onDone }) {
  const shortTeam = matchRow.state?.makeup?.shortTeam;
  const receivingSide = shortTeam === "home" ? "away" : "home";
  const shortTeamName = shortTeam === "home" ? matchRow.team_home_name : matchRow.team_away_name;
  const receivingTeamName = receivingSide === "home" ? matchRow.team_home_name : matchRow.team_away_name;
  const remainingSets = (matchRow.state?.sets ?? []).filter(s => !s.complete);

  const [shortRoster, setShortRoster] = useState([]);
  const [receivingRoster, setReceivingRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [picks, setPicks] = useState({}); // { [setNum]: { forfeitingPlayer, receivingPlayer } }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const shortTeamId = shortTeam === "home" ? matchRow.team_home_id : matchRow.team_away_id;
    const receivingTeamId = receivingSide === "home" ? matchRow.team_home_id : matchRow.team_away_id;
    Promise.all([db.listRosterForTeam(shortTeamId), db.listRosterForTeam(receivingTeamId)])
      .then(([sr, rr]) => { setShortRoster(sr); setReceivingRoster(rr); setLoading(false); });
  }, [matchRow.id]);

  if (!shortTeam) {
    return (
      <div className="empty-state">
        This match doesn't have a recorded "short" team, so forfeits can't be auto-attributed. Resolve it manually via the Update Weekly League Data importers.
        <div style={{marginTop:10}}><button className="btn-secondary" onClick={onCancel}>← Back</button></div>
      </div>
    );
  }
  if (loading) return <Loader/>;

  const alreadyUsed = new Set([
    ...(matchRow.state?.sets ?? []).filter(s=>s.complete).flatMap(s => [s.playerHome?.num, s.playerAway?.num]),
    ...Object.values(picks).flatMap(p => [p.forfeitingPlayer?.num, p.receivingPlayer?.num]),
  ].filter(Boolean));

  const setPick = (setNum, field, player) => {
    setPicks(prev => ({ ...prev, [setNum]: { ...prev[setNum], [field]: player } }));
  };

  const allPicked = remainingSets.every(s => picks[s.setNum]?.forfeitingPlayer && picks[s.setNum]?.receivingPlayer);

  const submit = async () => {
    setSaving(true);
    const assignments = remainingSets.map(s => ({ setNum: s.setNum, forfeitingPlayer: picks[s.setNum].forfeitingPlayer, receivingPlayer: picks[s.setNum].receivingPlayer }));
    const ok = await db.applyForfeitToRemainingTables(matchRow, assignments);
    setSaving(false);
    if (!ok) { setError("Could not save forfeits. Try again."); return; }
    onDone();
  };

  return (
    <>
      <button className="btn-secondary" onClick={onCancel} style={{marginBottom:12}}>← Back</button>
      <div className="card" style={{borderColor:"#7F1D1D",background:"#2A1010"}}>
        <div className="card__title" style={{color:"#F87171"}}>Apply Forfeit — Deadline Passed</div>
        <div style={{fontSize:12.5,color:"#E0E0E0",lineHeight:1.5}}>
          <strong style={{color:"#F87171"}}>{shortTeamName}</strong> was short players & never completed the makeup. Assign a player from each team for every remaining table — {shortTeamName}'s player gets 0, {receivingTeamName}'s gets the forfeit point value.
        </div>
      </div>

      {remainingSets.map(s => {
        const pick = picks[s.setNum] ?? {};
        const shortAvailable = shortRoster.filter(p => !alreadyUsed.has(p.num) || pick.forfeitingPlayer?.num === p.num);
        const receivingAvailable = receivingRoster.filter(p => !alreadyUsed.has(p.num) || pick.receivingPlayer?.num === p.num);
        const points = pick.receivingPlayer ? db.computeForfeitPoints(
          { format: matchRow.state?.format, weekDate: matchRow.week_date, playoffsStartDate: matchRow.state?.playoffsStartDate },
          pick.receivingPlayer.rating
        ) : null;
        return (
          <div key={s.setNum} className="card">
            <div className="card__title">Table {s.setNum}</div>
            <div className="field">
              <Label>{shortTeamName} — forfeiting player (0 pts)</Label>
              <select className="input" value={pick.forfeitingPlayer?.num ?? ""} onChange={e=>setPick(s.setNum,"forfeitingPlayer", shortAvailable.find(p=>p.num===e.target.value) ?? null)}>
                <option value="">Select player…</option>
                {shortAvailable.map(p => <option key={p.num} value={p.num}>{p.name}{p.nickname?` "${p.nickname}"`:""} ({p.rating})</option>)}
              </select>
            </div>
            <div className="field">
              <Label>{receivingTeamName} — receiving player</Label>
              <select className="input" value={pick.receivingPlayer?.num ?? ""} onChange={e=>setPick(s.setNum,"receivingPlayer", receivingAvailable.find(p=>p.num===e.target.value) ?? null)}>
                <option value="">Select player…</option>
                {receivingAvailable.map(p => <option key={p.num} value={p.num}>{p.name}{p.nickname?` "${p.nickname}"`:""} ({p.rating})</option>)}
              </select>
            </div>
            {points != null && <div style={{fontSize:12,color:"#5FCF9E",fontWeight:700}}>{pick.receivingPlayer.name} credited {points} pts</div>}
          </div>
        );
      })}

      {error && <ErrorMsg>{error}</ErrorMsg>}
      <button className="btn-primary" onClick={submit} disabled={!allPicked || saving}>
        {saving ? "Saving…" : `Apply Forfeit${remainingSets.length!==1?"s":""} & Finalize Match`}
      </button>
    </>
  );
}

function HistoryTab({ divisionId, teams, isManager, playoffsStartDate, myProfile, seasonFormat, seasonLabelText }) {
  const navigate = useNavigate();
  const [subTab, setSubTab] = useState("standings");
  const [matches, setMatches] = useState([]);
  const [standingsAdj, setStandingsAdj] = useState([]);
  const [mvpAdj, setMvpAdj] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [resuming, setResuming] = useState(null);
  const [applyingForfeit, setApplyingForfeit] = useState(null);
  const [reopening, setReopening] = useState(null);
  const [showCorrectionLog, setShowCorrectionLog] = useState(false);
  // Manager-only: full rack-by-rack manual match entry (backfilling a paper
  // scoresheet, or any match that wasn't run through Live Entry). See
  // ManualMatchEntry below -- it reuses the exact same SetEntry component
  // Live Entry uses, so scoring math never drifts between the two paths.
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  // { mode: "pick" | "edit" | "respond", match, set? }
  const [correctionFlow, setCorrectionFlow] = useState(null);

  const makeupDeadline = playoffsStartDate
    ? new Date(new Date(playoffsStartDate + "T00:00:00").getTime() - 14 * 86400000)
    : null;
  const isPastDeadline = makeupDeadline ? Date.now() > makeupDeadline.getTime() : false;

  // Same-night check mirrors the server-side rule in reopen_match_for_editing()
  // -- this is just for deciding whether to show the button; the RPC is the
  // real enforcement either way. "Match night" is either the originally
  // scheduled date (week_date, free text, typically M/D/YYYY -- an
  // unparseable value just skips that check rather than guessing) OR the
  // actual calendar date it was confirmed, so a makeup played and confirmed
  // on some other night still counts as that captain's match night.
  const isSameCalendarDay = (d) => {
    const today = new Date();
    return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  };
  const isMatchNight = (m) => {
    if (m.week_date) {
      const parts = m.week_date.split("/").map(Number);
      if (parts.length >= 3 && !parts.some(n => Number.isNaN(n))) {
        const [mo, d, y] = parts;
        if (isSameCalendarDay(new Date(y, mo - 1, d))) return true;
      }
    }
    if (m.confirmed_at && isSameCalendarDay(new Date(m.confirmed_at))) return true;
    return false;
  };
  const mySlotInMatch = (m) => myProfile?.team_id === m.team_home_id ? "home" : myProfile?.team_id === m.team_away_id ? "away" : null;
  const isCaptainOfMatch = (m) => myProfile?.role === "captain" && !!mySlotInMatch(m);
  const canReopen = (m) => !m.is_makeup_pending && !m.reopened_at && (m.team_home_total!=null || m.team_away_total!=null)
    && (isManager || (isCaptainOfMatch(m) && isMatchNight(m)));
  const canRespondToPending = (m) => !!m.pending_correction
    && (isManager || (isCaptainOfMatch(m) && mySlotInMatch(m) !== m.pending_correction.proposedByTeam));

  const handleReopen = async (m) => {
    setReopening(m.id);
    const { ok, reason } = await db.reopenMatchForEditing(m.id);
    setReopening(null);
    if (!ok) {
      alert(reason === "ALREADY_REOPENED"
        ? "This match is already reopened for editing."
        : "This can only be reopened by a captain on match night, or by a league manager afterward.");
      return;
    }
    setSelectedMatch(null);
    setCorrectionFlow({ mode: "pick", match: { ...m, reopened_at: new Date().toISOString() } });
  };
  const handleCancelReopen = async (m) => {
    await db.cancelReopen(m.id);
    setCorrectionFlow(null);
    refresh();
  };

  const resumeMakeup = async (m) => {
    setResuming(m.id);
    const ok = await db.resumeMakeupMatch(m);
    setResuming(null);
    if (ok) navigate(`/live?pairing=${m.state?.schedulePairingId}`);
    else alert("Could not resume this match — it may be missing its original schedule link.");
  };

  const refresh = () => {
    setLoading(true);
    Promise.all([
      db.listCompletedMatches(divisionId),
      db.listStandingsAdjustments(divisionId),
      db.listMvpAdjustments(divisionId),
    ]).then(([m, sa, ma]) => { setMatches(m); setStandingsAdj(sa); setMvpAdj(ma); setLoading(false); });
  };
  useEffect(refresh, [divisionId]);

  if (manualEntryOpen) {
    return (
      <div className="tab-content">
        <style>{liveEntryCss}</style>
        <ManualMatchEntry divisionId={divisionId} teams={teams} format={seasonFormat || "masters"}
          seasonLabelText={seasonLabelText} playoffsStartDate={playoffsStartDate}
          onCancel={()=>setManualEntryOpen(false)}
          onDone={()=>{ setManualEntryOpen(false); refresh(); }} />
      </div>
    );
  }

  if (applyingForfeit) {
    return (
      <div className="tab-content">
        <ApplyForfeitPanel matchRow={applyingForfeit} onCancel={()=>setApplyingForfeit(null)}
          onDone={()=>{ setApplyingForfeit(null); refresh(); }} />
      </div>
    );
  }

  if (correctionFlow?.mode === "pick") {
    return (
      <div className="tab-content">
        <SetPicker match={correctionFlow.match}
          onPick={(set)=>setCorrectionFlow({ mode: "edit", match: correctionFlow.match, set })}
          onCancel={()=>handleCancelReopen(correctionFlow.match)} />
      </div>
    );
  }

  if (correctionFlow?.mode === "edit") {
    return (
      <div className="tab-content">
        <SetCorrectionForm match={correctionFlow.match} set={correctionFlow.set} isManager={isManager} myProfile={myProfile}
          onCancel={()=>setCorrectionFlow({ mode: "pick", match: correctionFlow.match })}
          onDone={()=>{ setCorrectionFlow(null); refresh(); }} />
      </div>
    );
  }

  if (correctionFlow?.mode === "respond") {
    return (
      <div className="tab-content">
        <RespondToCorrection match={correctionFlow.match} onDone={()=>{ setCorrectionFlow(null); refresh(); }} />
      </div>
    );
  }

  if (selectedMatch) {
    if (selectedMatch.is_makeup_pending && selectedMatch.team_home_total==null && selectedMatch.team_away_total==null) {
      return (
        <div className="tab-content">
          <button className="btn-secondary" onClick={()=>setSelectedMatch(null)} style={{marginBottom:12}}>← Back</button>
          <div className="card" style={{borderColor:"#92400E",background:"#2A1F00"}}>
            <div className="card__title" style={{color:"#F59E0B"}}>Makeup Pending</div>
            <div style={{fontSize:13,fontWeight:700,color:"#FFF",marginBottom:6}}>{selectedMatch.team_home_name} vs {selectedMatch.team_away_name}</div>
            <div style={{fontSize:11.5,color:"#9A9A9A",marginBottom:10}}>{selectedMatch.week_num?`Week ${selectedMatch.week_num} · `:""}{selectedMatch.week_date||""}</div>
            {(() => { const st = selectedMatch.state?.makeup?.shortTeam; const name = st==="home"?selectedMatch.team_home_name:st==="away"?selectedMatch.team_away_name:null;
              return name ? <div style={{fontSize:12.5,color:"#E0E0E0",marginBottom:4}}><strong style={{color:"#F59E0B"}}>{name}</strong> is short players.</div> : null; })()}
            <div style={{fontSize:12.5,color:"#E0E0E0",lineHeight:1.5}}>{selectedMatch.state?.makeup?.reason || "Neither team could field any shooters."}</div>
          </div>
          <div className="empty-state">No tables were played. This match needs to be rescheduled & played in full.</div>
        </div>
      );
    }
    const history = selectedMatch.correction_history ?? [];
    const pending = selectedMatch.pending_correction;
    return (
      <div className="tab-content" style={{padding:0}}>
        {(canReopen(selectedMatch) || selectedMatch.reopened_at || history.length>0) && (
          <div className="card" style={{margin:14,marginBottom:0}}>
            {pending && (
              <div style={{fontSize:12,color:"#F59E0B",fontWeight:700,marginBottom:8}}>
                Set {pending.setNum} correction proposed{pending.proposedByTeam ? ` by ${pending.proposedByTeam==="home" ? selectedMatch.team_home_name : selectedMatch.team_away_name}` : ""} — awaiting confirmation.
              </div>
            )}
            {!pending && selectedMatch.reopened_at && (
              <div style={{fontSize:12,color:"#F59E0B",fontWeight:700,marginBottom:8}}>
                Reopened {new Date(selectedMatch.reopened_at).toLocaleString()} — pick a set below to correct it.
              </div>
            )}
            {history.length>0 && (
              <div style={{fontSize:11,color:"#9A9A9A",marginBottom:8}}>
                {history.length} correction{history.length!==1?"s":""} on record.{" "}
                <button className="btn-icon" style={{display:"inline",width:"auto",padding:"0 4px",color:"#5FCF9E"}} onClick={()=>setShowCorrectionLog(v=>!v)}>
                  {showCorrectionLog?"Hide":"View"}
                </button>
                {showCorrectionLog && (
                  <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:6}}>
                    {history.map((c,i)=>(
                      <div key={i}>{new Date(c.at).toLocaleDateString()} — {c.before?.homeTotal ?? "–"}–{c.before?.awayTotal ?? "–"} → {c.after?.homeTotal ?? "–"}–{c.after?.awayTotal ?? "–"}{c.reason?` (${c.reason})`:""}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div style={{display:"flex",gap:8}}>
              {canReopen(selectedMatch) && (
                <button className="btn-sm" onClick={()=>handleReopen(selectedMatch)} disabled={reopening===selectedMatch.id}>
                  {reopening===selectedMatch.id ? "Opening…" : "Reopen for Editing"}
                </button>
              )}
              {pending && canRespondToPending(selectedMatch) && (
                <button className="btn-sm btn-sm--accent" onClick={()=>{setCorrectionFlow({ mode: "respond", match: selectedMatch }); setSelectedMatch(null);}}>
                  Review Correction
                </button>
              )}
              {!pending && selectedMatch.reopened_at && (isManager || isCaptainOfMatch(selectedMatch)) && (
                <>
                  <button className="btn-sm btn-sm--accent" onClick={()=>{setCorrectionFlow({ mode: "pick", match: selectedMatch }); setSelectedMatch(null);}}>
                    Pick a Set to Correct
                  </button>
                  <button className="btn-sm" onClick={()=>handleCancelReopen(selectedMatch)}>Cancel Reopen</button>
                </>
              )}
            </div>
          </div>
        )}
        <Scoresheet match={selectedMatch} onClose={() => setSelectedMatch(null)} />
      </div>
    );
  }

  if (loading) return <Loader/>;

  const standings = db.computeStandings(matches, standingsAdj);
  const mvp = db.computeMvp(matches, mvpAdj);
  const nothingYet = matches.length === 0 && standings.length === 0 && mvp.length === 0;

  if (nothingYet) {
    return (
      <>
        <div className="empty-state">No completed matches yet for this division. Once both teams confirm a live match's final score, it'll show up here.</div>
        {isManager && (
          <button className="btn-secondary" onClick={()=>setManualEntryOpen(true)}>
            <Plus size={13}/> Manually Record a Match
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <div className="sub-tab-bar">
        <button className={`sub-tab ${subTab==="standings"?"sub-tab--active":""}`} onClick={()=>setSubTab("standings")}>Standings</button>
        <button className={`sub-tab ${subTab==="mvp"?"sub-tab--active":""}`} onClick={()=>setSubTab("mvp")}>MVP</button>
        <button className={`sub-tab ${subTab==="matches"?"sub-tab--active":""}`} onClick={()=>setSubTab("matches")}>Matches ({matches.length})</button>
        <button className={`sub-tab ${subTab==="playoffs"?"sub-tab--active":""}`} onClick={()=>setSubTab("playoffs")}>Playoffs</button>
      </div>

      {subTab==="playoffs" && <PlayoffsHistoryView divisionId={divisionId} teams={teams} />}

      {subTab==="standings" && (
        <>
          <div className="list">
            {standings.map((t, i) => (
              <div key={t.teamId} className="list-row">
                <div className="list-row__body">
                  <span className="list-row__id">{i+1}</span>
                  <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                    <span className="list-row__name">{t.name}</span>
                    <span className="list-row__sub">{t.wins}-{t.losses} · {t.setsFor}–{t.setsAgainst} sets</span>
                  </div>
                  <span className="player-rating-badge">{t.totalPoints} pts</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {subTab==="mvp" && (
        <>
          <div className="list">
            {mvp.map((p, i) => (
              <div key={p.num} className="list-row">
                <div className="list-row__body">
                  <span className="list-row__id">{i+1}</span>
                  <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                    <span className="list-row__name">{p.name}</span>
                    <span className="list-row__sub">{p.wins}W–{p.losses}L · {p.pointsScored} pts scored</span>
                  </div>
                  <span className="player-rating-badge">{p.mvpRanking}</span>
                </div>
              </div>
            ))}
          </div>
          {isManager && <SeedMvpImport divisionId={divisionId} onImported={refresh} existingCount={mvpAdj.length} />}
        </>
      )}

      {subTab==="matches" && (
        <>
          {isManager && (
            <button className="btn-sm" onClick={()=>setManualEntryOpen(true)}>
              <Plus size={12}/> Manually Record a Match
            </button>
          )}
        <div className="list">
          {matches.length === 0 && <div className="empty-state" style={{border:"none"}}>No completed matches recorded from Live Entry yet.</div>}
          {matches.map(m => {
            const pastDeadline = m.is_makeup_pending && isPastDeadline;
            return (
              <div key={m.id} className="list-row match-history-row">
                <button className="list-row__body" style={{background:"none",border:"none",textAlign:"left",cursor:"pointer",flex:1}} onClick={()=>setSelectedMatch(m)}>
                  <div style={{display:"flex",flexDirection:"column",gap:1,flex:1,textAlign:"left"}}>
                    <span className="list-row__name">{m.team_home_name} vs {m.team_away_name}</span>
                    <span className="list-row__sub">{m.week_num?`Week ${m.week_num} · `:""}{m.week_date||""}</span>
                    {pastDeadline && <span className="list-row__sub" style={{color:"#F87171"}}>Past makeup deadline ({makeupDeadline.toLocaleDateString()})</span>}
                    {m.is_makeup_pending && !pastDeadline && makeupDeadline && <span className="list-row__sub" style={{color:"#9A9A9A"}}>Due by {makeupDeadline.toLocaleDateString()}</span>}
                  </div>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3}}>
                    {(m.team_home_total!=null || m.team_away_total!=null) && (
                      <span className="player-rating-badge">{m.team_home_total ?? 0}–{m.team_away_total ?? 0}</span>
                    )}
                    {m.is_makeup_pending && <span className="makeup-pending-badge" style={pastDeadline?{color:"#F87171",background:"#2A1010"}:undefined}>{pastDeadline?"Deadline Passed":"Makeup Pending"}</span>}
                    {m.reopened_at && <span className="makeup-pending-badge">Reopened</span>}
                  </div>
                </button>
                {isManager && m.is_makeup_pending && !pastDeadline && (
                  <button className="btn-sm" onClick={()=>resumeMakeup(m)} disabled={resuming===m.id}>
                    {resuming===m.id ? "Loading…" : "Resume Makeup"}
                  </button>
                )}
                {isManager && m.is_makeup_pending && pastDeadline && (
                  <button className="btn-sm" style={{color:"#F87171",borderColor:"#7F1D1D"}} onClick={()=>setApplyingForfeit(m)}>
                    Apply Forfeit
                  </button>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}
    </>
  );
}

// ─── Manual Match Entry (manager only) ─────────────────────────────────────
// Records a match with the same fidelity as Live Entry -- full rack-by-rack
// detail per set (innings, safeties, timeouts where the format uses them),
// not just a final score -- for backfilling a paper scoresheet or any match
// that wasn't run through Live Entry. Deliberately reuses SetEntry (the
// exact component Live Entry itself uses for rack entry) rather than a
// second implementation, so win detection/targets/NR handling can never
// drift between the two paths. No coin-flip/draft turn order or dual-phone
// confirm step -- the manager enters both sides directly and saves once.
// Not tied to a schedule_pairing, so this doesn't trigger playoff bracket
// advancement (same as any other manually-entered record).
function emptyManualSets() {
  return Array(5).fill(null).map((_, i) => ({
    setNum: i + 1, playerHome: null, playerAway: null, racks: [], winnerSlot: null, complete: false,
    forfeited: false, forfeitedBy: null, forfeitPoints: null,
  }));
}

function ManualMatchEntry({ divisionId, teams, format, seasonLabelText, playoffsStartDate, onCancel, onDone }) {
  // Generated once, up front -- lets Track a Rack log shot events against a
  // stable id from the very first table entered, even though the actual
  // completed_matches row doesn't exist until "Save Match" at the end. That
  // same id is supplied explicitly as the row's id on save (Postgres
  // accepts a client-supplied uuid for a gen_random_uuid()-default column),
  // so everything logged along the way lines back up with the real match.
  const [matchId] = useState(() => crypto.randomUUID());
  const [homeTeamId, setHomeTeamId] = useState("");
  const [awayTeamId, setAwayTeamId] = useState("");
  const [homeRoster, setHomeRoster] = useState([]); // full roster, rated + unrated -- filtering happens at render
  const [awayRoster, setAwayRoster] = useState([]);
  const [venue, setVenue] = useState("");
  const [weekDate, setWeekDate] = useState("");
  const [weekNum, setWeekNum] = useState("");
  const [sets, setSets] = useState(emptyManualSets());
  const [activeSet, setActiveSet] = useState(0);
  const [pickingForfeit, setPickingForfeit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Fallback for a roster player who exists but has no rating on file yet
  // (needsRating -- distinct from NR/unrated-but-rated-0-2). Lets the
  // manager enter a rating on the spot rather than being blocked, with the
  // option to also save it as that player's current rating going forward
  // (same manual-entry path the Players & Ratings tab already uses), so
  // this doesn't leave a permanent gap for a player who's clearly playing.
  const [ratingEntry, setRatingEntry] = useState(null); // { side, player }
  const [ratingEntryVal, setRatingEntryVal] = useState("");
  const [saveRatingForward, setSaveRatingForward] = useState(true);
  const [savingRating, setSavingRating] = useState(false);

  const homeTeam = teams.find(t => t.id === homeTeamId);
  const awayTeam = teams.find(t => t.id === awayTeamId);
  const bothTeamsPicked = !!(homeTeamId && awayTeamId && homeTeamId !== awayTeamId);

  useEffect(() => {
    if (!homeTeamId) { setHomeRoster([]); return; }
    db.listRosterForTeam(homeTeamId).then(r => {
      setHomeRoster(r);
      setVenue(v => v || (homeTeam?.venue ?? ""));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeTeamId]);
  useEffect(() => {
    if (!awayTeamId) { setAwayRoster([]); return; }
    db.listRosterForTeam(awayTeamId).then(r => setAwayRoster(r));
  }, [awayTeamId]);

  useEffect(() => { setPickingForfeit(false); setRatingEntry(null); setRatingEntryVal(""); }, [activeSet]);

  const set = sets[activeSet];
  const used = new Set(sets.flatMap(s => [s.playerHome?.num, s.playerAway?.num]).filter(Boolean));
  const availableHomeUnused = homeRoster.filter(p => !used.has(p.num));
  const availableAwayUnused = awayRoster.filter(p => !used.has(p.num));
  const availableHomeRated = availableHomeUnused.filter(p => p.rating != null).slice().sort((a, b) => b.rating - a.rating);
  const availableAwayRated = availableAwayUnused.filter(p => p.rating != null).slice().sort((a, b) => b.rating - a.rating);
  const availableHomeUnrated = availableHomeUnused.filter(p => p.rating == null);
  const availableAwayUnrated = availableAwayUnused.filter(p => p.rating == null);
  const completedCount = sets.filter(s => s.complete).length;

  const updateSet = (idx, updated) => setSets(prev => prev.map((s, i) => (i === idx ? updated : s)));

  const assignPlayer = (side, player) => {
    updateSet(activeSet, {
      ...set, [side === "home" ? "playerHome" : "playerAway"]: { num: player.num, name: player.name, nickname: player.nickname, rating: player.rating },
      racks: [], winnerSlot: null, complete: false, forfeited: false, forfeitedBy: null, forfeitPoints: null,
    });
  };
  const changePlayers = () => {
    updateSet(activeSet, { ...set, playerHome: null, playerAway: null, racks: [], winnerSlot: null, complete: false, forfeited: false, forfeitedBy: null, forfeitPoints: null });
    setPickingForfeit(false);
  };
  const clearForfeit = () => {
    updateSet(activeSet, { ...set, complete: false, winnerSlot: null, forfeited: false, forfeitedBy: null, forfeitPoints: null, racks: [] });
  };
  const applyForfeit = (side) => {
    const forfeitingPlayer = side === "home" ? set.playerHome : set.playerAway;
    const receivingPlayer = side === "home" ? set.playerAway : set.playerHome;
    const receivingSlot = side === "home" ? "away" : "home";
    const points = db.computeForfeitPoints({ format, weekDate, playoffsStartDate }, receivingPlayer.rating);
    updateSet(activeSet, { ...set, racks: [], complete: true, winnerSlot: receivingSlot, forfeited: true, forfeitedBy: side, forfeitPoints: points });
    setPickingForfeit(false);
  };

  // Confirms an inline rating for a roster player who has none on file yet,
  // then assigns them to this table using that rating. Optionally also
  // writes it as a real weekly rating entry (same manual path the Players &
  // Ratings tab uses) so the gap doesn't just get papered over for this one
  // match -- future live/manual entries will see them as rated too.
  const confirmRatingEntry = async () => {
    const val = Number(ratingEntryVal);
    if (!val || val <= 0) { setError("Enter a valid rating."); return; }
    setError("");
    setSavingRating(true);
    if (saveRatingForward) {
      const label = weekDate ? `Manual entry · ${weekDate}` : `Manual entry · ${new Date().toLocaleDateString()}`;
      await db.setPlayerRating(ratingEntry.player.num, todayIsoKey(), label, val, "manual");
      // Reflect it locally too, so the roster list shows them as rated from
      // here on in this session without needing a re-fetch.
      const setter = ratingEntry.side === "home" ? setHomeRoster : setAwayRoster;
      setter(prev => prev.map(p => p.num === ratingEntry.player.num ? { ...p, rating: val } : p));
    }
    setSavingRating(false);
    assignPlayer(ratingEntry.side, { ...ratingEntry.player, rating: val });
    setRatingEntry(null); setRatingEntryVal("");
  };

  const save = async () => {
    setError("");
    if (!bothTeamsPicked) { setError("Pick both teams (they must be different)."); return; }
    if (completedCount === 0) { setError("Enter at least one completed table before saving."); return; }
    setSaving(true);
    const state = {
      matchId: `manual-${Date.now()}`,
      format, venue: venue || "",
      seasonLabel: seasonLabelText || null,
      divisionId, weekNum: weekNum ? Number(weekNum) : null, weekDate: weekDate || null,
      playoffsStartDate: playoffsStartDate || null,
      teamHome: { id: homeTeamId, name: homeTeam?.name ?? "", roster: [] },
      teamAway: { id: awayTeamId, name: awayTeam?.name ?? "", roster: [] },
      sets, coinFlipLoser: null, phase: "archived",
      confirmedHome: true, confirmedAway: true, disputedBy: null, disputeNote: null,
      makeup: null, schedulePairingId: null,
    };
    const homeTotal = sets.filter(s => s.winnerSlot === "home").length;
    const awayTotal = sets.filter(s => s.winnerSlot === "away").length;
    const { homePoints, awayPoints } = db.computeMatchPoints(state);
    const row = {
      id: matchId,
      division_id: divisionId, season_label: seasonLabelText || null,
      week_num: weekNum ? Number(weekNum) : null, week_date: weekDate || null,
      venue: venue || null, format,
      team_home_id: homeTeamId, team_away_id: awayTeamId,
      team_home_name: homeTeam?.name ?? "", team_away_name: awayTeam?.name ?? "",
      team_home_total: homeTotal, team_away_total: awayTotal,
      team_home_points: homePoints, team_away_points: awayPoints,
      state, is_makeup_pending: false,
    };
    const result = await db.saveManualMatch(row);
    setSaving(false);
    if (!result) { setError("Could not save this match. Please try again."); return; }
    onDone();
  };

  // Fallback list for roster players with no rating on file (distinct from
  // NR players, who ARE rated -- just 0-2 -- and already appear in the
  // rated list above with the normal NR handling live scoring already
  // does). Each row expands inline into a one-time rating entry rather than
  // blocking the manager from recording the table at all.
  const renderUnratedSection = (side, list) => {
    if (list.length === 0) return null;
    return (
      <div className="card" style={{ marginTop: 8 }}>
        <div className="card__title">{list.length} player{list.length !== 1 ? "s" : ""} on this roster {list.length !== 1 ? "need" : "needs"} a rating</div>
        <div className="draft-roster-list">
          {list.map(p => (
            <div key={p.num}>
              <button className="draft-roster-row" onClick={() => { setRatingEntry({ side, player: p }); setRatingEntryVal(""); setError(""); }}>
                <span className="draft-roster-row__name">{p.name}{p.nickname ? <span className="player-nickname"> "{p.nickname}"</span> : ""}</span>
                <span className="draft-roster-row__rating" style={{ color: "#F59E0B", background: "#2A2410" }}>No rating</span>
              </button>
              {ratingEntry?.side === side && ratingEntry.player.num === p.num && (
                <div className="card" style={{ margin: "6px 0" }}>
                  <div className="field"><Label>Rating for {p.name}</Label>
                    <input className="input" type="number" value={ratingEntryVal} onChange={e => setRatingEntryVal(e.target.value)} placeholder="Enter rating" autoFocus />
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#9A9A9A", margin: "8px 0" }}>
                    <input type="checkbox" checked={saveRatingForward} onChange={e => setSaveRatingForward(e.target.checked)} />
                    Also save this as {p.name}'s current rating going forward
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-primary" onClick={confirmRatingEntry} disabled={savingRating || !ratingEntryVal}>
                      {savingRating ? "Saving…" : "Confirm & Add to Table"}
                    </button>
                    <button className="btn-secondary" onClick={() => { setRatingEntry(null); setRatingEntryVal(""); }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <>
      <button className="btn-secondary" onClick={onCancel} style={{ marginBottom: 12 }}>← Cancel</button>

      <div className="card">
        <div className="card__title">Match Details</div>
        <div className="field"><Label>Home Team</Label>
          <select className="input input--select" value={homeTeamId} onChange={e => setHomeTeamId(e.target.value)}>
            <option value="">Select…</option>
            {teams.filter(t => !t.isBye).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="field"><Label>Away Team</Label>
          <select className="input input--select" value={awayTeamId} onChange={e => setAwayTeamId(e.target.value)}>
            <option value="">Select…</option>
            {teams.filter(t => !t.isBye && t.id !== homeTeamId).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="field"><Label>Venue</Label>
          <input className="input" value={venue} onChange={e => setVenue(e.target.value)} placeholder="Venue" />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div className="field" style={{ flex: 1 }}><Label>Week Date</Label>
            <input className="input" value={weekDate} onChange={e => setWeekDate(e.target.value)} placeholder="M/D/YYYY" />
          </div>
          <div className="field" style={{ flex: 1 }}><Label>Week #</Label>
            <input className="input" type="number" value={weekNum} onChange={e => setWeekNum(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <div style={{ fontSize: 10.5, color: "#6A6A6A" }}>
          Format: <strong style={{ color: "#E0E0E0" }}>{format}</strong> (from the active season) · Not tied to a scheduled pairing, so this won't trigger playoff bracket advancement.
        </div>
      </div>

      {bothTeamsPicked && (
        <>
          <div className="set-tabs">
            {sets.map((s, i) => (
              <button key={i} className={`set-tab ${i === activeSet ? "set-tab--active" : ""} ${s.complete ? "set-tab--done" : ""}`}
                onClick={() => setActiveSet(i)}>
                {s.complete ? <Check size={10} /> : i + 1}
              </button>
            ))}
          </div>

          {(!set.playerHome || !set.playerAway) && (
            <div className="draft-step">
              {!set.playerHome ? (
                <>
                  <div className="draft-step__banner draft-step__banner--home">{homeTeam?.name} — who played Table {activeSet + 1}?</div>
                  <div className="draft-roster-list">
                    {availableHomeRated.length === 0 && availableHomeUnrated.length === 0 && <div className="empty-state">No available players left on this roster.</div>}
                    {availableHomeRated.map(p => (
                      <button key={p.num} className="draft-roster-row" onClick={() => assignPlayer("home", p)}>
                        <span className="draft-roster-row__name">{p.name}{p.nickname ? <span className="player-nickname"> "{p.nickname}"</span> : ""}</span>
                        <span className="draft-roster-row__rating">{p.rating}</span>
                      </button>
                    ))}
                  </div>
                  {renderUnratedSection("home", availableHomeUnrated)}
                </>
              ) : (
                <>
                  <div className="draft-step__banner draft-step__banner--away">{awayTeam?.name} — who played Table {activeSet + 1}?</div>
                  <div className="draft-roster-list">
                    {availableAwayRated.length === 0 && availableAwayUnrated.length === 0 && <div className="empty-state">No available players left on this roster.</div>}
                    {availableAwayRated.map(p => (
                      <button key={p.num} className="draft-roster-row" onClick={() => assignPlayer("away", p)}>
                        <span className="draft-roster-row__name">{p.name}{p.nickname ? <span className="player-nickname"> "{p.nickname}"</span> : ""}</span>
                        <span className="draft-roster-row__rating">{p.rating}</span>
                      </button>
                    ))}
                  </div>
                  {renderUnratedSection("away", availableAwayUnrated)}
                </>
              )}
            </div>
          )}

          {set.playerHome && set.playerAway && (
            <>
              <div className="card" style={{ textAlign: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#5FCF9E", marginBottom: 6 }}>Table {activeSet + 1} matchup</div>
                <div className="draft-matchup-display">
                  <span className="draft-matchup-display__home">{set.playerHome.name}</span>
                  <span className="draft-matchup-display__vs">vs</span>
                  <span className="draft-matchup-display__away">{set.playerAway.name}</span>
                </div>
                <button className="btn-sm" style={{ marginTop: 8 }} onClick={changePlayers}>Change Players</button>
              </div>

              <div className="seg-control">
                <button className={`seg-btn ${!set.forfeited ? "seg-btn--active" : ""}`}
                  onClick={() => { if (set.forfeited) clearForfeit(); setPickingForfeit(false); }}>
                  Racks Played
                </button>
                <button className={`seg-btn ${set.forfeited ? "seg-btn--active" : ""}`} onClick={() => setPickingForfeit(true)}>
                  Forfeit
                </button>
              </div>

              {set.forfeited ? (
                <div className="card" style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 12, color: "#9A9A9A", marginBottom: 4 }}>
                    {set.forfeitedBy === "home" ? set.playerHome.name : set.playerAway.name} forfeited — {set.forfeitedBy === "home" ? set.playerAway.name : set.playerHome.name} credited
                  </div>
                  <div style={{ fontSize: 22, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, color: "#5FCF9E" }}>{set.forfeitPoints} pts</div>
                </div>
              ) : pickingForfeit ? (
                <div className="card">
                  <div className="card__title">Which player forfeited?</div>
                  <div className="coinflip-choices">
                    <button className="coinflip-btn coinflip-btn--home" onClick={() => applyForfeit("home")}>{set.playerHome.name}</button>
                    <button className="coinflip-btn coinflip-btn--away" onClick={() => applyForfeit("away")}>{set.playerAway.name}</button>
                  </div>
                  <button className="btn-sm" style={{ marginTop: 8 }} onClick={() => setPickingForfeit(false)}>Cancel</button>
                </div>
              ) : (
                <SetEntry set={set} match={{ format, divisionId, teamHome: { id: homeTeamId }, teamAway: { id: awayTeamId } }}
                  contextType="manual_match" contextId={matchId}
                  onUpdateSet={(updated) => updateSet(activeSet, updated)} />
              )}
            </>
          )}

          <div style={{ fontSize: 11, color: "#9A9A9A", textAlign: "center" }}>{completedCount} of 5 tables entered</div>
        </>
      )}

      {error && <ErrorMsg>{error}</ErrorMsg>}
      <button className="btn-primary" onClick={save} disabled={saving || completedCount === 0}>
        {saving ? "Saving…" : `Save Match${completedCount ? ` (${completedCount} table${completedCount !== 1 ? "s" : ""})` : ""}`}
      </button>
    </>
  );
}

// Lets whoever reopened the match pick which of the 5 sets actually needs
// fixing, so only that one gets touched -- the other 4 stay exactly as
// they were scored.
function SetPicker({ match, onPick, onCancel }) {
  const sets = match.state?.sets ?? [];
  return (
    <div className="card">
      <div className="card__title">Which set needs a correction?</div>
      <div style={{fontSize:12.5,color:"#9A9A9A",marginBottom:10}}>{match.team_home_name} vs {match.team_away_name}</div>
      <div className="list">
        {sets.map(s => {
          const homeName = s.playerHome?.name ?? "—";
          const awayName = s.playerAway?.name ?? "—";
          const runHome = (s.racks ?? []).reduce((t,r)=>t+(r.home??0),0);
          const runAway = (s.racks ?? []).reduce((t,r)=>t+(r.away??0),0);
          const winnerName = s.winnerSlot==="home" ? homeName : s.winnerSlot==="away" ? awayName : null;
          const summary = s.forfeited ? `Forfeit — ${winnerName ?? "?"} awarded the set` : winnerName ? `${winnerName} won · ${runHome}–${runAway}` : "Not recorded";
          return (
            <div key={s.setNum} className="list-row" style={{cursor:"pointer"}} onClick={()=>onPick(s)}>
              <div className="list-row__body">
                <div style={{flex:1}}>
                  <div className="list-row__name">Set {s.setNum}: {homeName} vs {awayName}</div>
                  <div className="list-row__sub">{summary}</div>
                </div>
                <ChevronRight size={14} color="#9A9A9A"/>
              </div>
            </div>
          );
        })}
      </div>
      <button className="btn-secondary" onClick={onCancel} style={{marginTop:10}}>Cancel — Don't Reopen</button>
    </div>
  );
}

// The actual correction form for one set -- pre-filled with exactly what
// was tracked (winner, every rack's score), editable in place. A manager
// saves immediately; a captain submits it for the OTHER captain to confirm
// (see RespondToCorrection below), keeping the same both-sides-agree
// guarantee the original score required.
function SetCorrectionForm({ match, set, isManager, myProfile, onCancel, onDone }) {
  const [isForfeit, setIsForfeit] = useState(!!set.forfeited);
  const [winnerSlot, setWinnerSlot] = useState(set.winnerSlot ?? "home");
  const [forfeitedBy, setForfeitedBy] = useState(set.forfeitedBy ?? "away");
  const [forfeitPoints, setForfeitPoints] = useState(set.forfeitPoints ?? 0);
  const [racks, setRacks] = useState((set.racks?.length ? set.racks : [{home:0,away:0}]).map(r => ({ home: r.home ?? 0, away: r.away ?? 0 })));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const homeName = set.playerHome?.name ?? "Home";
  const awayName = set.playerAway?.name ?? "Away";
  const runHome = racks.reduce((t,r)=>t+(Number(r.home)||0),0);
  const runAway = racks.reduce((t,r)=>t+(Number(r.away)||0),0);

  const updateRack = (i, side, val) => setRacks(rs => rs.map((r,idx)=> idx===i ? {...r,[side]:val} : r));
  const addRack = () => setRacks(rs => [...rs, {home:0, away:0}]);
  const removeRack = (i) => setRacks(rs => rs.length>1 ? rs.filter((_,idx)=>idx!==i) : rs);

  const save = async () => {
    setSaving(true); setErr("");
    const updatedSet = isForfeit
      ? { ...set, forfeited: true, forfeitedBy, forfeitPoints: Number(forfeitPoints)||0, winnerSlot: forfeitedBy==="home"?"away":"home", complete: true }
      : { ...set, forfeited: false, forfeitedBy: null, forfeitPoints: null,
          racks: racks.map(r => ({ home: Number(r.home)||0, away: Number(r.away)||0 })), winnerSlot, complete: true };
    let ok;
    if (isManager) {
      ok = await db.applySetCorrectionDirect(match.id, updatedSet, "");
    } else {
      const mySlot = myProfile.team_id === match.team_home_id ? "home" : "away";
      ok = await db.proposeSetCorrection(match.id, updatedSet, myProfile.id, mySlot);
    }
    setSaving(false);
    if (!ok) { setErr("Could not save."); return; }
    onDone();
  };

  return (
    <div className="card">
      <div className="card__title">Set {set.setNum}: {homeName} vs {awayName}</div>
      <div className="seg-control" style={{marginBottom:4}}>
        <button className={`seg-btn ${!isForfeit?"seg-btn--active":""}`} onClick={()=>setIsForfeit(false)}>Racks Played</button>
        <button className={`seg-btn ${isForfeit?"seg-btn--active":""}`} onClick={()=>setIsForfeit(true)}>Forfeit</button>
      </div>

      {!isForfeit ? (
        <>
          <div className="field"><Label>Winner</Label>
            <div className="seg-control">
              <button className={`seg-btn ${winnerSlot==="home"?"seg-btn--active":""}`} onClick={()=>setWinnerSlot("home")}>{homeName}</button>
              <button className={`seg-btn ${winnerSlot==="away"?"seg-btn--active":""}`} onClick={()=>setWinnerSlot("away")}>{awayName}</button>
            </div>
          </div>
          <div className="field">
            <Label>Racks ({runHome}–{runAway} total)</Label>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              <div style={{display:"flex",gap:6,fontSize:10.5,color:"#6A6A6A",padding:"0 4px"}}>
                <span style={{width:36}}>Rack</span><span style={{flex:1}}>{homeName}</span><span style={{flex:1}}>{awayName}</span>
              </div>
              {racks.map((r,i) => (
                <div key={i} style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{width:36,fontSize:11,color:"#9A9A9A"}}>#{i+1}</span>
                  <input className="edit-input" style={{flex:1}} type="number" value={r.home} onChange={e=>updateRack(i,"home",e.target.value)}/>
                  <input className="edit-input" style={{flex:1}} type="number" value={r.away} onChange={e=>updateRack(i,"away",e.target.value)}/>
                  <button className="btn-icon btn-icon--danger" onClick={()=>removeRack(i)}><Trash2 size={12}/></button>
                </div>
              ))}
              <button className="btn-icon" style={{alignSelf:"flex-start"}} onClick={addRack}><Plus size={12}/></button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="field"><Label>Which side forfeited?</Label>
            <div className="seg-control">
              <button className={`seg-btn ${forfeitedBy==="home"?"seg-btn--active":""}`} onClick={()=>setForfeitedBy("home")}>{homeName}</button>
              <button className={`seg-btn ${forfeitedBy==="away"?"seg-btn--active":""}`} onClick={()=>setForfeitedBy("away")}>{awayName}</button>
            </div>
          </div>
          <div className="field"><Label>Forfeit Points (to the other side)</Label>
            <input className="input" type="number" value={forfeitPoints} onChange={e=>setForfeitPoints(e.target.value)}/>
          </div>
        </>
      )}

      {err && <ErrorMsg>{err}</ErrorMsg>}
      <div style={{display:"flex",gap:8}}>
        <button className="btn-primary" onClick={save} disabled={saving} style={{flex:1}}>
          {saving ? "Saving…" : isManager ? "Save Correction" : "Submit for Other Captain to Confirm"}
        </button>
        <button className="btn-secondary" onClick={onCancel}>Back</button>
      </div>
    </div>
  );
}

// The OTHER captain's (or a manager's) review of a proposed set correction --
// shows what changes, nothing is applied until this is confirmed.
function RespondToCorrection({ match, onDone }) {
  const pc = match.pending_correction;
  const [saving, setSaving] = useState(false);
  const set = (match.state?.sets ?? []).find(s => s.setNum === pc.setNum);
  const homeName = set?.playerHome?.name ?? "Home";
  const awayName = set?.playerAway?.name ?? "Away";
  const oldRunHome = (set?.racks ?? []).reduce((t,r)=>t+(r.home??0),0);
  const oldRunAway = (set?.racks ?? []).reduce((t,r)=>t+(r.away??0),0);
  const newRacks = pc.updatedSet.racks ?? [];
  const newRunHome = newRacks.reduce((t,r)=>t+(r.home??0),0);
  const newRunAway = newRacks.reduce((t,r)=>t+(r.away??0),0);
  const oldWinner = set?.forfeited ? "Forfeit" : set?.winnerSlot==="home" ? homeName : set?.winnerSlot==="away" ? awayName : "—";
  const newWinner = pc.updatedSet.forfeited ? "Forfeit" : pc.updatedSet.winnerSlot==="home" ? homeName : awayName;

  const respond = async (accept) => {
    setSaving(true);
    await db.respondToSetCorrection(match.id, accept);
    setSaving(false);
    onDone();
  };

  return (
    <div className="card">
      <div className="card__title">Correction Proposed — Set {pc.setNum}</div>
      <div style={{fontSize:12.5,color:"#9A9A9A",marginBottom:12}}>{homeName} vs {awayName}</div>
      <div style={{display:"flex",gap:20,marginBottom:12}}>
        <div>
          <div style={{fontSize:10.5,color:"#6A6A6A",marginBottom:2}}>Currently recorded</div>
          <div style={{fontSize:15,fontWeight:700,color:"#E0E0E0"}}>{set?.forfeited ? "Forfeit" : `${oldRunHome}–${oldRunAway}`}</div>
          <div style={{fontSize:11,color:"#9A9A9A"}}>Winner: {oldWinner}</div>
        </div>
        <div>
          <div style={{fontSize:10.5,color:"#6A6A6A",marginBottom:2}}>Proposed</div>
          <div style={{fontSize:15,fontWeight:700,color:"#5FCF9E"}}>{pc.updatedSet.forfeited ? "Forfeit" : `${newRunHome}–${newRunAway}`}</div>
          <div style={{fontSize:11,color:"#9A9A9A"}}>Winner: {newWinner}</div>
        </div>
      </div>
      <div style={{display:"flex",gap:8}}>
        <button className="btn-primary" onClick={()=>respond(true)} disabled={saving} style={{flex:1}}>Confirm Correction</button>
        <button className="btn-secondary" onClick={()=>respond(false)} disabled={saving}>Reject</button>
      </div>
    </div>
  );
}

// ─── Standings / MVP seed import (manager-only) ────────────────────────────────
function SeedStandingsImport({ divisionId, teams, onImported, existingCount }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState([]);
  const [parseErr, setParseErr] = useState("");
  const [saved, setSaved] = useState(false);
  const [weekDate, setWeekDate] = useState(todayIsoKey());

  const handleParse = () => { const r = parseStandingsImport(raw); if (!r.length) { setParseErr("No valid rows."); return; } setParseErr(""); setParsed(r); };
  const handleImport = async () => {
    const weekTag = { weekKey: weekDate, label: `As of ${new Date(weekDate+"T00:00:00").toLocaleDateString()}` };
    await db.importStandingsForWeek(divisionId, parsed, teams, weekTag);
    setOpen(false); setRaw(""); setParsed([]); setSaved(true); setTimeout(()=>setSaved(false),1800);
    onImported();
  };

  if (!open) {
    return (
      <button className="btn-sm" onClick={()=>setOpen(true)}>
        <Plus size={12}/> {existingCount>0 ? `Edit imported standings (${existingCount})` : "Import Team Standings"}
      </button>
    );
  }
  return (
    <PasteImporter label="Import team standings" hint="Team# ⇥ Team Name ⇥ Points Last Wk ⇥ Total Points ⇥ Sets Played — paste straight from the Division Standings report"
      raw={raw} setRaw={setRaw} onParse={handleParse} parseErr={parseErr}
      onClear={()=>{setRaw("");setParsed([]);setParseErr("");}}
      preHint={
        <div className="field" style={{marginBottom:8}}>
          <Label>Standings as of</Label>
          <input className="input" type="date" value={weekDate} onChange={e=>setWeekDate(e.target.value)} />
          <div style={{fontSize:10.5,color:"#6A6A6A",marginTop:4}}>Each week's import is kept — re-importing the same date updates that week, a new date adds a new week's snapshot.</div>
        </div>
      }
      preview={parsed.length>0 && <PreviewList rows={parsed.map(r=>({id:r.teamNum, name:r.teamName, sub:`${r.totalPoints} pts · ${r.setsPlayed} sets`}))}/>}
      onImport={parsed.length?handleImport:null} importLabel={`Import ${parsed.length} teams for this week`} saved={saved}/>
  );
}

function SeedMvpImport({ divisionId, onImported, existingCount }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState([]);
  const [parseErr, setParseErr] = useState("");
  const [saved, setSaved] = useState(false);
  const [weekDate, setWeekDate] = useState(todayIsoKey());

  const handleParse = () => { const r = parseMvpImport(raw); if (!r.length) { setParseErr("No valid rows."); return; } setParseErr(""); setParsed(r); };
  const handleImport = async () => {
    const weekTag = { weekKey: weekDate, label: `As of ${new Date(weekDate+"T00:00:00").toLocaleDateString()}` };
    await db.importMvpForWeek(divisionId, parsed, weekTag);
    setOpen(false); setRaw(""); setParsed([]); setSaved(true); setTimeout(()=>setSaved(false),1800);
    onImported();
  };

  if (!open) {
    return (
      <button className="btn-sm" onClick={()=>setOpen(true)}>
        <Plus size={12}/> {existingCount>0 ? `Edit imported MVP stats (${existingCount})` : "Import MVP Standings"}
      </button>
    );
  }
  return (
    <PasteImporter label="Import MVP Standings" hint="Plyr# ⇥ Player Name ⇥ Team# ⇥ Sets Won ⇥ Sets Lost ⇥ Points Scored ⇥ Total MVP Ranking Points — paste straight from the MVP Standings report"
      raw={raw} setRaw={setRaw} onParse={handleParse} parseErr={parseErr}
      onClear={()=>{setRaw("");setParsed([]);setParseErr("");}}
      preHint={
        <div className="field" style={{marginBottom:8}}>
          <Label>MVP stats as of</Label>
          <input className="input" type="date" value={weekDate} onChange={e=>setWeekDate(e.target.value)} />
          <div style={{fontSize:10.5,color:"#6A6A6A",marginTop:4}}>Each week's import is kept — re-importing the same date updates that week, a new date adds a new week's snapshot.</div>
        </div>
      }
      preview={parsed.length>0 && <PreviewList rows={parsed.map(r=>({id:r.playerNum, name:r.playerName, sub:`${r.wins}W–${r.losses}L · ${r.pointsScored} pts scored · ${r.mvpRankingPoints} ranking pts`}))}/>}
      onImport={parsed.length?handleImport:null} importLabel={`Import ${parsed.length} players for this week`} saved={saved}/>
  );
}

// Playoff eligibility only gets pasted during playoff weeks -- see
// parsePlayoffEligibility() for the report parser. The "as of" date is a
// manual date picker (like Standings/MVP) rather than auto-extracted from
// the report's own "Ratings current as of: MM/DD/YY" line, since that's a
// 2-digit year in a different shape than the 4-digit dates used everywhere
// else in the app -- safer to let the manager confirm it than to guess.
function SeedPlayoffEligibilityImport({ divisionId, onImported, existingCount }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState(null); // { weekLabel, rows }
  const [parseErr, setParseErr] = useState("");
  const [saved, setSaved] = useState(false);
  const [unmatchedCount, setUnmatchedCount] = useState(0);
  const [asOfDate, setAsOfDate] = useState(todayIsoKey());

  const handleParse = () => {
    const result = parsePlayoffEligibility(raw);
    if (!result.rows.length) {
      setParseErr("No valid rows found. Make sure this is the \"Division Playoffs - Roster and Handicap Report\" (has an Elig column), not the regular weekly ratings report.");
      return;
    }
    setParseErr(""); setParsed(result);
  };
  const handleImport = async () => {
    const weekTag = {
      weekKey: asOfDate,
      label: `${parsed.weekLabel} · As of ${new Date(asOfDate + "T00:00:00").toLocaleDateString()}`,
    };
    const result = await db.importPlayoffEligibilityForWeek(divisionId, parsed.rows, weekTag);
    setOpen(false); setRaw(""); setParsed(null); setSaved(true); setUnmatchedCount(result?.unmatchedCount ?? 0);
    setTimeout(() => setSaved(false), 1800);
    onImported();
  };

  if (!open) {
    return (
      <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-start"}}>
        <button className="btn-sm" onClick={()=>setOpen(true)}>
          <Plus size={12}/> {existingCount>0 ? `Edit imported eligibility (${existingCount})` : "Import Playoff Eligibility"}
        </button>
        {unmatchedCount > 0 && (
          <div style={{fontSize:10.5,color:"#F59E0B"}}>{unmatchedCount} player number{unmatchedCount!==1?"s":""} from the last import didn't match a known player and won't gate anyone's draft eligibility.</div>
        )}
      </div>
    );
  }
  return (
    <PasteImporter label="Import Playoff Eligibility" hint="Paste the &quot;Division Playoffs - Roster and Handicap Report&quot; — only issued during playoff weeks"
      raw={raw} setRaw={setRaw} onParse={handleParse} parseErr={parseErr}
      onClear={()=>{setRaw("");setParsed(null);setParseErr("");}}
      preHint={
        <div className="field" style={{marginBottom:8}}>
          <Label>Eligibility as of</Label>
          <input className="input" type="date" value={asOfDate} onChange={e=>setAsOfDate(e.target.value)} />
          <div style={{fontSize:10.5,color:"#6A6A6A",marginTop:4}}>Matches the report's own "Ratings current as of" date. Each import is kept as a dated snapshot, same as ratings/standings/MVP.</div>
        </div>
      }
      preview={parsed && (
        <>
          <div style={{fontSize:11,fontWeight:700,color:"#5FCF9E",marginBottom:6}}>{parsed.weekLabel} · {parsed.rows.length} players</div>
          <PreviewList rows={parsed.rows.map(r=>({id:r.eligCode, name:`${r.name}${r.nickname?` "${r.nickname}"`:""}`, sub:`Team ${r.teamNum} · ${r.teamName}`}))}/>
        </>
      )}
      onImport={parsed?.rows?.length ? handleImport : null} importLabel={parsed ? `Import ${parsed.rows.length} players` : ""} saved={saved}/>
  );
}


// ─── Weekly import panel (standings / mvp) for Update Weekly League Data ──────
function WeeklyImportPanel({ divisionId, teams, mode }) {
  const [standingsAdj, setStandingsAdj] = useState([]);
  const [mvpAdj, setMvpAdj] = useState([]);
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    Promise.all([
      db.listCompletedMatches(divisionId),
      db.listStandingsAdjustments(divisionId),
      db.listMvpAdjustments(divisionId),
    ]).then(([m, sa, ma]) => { setMatches(m); setStandingsAdj(sa); setMvpAdj(ma); setLoading(false); });
  };
  useEffect(refresh, [divisionId]);

  if (loading) return <Loader/>;

  if (mode === "standings") {
    const standings = db.computeStandings(matches, standingsAdj);
    return (
      <>
        <div className="list">
          {standings.length===0 && <div className="empty-state" style={{border:"none"}}>No standings yet.</div>}
          {standings.map((t, i) => (
            <div key={t.teamId} className="list-row">
              <div className="list-row__body">
                <span className="list-row__id">{i+1}</span>
                <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                  <span className="list-row__name">{t.name}</span>
                  <span className="list-row__sub">{t.wins}-{t.losses} · {t.setsFor}–{t.setsAgainst} sets</span>
                </div>
                <span className="player-rating-badge">{t.totalPoints} pts</span>
              </div>
            </div>
          ))}
        </div>
        <SeedStandingsImport divisionId={divisionId} teams={teams} onImported={refresh} existingCount={standingsAdj.length} />
      </>
    );
  }

  const mvp = db.computeMvp(matches, mvpAdj);
  return (
    <>
      <div className="list">
        {mvp.length===0 && <div className="empty-state" style={{border:"none"}}>No MVP stats yet.</div>}
        {mvp.map((p, i) => (
          <div key={p.num} className="list-row">
            <div className="list-row__body">
              <span className="list-row__id">{i+1}</span>
              <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                <span className="list-row__name">{p.name}</span>
                <span className="list-row__sub">{p.wins}W–{p.losses}L · {p.pointsScored} pts scored</span>
              </div>
              <span className="player-rating-badge">{p.mvpRanking}</span>
            </div>
          </div>
        ))}
      </div>
      <SeedMvpImport divisionId={divisionId} onImported={refresh} existingCount={mvpAdj.length} />
    </>
  );
}

// ─── Account Settings ─────────────────────────────────────────────────────────
function AccountSettings({ profile, onProfileRefresh }) {
  const [username, setUsername] = useState(profile.username);
  const [phone, setPhone]       = useState(profile.phone_number ?? "");
  const [playerNum, setPlayerNum] = useState(profile.player_num ?? "");
  const [savingPlayerNum, setSavingPlayerNum] = useState(false);
  const [newPassword, setNewPassword]   = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [showPw2, setShowPw2] = useState(false);
  const [error, setError]     = useState("");
  const [success, setSuccess] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [claiming, setClaiming]   = useState(false);

  // Manager-only: self-assignment to a team they personally play on,
  // separate from admin scope (role alone governs that). allTeamsForManager
  // is the FULL unfiltered list (any season, active or not) so a manager's
  // already-set team still displays correctly and can be flagged if its
  // season has since gone inactive -- the picker itself (pickableTeams)
  // only offers active-season teams to pick NEW, matching the captain-
  // assignment picker's convention.
  const [allTeamsForManager, setAllTeamsForManager] = useState(null);
  const [teamInput, setTeamInput] = useState("");
  const [savingTeam, setSavingTeam] = useState(false);

  useEffect(() => {
    if (profile.role === "manager") db.listAllTeamsWithContext().then(setAllTeamsForManager);
  }, [profile.role]);

  const currentTeam = (profile.team_id && allTeamsForManager)
    ? allTeamsForManager.find(t => t.id === profile.team_id) ?? null
    : null;
  const currentTeamInactive = !!(currentTeam && !currentTeam.isActiveSeason);
  const pickableTeams = (allTeamsForManager ?? [])
    .filter(t => !t.isBye && t.isActiveSeason)
    .sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    setTeamInput(currentTeam ? `${currentTeam.name}${currentTeam.context ? ` — ${currentTeam.context}` : ""}` : "");
  }, [profile.team_id, allTeamsForManager]);

  const saveOwnTeam = async (teamId) => {
    setSavingTeam(true);
    const result = await db.addOwnTeamMembership(teamId);
    setSavingTeam(false);
    if (!result.ok) { setError("Could not update your team."); return; }
    setError(""); setSuccess(teamId ? "Team updated." : "Team cleared."); setTimeout(() => setSuccess(""), 2500);
    if (onProfileRefresh) await onProfileRefresh();
  };

  const saveUsername = async () => {
    if (!username.trim()) { setError("Username required."); return; }
    if (username.trim() !== profile.username && await db.isUsernameTaken(username.trim())) { setError("Username taken."); return; }
    const ok = await db.updateOwnUsername(profile.id, username.trim());
    if (!ok) { setError("Could not update username."); return; }
    setError(""); setSuccess("Username updated."); setTimeout(()=>setSuccess(""),2500);
  };
  const savePhone = async () => {
    if (phone.trim() && phone.replace(/\D/g,"").length < 10) { setError("Enter a valid phone number."); return; }
    const ok = await db.updateOwnPhone(profile.id, phone.trim());
    if (!ok) { setError("Could not update phone number."); return; }
    setError(""); setSuccess("Phone number updated."); setTimeout(()=>setSuccess(""),2500);
    if (onProfileRefresh) await onProfileRefresh();
  };
  const savePlayerNum = async () => {
    setSavingPlayerNum(true);
    const result = await db.setOwnPlayerNumber(playerNum.trim());
    setSavingPlayerNum(false);
    if (!result.ok) {
      setError(result.reason === "not_found" ? "We don't recognize that player number yet."
        : result.reason === "already_claimed" ? "That player number is already linked to another account."
        : "Could not update player number.");
      return;
    }
    setError(""); setSuccess("Player number updated."); setTimeout(()=>setSuccess(""),2500);
    if (onProfileRefresh) await onProfileRefresh();
  };
  const savePassword = async () => {
    if (newPassword.length < 6) { setError("New password must be 6+ characters."); return; }
    if (newPassword !== newPassword2) { setError("Passwords don't match."); return; }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) { setError(error.message); return; }
    setNewPassword(""); setNewPassword2("");
    setError(""); setSuccess("Password updated."); setTimeout(()=>setSuccess(""),2500);
  };
  const redeemCode = async () => {
    if (!claimCode.trim()) return;
    setClaiming(true);
    const result = await db.claimInviteCode(claimCode.trim());
    setClaiming(false);
    if (result.error) { setError(result.error); return; }
    setClaimCode("");
    setError(""); setSuccess(`Access updated — you're now ${ROLES[result.role]?.label ?? result.role}.`); setTimeout(()=>setSuccess(""),3500);
    if (onProfileRefresh) await onProfileRefresh();
  };

  return (
    <>
      <div className="settings-who"><RolePill role={profile.role}/><span className="settings-username">@{profile.username}</span></div>
      <div className="card">
        <div className="card__title">Username</div>
        <div className="field"><input className="input" value={username} onChange={e=>setUsername(e.target.value)} autoCapitalize="none"/></div>
        <button className="btn-secondary" onClick={saveUsername} disabled={username.trim()===profile.username||!username.trim()}>Save Username</button>
      </div>
      <div className="card">
        <div className="card__title">Phone Number</div>
        <div className="field"><input className="input" type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="(555) 555-5555"/></div>
        <button className="btn-secondary" onClick={savePhone} disabled={phone.trim()===(profile.phone_number ?? "")}>Save Phone Number</button>
      </div>
      <div className="card">
        <div className="card__title">Player Number</div>
        <div style={{fontSize:10.5,color:"#6A6A6A",marginBottom:6}}>Links your account to your league stats & history.</div>
        <div className="field"><input className="input" value={playerNum} onChange={e=>setPlayerNum(e.target.value)} placeholder="If you already play in the league"/></div>
        <button className="btn-secondary" onClick={savePlayerNum} disabled={savingPlayerNum||playerNum.trim()===(profile.player_num ?? "")}>{savingPlayerNum?"Saving…":"Save Player Number"}</button>
      </div>
      {profile.role === "manager" && (
        <div className="card">
          <div className="card__title">My Team (if you also play)</div>
          <div style={{fontSize:10.5,color:"#6A6A6A",marginBottom:6}}>
            Managers aren't scoped to a team for admin purposes, but if you also play in the league, set your team here for your Home dashboard, My Stats, and Live Entry.
          </div>
          {currentTeamInactive && (
            <div className="readonly-bar" style={{marginBottom:8}}>
              Your team's season is no longer active — it still works everywhere in the app, but won't appear in the picker below unless its season is reactivated. Clear it or pick a new active-season team if you'd like to change it.
            </div>
          )}
          <div className="field">
            <input className="input" list="manager-team-options" value={teamInput} autoComplete="off"
              placeholder="Start typing a team name…"
              onChange={e=>{
                const val = e.target.value; setTeamInput(val);
                const match = pickableTeams.find(t => `${t.name}${t.context ? ` — ${t.context}` : ""}` === val);
                if (match) saveOwnTeam(match.id);
              }}/>
            <datalist id="manager-team-options">
              {pickableTeams.map(t=><option key={t.id} value={`${t.name}${t.context ? ` — ${t.context}` : ""}`} />)}
            </datalist>
          </div>
          {profile.team_id && (
            <button className="btn-secondary" onClick={()=>saveOwnTeam(null)} disabled={savingTeam}>Clear My Team</button>
          )}
        </div>
      )}
      <div className="card">
        <div className="card__title">Change Password</div>
        <div className="field"><Label>New Password</Label>
          <div className="input-wrap">
            <input className="input" type={showPw?"text":"password"} value={newPassword} onChange={e=>setNewPassword(e.target.value)} placeholder="New password (6+)"/>
            <button className="input-eye" onClick={()=>setShowPw(v=>!v)}>{showPw?<EyeOff size={14}/>:<Eye size={14}/>}</button>
          </div>
        </div>
        <div className="field"><Label>Confirm New Password</Label>
          <div className="input-wrap">
            <input className="input" type={showPw2?"text":"password"} value={newPassword2} onChange={e=>setNewPassword2(e.target.value)} placeholder="Repeat new password"/>
            <button className="input-eye" onClick={()=>setShowPw2(v=>!v)}>{showPw2?<EyeOff size={14}/>:<Eye size={14}/>}</button>
          </div>
        </div>
        <button className="btn-secondary" onClick={savePassword} disabled={!newPassword||!newPassword2}>Update Password</button>
      </div>
      <div className="card">
        <div className="card__title">Redeem Invite Code</div>
        <div style={{fontSize:11.5,color:"#9A9A9A",lineHeight:1.5}}>
          Signed in with Google? Your account starts as a Player. Enter a code from your league manager to get the right access.
        </div>
        <div className="field"><input className="input input--code" value={claimCode} onChange={e=>setClaimCode(e.target.value)} placeholder="XXXXXX" autoCapitalize="characters"/></div>
        <button className="btn-secondary" onClick={redeemCode} disabled={!claimCode.trim()||claiming}>{claiming?"Checking…":"Redeem Code"}</button>
      </div>
      {error   && <ErrorMsg>{error}</ErrorMsg>}
      {success && <div className="success-msg"><Check size={12}/> {success}</div>}
    </>
  );
}

// ─── Manage My Team (captain) ──────────────────────────────────────────────────
function ManageMyTeamPage({ teamId, profileId }) {
  const [team, setTeam] = useState(null);
  const [roster, setRoster] = useState([]);
  const [pastTeams, setPastTeams] = useState([]);
  const [pastRoster, setPastRoster] = useState(null); // {teamName, players} for the most recent past team
  const [loading, setLoading] = useState(true);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [addMode, setAddMode] = useState(null); // null | "new" | "search" | "past"
  const [codeGenFor, setCodeGenFor] = useState(null);
  const [codeGenEmail, setCodeGenEmail] = useState("");
  const [codeGenSaving, setCodeGenSaving] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState({}); // { [playerNum]: code }
  const [newName, setNewName] = useState("");
  const [newNickname, setNewNickname] = useState("");
  const [adding, setAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const refresh = async () => {
    if (!teamId) { setLoading(false); return; }
    setLoading(true);
    const [teams, players, past] = await Promise.all([db.listAllTeamsWithContext(), db.listRosterForTeam(teamId), db.listPastCaptainedTeams(profileId)]);
    const t = teams.find(x => x.id === teamId);
    setTeam(t ?? null);
    setNameInput(t?.name ?? "");
    setRoster(players);
    setPastTeams(past);
    setLoading(false);
  };
  useEffect(() => { refresh(); }, [teamId]);

  const flash = (msg) => { setSuccess(msg); setTimeout(()=>setSuccess(""),2500); };
  const onRosterNums = new Set(roster.map(p => p.num));

  const saveName = async () => {
    if (!nameInput.trim() || nameInput.trim() === team?.name) return;
    setSavingName(true);
    const ok = await db.renameTeam(teamId, nameInput.trim());
    setSavingName(false);
    if (!ok) { setError("Could not update team name."); return; }
    setError(""); flash("Team name updated."); await refresh();
  };

  const addNewPlayer = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    const result = await db.addPlayerToTeam(teamId, { name: newName.trim(), nickname: newNickname.trim() });
    setAdding(false);
    if (!result) { setError("Could not add player."); return; }
    setError(""); setNewName(""); setNewNickname(""); setAddMode(null);
    flash("Player added — needs a rating from the manager."); await refresh();
  };

  const addExisting = async (playerNum, label) => {
    setError("");
    const ok = await db.addExistingPlayerToRoster(teamId, playerNum);
    if (!ok) { setError("Could not add player — they may already be on this roster."); return; }
    flash(`${label} added.`); await refresh();
  };

  const runSearch = async (q) => {
    setSearchQuery(q);
    if (q.trim().length < 2) { setSearchResults([]); return; }
    setSearching(true);
    const results = await db.searchPlayers(q);
    setSearching(false);
    setSearchResults(results);
  };

  const openPastRoster = async (pt) => {
    const players = await db.listRosterForTeam(pt.teamId);
    setPastRoster({ teamName: pt.teamName, context: pt.context, players });
  };

  const removePlayer = async (num) => {
    if (!confirm("Remove this player from your roster?")) return;
    const ok = await db.removePlayerFromTeam(teamId, num);
    if (!ok) { setError("Could not remove player."); return; }
    setError(""); flash("Player removed."); await refresh();
  };

  const openCodeGen = (p) => {
    setCodeGenFor(p);
    setCodeGenEmail(p.email || "");
  };
  const submitCodeGen = async (p) => {
    setCodeGenSaving(true);
    const result = await db.generatePlayerInviteCode(teamId, p.num, codeGenEmail);
    setCodeGenSaving(false);
    if (!result) { setError("Could not generate a code."); return; }
    setError("");
    setGeneratedCodes(prev => ({ ...prev, [p.num]: result.code }));
  };

  const submitRoster = async () => {
    setSubmitting(true);
    const ok = await db.submitTeamRoster(teamId, profileId);
    setSubmitting(false);
    if (!ok) { setError("Could not submit roster."); return; }
    flash("Roster submitted — your league manager has been notified."); await refresh();
  };

  if (!teamId) return <div className="empty-state">Your account isn't linked to a team yet — ask your league manager to assign one.</div>;
  if (loading) return <Loader/>;
  if (!team) return <div className="empty-state">Team not found.</div>;

  return (
    <>
      <div className="card">
        <div className="card__title">Team Name</div>
        <div className="field"><input className="input" value={nameInput} onChange={e=>setNameInput(e.target.value)} /></div>
        <button className="btn-secondary" onClick={saveName} disabled={savingName||!nameInput.trim()||nameInput.trim()===team.name}>
          {savingName ? "Saving…" : "Save Team Name"}
        </button>
      </div>

      <div className="card">
        <div className="card__title">Roster ({roster.length})</div>
        {roster.length===0 && <div className="empty-state" style={{border:"none"}}>No players on this roster yet.</div>}
        <div className="team-select-list">
          {roster.map(p => (
            <div key={p.num} className="list-row">
              <div className="list-row__body">
                <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                  <span className="list-row__name">{p.name}{p.nickname?` "${p.nickname}"`:""}</span>
                  <span className="list-row__sub">{p.rating!=null ? `Rating ${p.rating}` : "Needs rating"}{p.hasAccount ? " · has an account" : ""}</span>
                </div>
                {!p.hasAccount && (
                  <button className="btn-icon-sm" onClick={()=>openCodeGen(p)} aria-label="Generate invite code"><Key size={13}/></button>
                )}
                <button className="btn-icon-sm" onClick={()=>removePlayer(p.num)} aria-label="Remove player"><Trash2 size={13}/></button>
              </div>
              {codeGenFor?.num === p.num && (
                <div style={{padding:"10px 12px",borderTop:"1px solid #2A2A2A"}}>
                  {!generatedCodes[p.num] ? (
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      <div className="field" style={{margin:0}}><Label>Email (optional, for sending later)</Label>
                        <input className="input" type="email" value={codeGenEmail} onChange={e=>setCodeGenEmail(e.target.value)} placeholder={p.email || "player@example.com"}/>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button className="btn-primary" onClick={()=>submitCodeGen(p)} disabled={codeGenSaving}>{codeGenSaving?"Generating…":"Generate Code"}</button>
                        <button className="btn-sm" onClick={()=>setCodeGenFor(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      <div style={{fontSize:11.5,color:"#9A9A9A"}}>Share this code with {p.name} — they enter it after creating an account.</div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:20,fontWeight:700,color:"#5FCF9E",letterSpacing:2}}>{generatedCodes[p.num]}</span>
                        <button className="btn-icon-sm" onClick={()=>{navigator.clipboard?.writeText(generatedCodes[p.num]);}} aria-label="Copy code"><Copy size={13}/></button>
                      </div>
                      <button className="btn-sm" onClick={()=>setCodeGenFor(null)}>Done</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {!addMode ? (
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:8}}>
            <button className="btn-secondary" onClick={()=>setAddMode("past")}>From My Last Team</button>
            <button className="btn-secondary" onClick={()=>setAddMode("search")}>Look Up a Player</button>
            <button className="btn-primary" onClick={()=>setAddMode("new")}><Plus size={13}/> New Player</button>
          </div>
        ) : (
          <div style={{marginTop:10}}>
            {addMode === "new" && (
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <div className="field"><Label>Player Name</Label>
                  <input className="input" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Full name"/>
                </div>
                <div className="field"><Label>Nickname (optional)</Label>
                  <input className="input" value={newNickname} onChange={e=>setNewNickname(e.target.value)} placeholder="Nickname"/>
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button className="btn-primary" onClick={addNewPlayer} disabled={adding||!newName.trim()}>{adding?"Adding…":"Add Player"}</button>
                  <button className="btn-sm" onClick={()=>{setAddMode(null);setNewName("");setNewNickname("");}}>Cancel</button>
                </div>
              </div>
            )}

            {addMode === "search" && (
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <input className="input" value={searchQuery} onChange={e=>runSearch(e.target.value)} placeholder="Search player name…" autoFocus/>
                {searching && <Loader/>}
                {!searching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
                  <div className="empty-state" style={{border:"none"}}>No players found.</div>
                )}
                <div className="team-select-list">
                  {searchResults.map(p => (
                    <div key={p.num} className="list-row">
                      <div className="list-row__body">
                        <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                          <span className="list-row__name">{p.name}{p.nickname?` "${p.nickname}"`:""}</span>
                          <span className="list-row__sub">{p.rating!=null ? `Rating ${p.rating}` : "Needs rating"}</span>
                        </div>
                        {onRosterNums.has(p.num)
                          ? <span className="you-badge">on roster</span>
                          : <button className="btn-icon-sm" onClick={()=>addExisting(p.num, p.name)} aria-label="Add player"><Plus size={13}/></button>}
                      </div>
                    </div>
                  ))}
                </div>
                <button className="btn-sm" onClick={()=>{setAddMode(null);setSearchQuery("");setSearchResults([]);}}>Done</button>
              </div>
            )}

            {addMode === "past" && (
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {pastTeams.length === 0 && <div className="empty-state" style={{border:"none"}}>You haven't captained another team before.</div>}
                {!pastRoster && pastTeams.map(pt => (
                  <button key={pt.teamId} className="team-select-btn" onClick={()=>openPastRoster(pt)}>
                    <span className="team-select-name">{pt.teamName}{pt.context?` · ${pt.context}`:""}</span>
                  </button>
                ))}
                {pastRoster && (
                  <>
                    <div style={{fontSize:11.5,color:"#9A9A9A"}}>{pastRoster.teamName}{pastRoster.context?` · ${pastRoster.context}`:""}</div>
                    <div className="team-select-list">
                      {pastRoster.players.map(p => (
                        <div key={p.num} className="list-row">
                          <div className="list-row__body">
                            <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                              <span className="list-row__name">{p.name}{p.nickname?` "${p.nickname}"`:""}</span>
                              <span className="list-row__sub">{p.rating!=null ? `Rating ${p.rating}` : "Needs rating"}</span>
                            </div>
                            {onRosterNums.has(p.num)
                              ? <span className="you-badge">on roster</span>
                              : <button className="btn-icon-sm" onClick={()=>addExisting(p.num, p.name)} aria-label="Add player"><Plus size={13}/></button>}
                          </div>
                        </div>
                      ))}
                    </div>
                    <button className="btn-sm" onClick={()=>setPastRoster(null)}>← Other teams</button>
                  </>
                )}
                <button className="btn-sm" onClick={()=>{setAddMode(null);setPastRoster(null);}}>Done</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__title">Submit Roster</div>
        {team.rosterSubmittedAt
          ? <div style={{fontSize:12,color:"#5FCF9E",fontWeight:600}}>Submitted {new Date(team.rosterSubmittedAt).toLocaleDateString()}. You can keep making changes — resubmit any time.</div>
          : <div style={{fontSize:11.5,color:"#9A9A9A",marginBottom:8}}>Let your league manager know your roster is ready for the season. Doesn't lock anything — you can still edit it afterward.</div>}
        <button className="btn-secondary" onClick={submitRoster} disabled={submitting || roster.length===0}>{submitting?"Submitting…":"Submit Roster"}</button>
      </div>

      {error && <ErrorMsg>{error}</ErrorMsg>}
      {success && <div className="success-msg"><Check size={12}/> {success}</div>}
    </>
  );
}

// ─── Lineup Planner (captain-only, team-scoped) ────────────────────────────
// Purely a scheduling/communication tool -- who's expected to shoot which
// week, plus an optional note -- entirely optional, never required, and
// completely separate from live-entry draft/scoring eligibility. A week
// with nothing planned behaves exactly as it always has; this never gates
// anything. Visibility of the saved plans themselves is enforced server-
// side by RLS (is_on_team(), section 43) -- this page is captain-only, but
// team members can read the same data read-only elsewhere (e.g. the
// Leagues dashboard's "Who's Shooting" card).
function opponentNameFor(pairing, teamId, teams) {
  const oppId = pairing.homeTeamId === teamId ? pairing.awayTeamId : pairing.homeTeamId;
  return teams.find(t => t.id === oppId)?.name ?? "TBD";
}

function LineupPlannerPanel({ teamId, profileId }) {
  const [overview, setOverview] = useState(undefined); // undefined = loading, null = no schedule
  const [roster, setRoster] = useState([]);
  const [plans, setPlans] = useState([]);
  const [unavailability, setUnavailability] = useState([]); // every player-marked "can't shoot" row on file for this team
  const [selectedWeekId, setSelectedWeekId] = useState("");
  const [selectedNums, setSelectedNums] = useState(new Set());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const refresh = async () => {
    const [ov, r, p, u] = await Promise.all([
      db.getTeamScheduleOverview(teamId),
      db.listRosterForTeam(teamId),
      db.listTeamLineupPlans(teamId),
      db.listTeamUnavailability(teamId),
    ]);
    setOverview(ov ?? null);
    setRoster(r);
    setPlans(p);
    setUnavailability(u);
  };
  useEffect(() => { refresh(); }, [teamId]);

  // Real schedule weeks only (a captain can only plan a week their team
  // actually has a pairing in) -- sorted chronologically, same parse-then-
  // sort convention used on the dashboards, since week_date is free text.
  const weekOptions = (overview?.myWeeks ?? [])
    .map(w => ({ ...w, _date: (() => { const parts = (w.date||"").split("/").map(Number); return parts.length>=3 && !parts.some(isNaN) ? new Date(parts[2], parts[0]-1, parts[1]) : null; })() }))
    .sort((a, b) => (a._date ?? 0) - (b._date ?? 0));

  const planForWeek = (weekId) => plans.find(p => p.scheduleWeekId === weekId) ?? null;
  // Players who've marked themselves unable to shoot the CURRENTLY SELECTED
  // week -- this is just a heads-up warning while building the lineup, not
  // a hard block, since plans sometimes change at the last minute.
  const unavailableThisWeek = new Map(
    unavailability.filter(u => u.scheduleWeekId === selectedWeekId).map(u => [u.playerNum, u])
  );

  const loadWeekIntoForm = (weekId) => {
    setSelectedWeekId(weekId);
    const existing = planForWeek(weekId);
    setSelectedNums(new Set((existing?.players ?? []).map(p => p.num)));
    setNote(existing?.note ?? "");
    setError(""); setSuccess("");
  };

  const togglePlayer = (num) => {
    setSelectedNums(prev => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num); else next.add(num);
      return next;
    });
  };

  const save = async () => {
    if (!selectedWeekId) { setError("Pick a week first."); return; }
    setSaving(true); setError("");
    const ok = await db.upsertLineupPlan(teamId, selectedWeekId, note, [...selectedNums], profileId);
    setSaving(false);
    if (!ok) { setError("Could not save this week's plan."); return; }
    setSuccess("Saved."); setTimeout(() => setSuccess(""), 2000);
    await refresh();
  };

  const clearWeek = async (planId, weekId) => {
    if (!confirm("Clear this week's planned lineup? This doesn't affect the schedule or match itself, just the note to your team.")) return;
    await db.deleteLineupPlan(planId);
    if (selectedWeekId === weekId) { setSelectedNums(new Set()); setNote(""); }
    await refresh();
  };

  if (overview === undefined) return <Loader />;
  if (!overview) return <div className="empty-state">No schedule loaded for your team's division yet — check back once one is imported.</div>;

  const selectedWeek = weekOptions.find(w => w.id === selectedWeekId);
  const selectedUnavailableCount = [...selectedNums].filter(num => unavailableThisWeek.has(num)).length;

  return (
    <>
      <div style={{fontSize:11.5,color:"#9A9A9A",lineHeight:1.5}}>
        Note who you expect to shoot for any of your team's upcoming weeks — entirely optional, just a heads-up for your roster. It doesn't reserve tables or affect live scoring; whoever actually shows up still gets drafted normally on match night.
      </div>

      <div className="card">
        <div className="card__title">Plan a Week</div>
        <div className="field"><Label>Week</Label>
          <select className="input input--select" value={selectedWeekId} onChange={e => loadWeekIntoForm(e.target.value)}>
            <option value="">Select a week…</option>
            {weekOptions.map(w => (
              <option key={w.id} value={w.id}>
                {w.week ? `Week ${w.week} · ` : ""}{w.date} — vs {opponentNameFor(w.pairings[0], teamId, overview.teams)}{planForWeek(w.id) ? " (planned)" : ""}
              </option>
            ))}
          </select>
        </div>

        {selectedWeek && (
          <>
            <div className="field"><Label>Who's Shooting</Label>
              <div className="team-select-list">
                {roster.length === 0 && <div className="empty-state" style={{border:"none"}}>No players on your roster yet.</div>}
                {roster.map(p => {
                  const unavail = unavailableThisWeek.get(p.num);
                  return (
                    <div key={p.num}>
                      <button className={`draft-roster-row ${selectedNums.has(p.num) ? "draft-roster-row--selected" : ""}`} onClick={() => togglePlayer(p.num)}>
                        <span className="draft-roster-row__name">
                          {p.name}{p.nickname ? ` "${p.nickname}"` : ""}
                          {unavail && <span style={{marginLeft:6,fontSize:9.5,fontWeight:800,color:"#F87171",background:"#2A1010",padding:"2px 6px",borderRadius:10}}>CAN'T SHOOT</span>}
                        </span>
                        {selectedNums.has(p.num) && <Check size={14} color="#5FCF9E" />}
                      </button>
                      {unavail?.reason && <div style={{fontSize:10.5,color:"#8A8A8A",fontStyle:"italic",padding:"2px 4px 4px"}}>"{unavail.reason}"</div>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="field"><Label>Note (optional)</Label>
              <textarea className="paste-area" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Meet 15 min early, still need one more sub" />
            </div>
            {selectedUnavailableCount > 0 && (
              <div className="readonly-bar" style={{color:"#F87171"}}>
                {selectedUnavailableCount} selected player{selectedUnavailableCount !== 1 ? "s" : ""} marked themselves unable to shoot this week — double-check before saving.
              </div>
            )}
            {error && <ErrorMsg>{error}</ErrorMsg>}
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : success ? <><Check size={13}/> Saved!</> : "Save This Week's Plan"}
            </button>
          </>
        )}
      </div>

      {plans.length > 0 && (
        <div className="card">
          <div className="card__title">Planned Weeks ({plans.length})</div>
          <div className="list">
            {plans.map(p => (
              <div key={p.id} className="list-row">
                <div className="list-row__body">
                  <div style={{display:"flex",flexDirection:"column",gap:2,flex:1}}>
                    <span className="list-row__name">{p.weekNum ? `Week ${p.weekNum} · ` : ""}{p.weekDate}</span>
                    <span className="list-row__sub">{p.players.length > 0 ? p.players.map(pl => pl.name).join(", ") : "No players noted"}{p.note ? ` · "${p.note}"` : ""}</span>
                  </div>
                </div>
                <div className="list-row__actions">
                  <button className="btn-icon" onClick={() => loadWeekIntoForm(p.scheduleWeekId)}><Edit2 size={13}/></button>
                  <button className="btn-icon btn-icon--danger" onClick={() => clearWeek(p.id, p.scheduleWeekId)}><Trash2 size={13}/></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Team Stats (captain-only, team-scoped) ────────────────────────────────
// Advanced (Track a Rack) stats rolled up across the whole team, plus a
// per-player breakdown -- reads shot_events via the denormalized team_id
// column set at logging time. Same optional/supplemental nature as
// everywhere else this data shows up: a team with nobody tracking shots
// just shows an empty state, nothing else in the app depends on this.
function TeamStatsPanel({ teamId }) {
  const [rawEvents, setRawEvents] = useState(undefined); // undefined = loading, null = nothing tracked
  const [teamContext, setTeamContext] = useState(""); // e.g. "Div 1 · Summer 2026" -- a team is permanently tied to one division/season, so this data is already scoped; this just makes that visible
  const [gameTypeFilter, setGameTypeFilter] = useState(null);
  const [playTypeFilter, setPlayTypeFilter] = useState("all");
  const [breakdown, setBreakdown] = useState(null);

  useEffect(() => {
    db.listTeamShotEvents(teamId).then(events => setRawEvents(events.length ? events : null));
    db.listAllTeamsWithContext().then(all => setTeamContext(all.find(t => t.id === teamId)?.context ?? ""));
  }, [teamId]);

  const filteredEvents = (rawEvents ?? []).filter(e => (!gameTypeFilter || e.game_type === gameTypeFilter) && matchesPlayType(e, playTypeFilter));

  useEffect(() => {
    if (!rawEvents) { setBreakdown(null); return; }
    db.computeTeamShotBreakdown(filteredEvents).then(setBreakdown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawEvents, gameTypeFilter, playTypeFilter]);

  if (rawEvents === undefined) return <Loader />;
  if (rawEvents === null) {
    return <div className="empty-state">No advanced stats tracked for this team yet — players can optionally use "Track a Rack" during a live match, manual entry, or practice.</div>;
  }

  const exportCSV = async () => {
    const names = await db.getPlayerNameMap(filteredEvents.flatMap(e => [e.player_num, e.opponent_player_num]));
    db.downloadCSV(`team-advanced-stats.csv`, db.shotEventsToCSV(filteredEvents, names));
  };

  return (
    <>
      <div className="card">
        <div className="card__title">Team Rollup{teamContext ? ` — ${teamContext}` : ""}</div>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:4}}>
          <FilterChips options={PLAY_TYPE_FILTERS} value={playTypeFilter} onChange={setPlayTypeFilter} />
          <FilterChips options={GAME_TYPE_FILTERS} value={gameTypeFilter} onChange={setGameTypeFilter} />
        </div>
        {!breakdown || filteredEvents.length === 0
          ? <div className="dash-empty" style={{marginTop:8}}>No tracked shots match this filter.</div>
          : <>
              <ShotStatsBlock stats={breakdown.team} />
              <div style={{display:"flex",gap:8,marginTop:10}} className="no-print">
                <button className="btn-sm" onClick={() => window.print()}>Print / Save as PDF</button>
                <button className="btn-sm" onClick={exportCSV}>Export CSV</button>
              </div>
            </>}
      </div>
      {breakdown && breakdown.perPlayer.length > 0 && (
        <div className="card">
          <div className="card__title">By Player</div>
          <div className="list" style={{marginTop:6}}>
            {breakdown.perPlayer.map(p => (
              <div key={p.playerNum} className="list-row">
                <div className="list-row__body">
                  <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                    <span className="list-row__name">{p.name}</span>
                    <span className="list-row__sub">{p.stats.totalShots} shots · {p.stats.makePct}% makes · {p.stats.runouts} runouts · {p.stats.scratches} scratches</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Leaderboard (leaguewide, every role) ──────────────────────────────────
// Ranks every player with tracked advanced stats by a chosen metric.
// All-time, not season/division-scoped yet -- a natural next refinement
// once there's real volume behind this; noted rather than silently guessed.
// A minimum sample size applies to percentage-based metrics only (make %,
// safety %) so one lucky shot can't top the board -- count-based metrics
// (runouts, total shots) have no such floor.
const LEADERBOARD_METRICS = [
  { key: "makePct", label: "Make %", min: 10, get: s => s.makePct, fmt: v => `${v}%` },
  { key: "totalShots", label: "Total Shots", min: 0, get: s => s.totalShots, fmt: v => v },
  { key: "runouts", label: "Runouts", min: 0, get: s => s.runouts, fmt: v => v },
  { key: "safetyPct", label: "Safety %", min: 5, get: s => s.safeties.pct, fmt: v => `${v}%`, minField: s => s.safeties.attempts },
];

function LeaderboardPage() {
  const [rawEvents, setRawEvents] = useState(undefined);
  const [divisions, setDivisions] = useState([]);
  const [divisionFilter, setDivisionFilter] = useState(""); // "" = All Divisions/Seasons
  const [gameTypeFilter, setGameTypeFilter] = useState(null);
  const [playTypeFilter, setPlayTypeFilter] = useState("all");
  const [metricKey, setMetricKey] = useState("makePct");
  const [ranked, setRanked] = useState([]);

  useEffect(() => {
    db.listAllShotEvents().then(events => setRawEvents(events.length ? events : null));
    db.listAllDivisionsFlat().then(setDivisions);
  }, []);

  // A division filter only makes sense for league play -- practice has no
  // division concept at all (division_id is always null there), so picking
  // a specific division implicitly narrows to league events, same way
  // picking "Practice" as play type would exclude anything division-scoped.
  const filteredEvents = (rawEvents ?? []).filter(e =>
    (!gameTypeFilter || e.game_type === gameTypeFilter) &&
    matchesPlayType(e, playTypeFilter) &&
    (!divisionFilter || e.division_id === divisionFilter)
  );
  const metric = LEADERBOARD_METRICS.find(m => m.key === metricKey);

  useEffect(() => {
    if (!rawEvents) { setRanked([]); return; }
    db.computeLeaderboard(filteredEvents).then(list => {
      const eligible = list.filter(p => (metric.minField ? metric.minField(p.stats) : p.stats.totalShots) >= metric.min);
      setRanked(eligible.sort((a, b) => metric.get(b.stats) - metric.get(a.stats)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawEvents, gameTypeFilter, playTypeFilter, divisionFilter, metricKey]);

  const exportCSV = async () => {
    const names = await db.getPlayerNameMap(filteredEvents.flatMap(e => [e.player_num, e.opponent_player_num]));
    db.downloadCSV("leaderboard-advanced-stats.csv", db.shotEventsToCSV(filteredEvents, names));
  };

  return (
    <>
      <PageHeader title="Advanced Stats Leaderboard" subtitle={divisionFilter ? "This division/season" : "Leaguewide · all-time"} />
      <div className="tab-content">
        {rawEvents === undefined && <Loader />}
        {rawEvents === null && <div className="empty-state">No advanced stats tracked yet leaguewide — once players start using "Track a Rack," rankings will show up here.</div>}
        {rawEvents && (
          <>
            <div className="card">
              <div className="field"><Label>Rank By</Label>
                <select className="input input--select" value={metricKey} onChange={e => setMetricKey(e.target.value)}>
                  {LEADERBOARD_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </div>
              <div className="field"><Label>Division / Season</Label>
                <select className="input input--select" value={divisionFilter} onChange={e => setDivisionFilter(e.target.value)}>
                  <option value="">All Divisions / Seasons (all-time)</option>
                  {divisions.map(d => <option key={d.id} value={d.id}>Div {d.num}{d.name ? ` · ${d.name}` : ""} — {d.seasonLabel}{d.isActive ? " · Active" : ""}</option>)}
                </select>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:4}}>
                <FilterChips options={PLAY_TYPE_FILTERS} value={playTypeFilter} onChange={setPlayTypeFilter} />
                <FilterChips options={GAME_TYPE_FILTERS} value={gameTypeFilter} onChange={setGameTypeFilter} />
              </div>
              {metric.min > 0 && <div style={{fontSize:10,color:"#6A6A6A",marginTop:8}}>Minimum {metric.min} {metric.minField ? "safety attempts" : "shots"} tracked to qualify for this ranking.</div>}
              <div style={{display:"flex",gap:8,marginTop:10}} className="no-print">
                <button className="btn-sm" onClick={() => window.print()}>Print / Save as PDF</button>
                <button className="btn-sm" onClick={exportCSV}>Export CSV</button>
              </div>
            </div>
            <div className="list">
              {ranked.length === 0 && <div className="empty-state" style={{border:"none"}}>No players qualify for this ranking yet.</div>}
              {ranked.map((p, i) => (
                <div key={p.playerNum} className="list-row">
                  <div className="list-row__body">
                    <span className="list-row__id">{i + 1}</span>
                    <div style={{display:"flex",flexDirection:"column",gap:1,flex:1}}>
                      <span className="list-row__name">{p.name}{p.nickname ? ` "${p.nickname}"` : ""}</span>
                      <span className="list-row__sub">{p.stats.totalShots} shots tracked</span>
                    </div>
                    <span className="player-rating-badge">{metric.fmt(metric.get(p.stats))}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function formatLastSeen(iso) {
  if (!iso) return { text: "Never signed in", warn: false };
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  const months = ms / (86400000 * 30.44);
  let text;
  if (days < 1) text = "Today";
  else if (days === 1) text = "Yesterday";
  else if (days < 30) text = `${days} days ago`;
  else if (months < 12) text = `${Math.round(months)} month${Math.round(months)!==1?"s":""} ago`;
  else text = `${(months/12).toFixed(1)} years ago`;
  return { text, warn: months >= 15 }; // approaching the 18-month auto-deactivation threshold
}

// ─── Accounts Tab ─────────────────────────────────────────────────────────────
function AccountsTab({ currentUserId, subTab, onCounts }) {
  const [users, setUsers]       = useState([]);
  const [codes, setCodes]       = useState([]);
  const [allTeams, setAllTeams] = useState([]);
  const [lastSignIns, setLastSignIns] = useState({});
  const [loading, setLoading]   = useState(true);
  const [newRole, setNewRole]   = useState("captain");
  const [newTeamId, setNewTeamId] = useState("");
  const [teamInput, setTeamInput] = useState("");
  const [generated, setGenerated] = useState(null);
  const [copied, setCopied]     = useState(false);
  const [editRoleId, setEditRoleId] = useState(null);
  const [editRole, setEditRole]     = useState("player");
  const [editTeamId, setEditTeamId] = useState("");
  const [editTeamInput, setEditTeamInput] = useState("");
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleErr, setRoleErr]       = useState("");

  const refresh = async () => {
    const [u, c, t, l] = await Promise.all([db.listProfiles(), db.listInviteCodes(), db.listAllTeamsWithContext(), db.listUserLastSignIns()]);
    setUsers(u); setCodes(c); setAllTeams(t); setLastSignIns(l); setLoading(false);
    const activeCount = c.filter(x=>!x.used_at&&(!x.expires_at||new Date(x.expires_at)>new Date())).length;
    onCounts?.({ users: u.length, codes: activeCount });
  };
  useEffect(() => {
    // Best-effort fallback for the 18-month auto-deactivation sweep, in case
    // pg_cron isn't available on this Supabase plan -- runs quietly whenever
    // a manager opens this tab, then loads the (possibly just-updated) list.
    db.runStaleUserCleanup().finally(refresh);
  }, []);

  const generateInvite = async () => {
    const code = { code: generateCode(), role: newRole, team_id: newRole==="captain"?(newTeamId||null):null,
      expires_at: new Date(Date.now()+7*24*60*60*1000).toISOString() };
    const ok = await db.createInviteCode(code);
    if (ok) { setGenerated(code); setCopied(false); await refresh(); }
  };
  const revokeCode = async (code) => { await db.revokeInviteCode(code); if(generated?.code===code) setGenerated(null); await refresh(); };
  const deactivateUser = async (id) => { if(id===currentUserId) return; await db.setProfileActive(id, false); await refresh(); };
  const reactivateUser = async (id) => { await db.setProfileActive(id, true); await refresh(); };
  const copyCode = (code) => { navigator.clipboard?.writeText(code).catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),2000); };

  const startEditRole = (u) => {
    setEditRoleId(u.id); setEditRole(u.role); setRoleErr("");
    const team = u.team_id ? allTeams.find(t=>t.id===u.team_id) : null;
    setEditTeamId(u.team_id ?? "");
    setEditTeamInput(team ? `${team.name}${team.context?` — ${team.context}`:""}` : "");
  };
  const cancelEditRole = () => { setEditRoleId(null); setRoleErr(""); };
  const saveEditRole = async (userId) => {
    if (editRole === "captain" && !editTeamId) { setRoleErr("Pick a team for this captain."); return; }
    setRoleSaving(true);
    const ok = await db.setProfileRole(userId, editRole, editRole==="captain" ? editTeamId : editTeamId || null);
    setRoleSaving(false);
    if (!ok) { setRoleErr("Could not update role."); return; }
    setEditRoleId(null); await refresh();
  };

  if (loading) return <Loader/>;

  const activeCodes = codes.filter(c=>!c.used_at&&(!c.expires_at||new Date(c.expires_at)>new Date()));
  const usedCodes   = codes.filter(c=> c.used_at);
  const pickableTeams = allTeams.filter(t=>!t.isBye).sort((a,b)=>a.name.localeCompare(b.name));
  const activePickableTeams = pickableTeams.filter(t=>t.isActiveSeason);

  return (
    <>
      {subTab==="users" && (
        <div className="list">
          {users.map(u => {
            const team = u.team_id ? allTeams.find(t=>t.id===u.team_id) : null;
            const isMe = u.id===currentUserId;
            const editing = editRoleId===u.id;
            return (
              <div key={u.id} className="list-row" style={{flexDirection: editing ? "column" : "row", alignItems: editing ? "stretch" : "center"}}>
                {editing ? (
                  <div style={{display:"flex",flexDirection:"column",gap:8,width:"100%"}}>
                    <div style={{display:"flex",alignItems:"center",gap:7}}>
                      <span className="list-row__name">@{u.username}</span>
                    </div>
                    <select className="input input--select" value={editRole} onChange={e=>{setEditRole(e.target.value);setRoleErr("");}}>
                      <option value="player">Player</option>
                      <option value="captain">Team Captain</option>
                      <option value="manager">League Manager</option>
                    </select>
                    {editRole==="captain" && (
                      <div className="field" style={{margin:0}}>
                        <input className="input" list="edit-role-team-options" value={editTeamInput} autoComplete="off"
                          placeholder="Start typing a team name…"
                          onChange={e=>{
                            const val = e.target.value;
                            setEditTeamInput(val);
                            const match = activePickableTeams.find(t => `${t.name}${t.context?` — ${t.context}`:""}` === val);
                            setEditTeamId(match ? match.id : "");
                          }}/>
                        <datalist id="edit-role-team-options">
                          {activePickableTeams.map(t=><option key={t.id} value={`${t.name}${t.context?` — ${t.context}`:""}`} />)}
                        </datalist>
                      </div>
                    )}
                    {roleErr && <ErrorMsg>{roleErr}</ErrorMsg>}
                    <div style={{display:"flex",gap:6}}>
                      <button className="btn-primary" onClick={()=>saveEditRole(u.id)} disabled={roleSaving}>{roleSaving?"Saving…":"Save Role"}</button>
                      <button className="btn-sm" onClick={cancelEditRole}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="list-row__body" style={{flexDirection:"column",alignItems:"flex-start",gap:3, opacity: u.is_active?1:0.5}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <span className="list-row__name">@{u.username}</span>
                        {isMe && <span className="you-badge">you</span>}
                        {!u.is_active && <span className="you-badge" style={{background:"#1A0E0E",color:"#F87171"}}>deactivated</span>}
                        {u.is_active && u.is_claimed===false && <span className="you-badge" style={{background:"#2A2410",color:"#F2C14E"}}>needs role</span>}
                      </div>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <RolePill role={u.role} small/>
                        {team && <span className="user-team-label">{team.name}</span>}
                      </div>
                      {u.email && <span className="list-row__sub">{u.email}</span>}
                      {u.phone_number && <span className="list-row__sub">{u.phone_number}</span>}
                      {(() => { const seen = formatLastSeen(lastSignIns[u.id]); return (
                        <span className="list-row__sub" style={seen.warn ? {color:"#F59E0B"} : undefined}>Last seen: {seen.text}</span>
                      ); })()}
                    </div>
                    <div className="list-row__actions">
                      {!isMe && <button className="btn-icon" onClick={()=>startEditRole(u)} title="Change role"><Edit2 size={13}/></button>}
                      {!isMe && (
                        u.is_active
                          ? <button className="btn-icon btn-icon--danger" onClick={()=>deactivateUser(u.id)}><Trash2 size={13}/></button>
                          : <button className="btn-icon btn-icon--confirm" onClick={()=>reactivateUser(u.id)}><Check size={13}/></button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {subTab==="codes" && (
        <>
          <div className="card">
            <div className="card__title">Generate Invite Code</div>
            <div className="field"><Label>Role</Label>
              <select className="input input--select" value={newRole} onChange={e=>{setNewRole(e.target.value);setNewTeamId("");setTeamInput("");}}>
                <option value="captain">Team Captain</option>
                <option value="player">Player</option>
                <option value="manager">League Manager</option>
              </select>
            </div>
            {newRole==="captain" && (
              <div className="field"><Label>Assign Team</Label>
                <input className="input" list="assign-team-options" value={teamInput} autoComplete="off"
                  placeholder="Start typing a team name…"
                  onChange={e=>{
                    const val = e.target.value;
                    setTeamInput(val);
                    const match = activePickableTeams.find(t => `${t.name}${t.context?` — ${t.context}`:""}` === val);
                    setNewTeamId(match ? match.id : "");
                  }}/>
                <datalist id="assign-team-options">
                  {activePickableTeams.map(t=><option key={t.id} value={`${t.name}${t.context?` — ${t.context}`:""}`} />)}
                </datalist>
                <div style={{fontSize:10.5,color:"#6A6A6A",marginTop:4}}>Captains are assigned a team here — they no longer pick one at registration.</div>
              </div>
            )}
            <button className="btn-primary" onClick={generateInvite} disabled={newRole==="captain" && !newTeamId}><Key size={13}/> Generate Code</button>
            {generated && (
              <div className="generated-code-block">
                <div className="generated-code-block__label">Share this — expires in 7 days</div>
                <div className="generated-code-block__row">
                  <span className="generated-code-block__code">{generated.code}</span>
                  <button className="btn-copy" onClick={()=>copyCode(generated.code)}>{copied?<Check size={13}/>:<Copy size={13}/>}{copied?"Copied":"Copy"}</button>
                </div>
                <div className="generated-code-block__meta">
                  <RolePill role={generated.role} small/>
                  {generated.team_id && <span className="user-team-label">{allTeams.find(t=>t.id===generated.team_id)?.name}</span>}
                </div>
              </div>
            )}
          </div>
          {activeCodes.length>0 && (<>
            <SectionHeader title={`Active (${activeCodes.length})`}/>
            <div className="list">
              {activeCodes.map(c=>{
                const team=c.team_id?allTeams.find(t=>t.id===c.team_id):null;
                const daysLeft=Math.ceil((new Date(c.expires_at)-Date.now())/86400000);
                return (
                  <div key={c.code} className="list-row">
                    <div className="list-row__body" style={{flexDirection:"column",alignItems:"flex-start",gap:4}}>
                      <span className="code-display">{c.code}</span>
                      <div style={{display:"flex",gap:6}}><RolePill role={c.role} small/>{team&&<span className="user-team-label">{team.name}</span>}<span className="code-expiry">{daysLeft}d left</span></div>
                      {c.label_name && <span className="list-row__sub">For {c.label_name}</span>}
                    </div>
                    <div className="list-row__actions">
                      <button className="btn-icon" onClick={()=>copyCode(c.code)}><Copy size={13}/></button>
                      <button className="btn-icon btn-icon--danger" onClick={()=>revokeCode(c.code)}><Trash2 size={13}/></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>)}
          {usedCodes.length>0 && (<>
            <SectionHeader title={`Used (${usedCodes.length})`}/>
            <div className="list" style={{opacity:.5}}>
              {usedCodes.map(c=>{const usedBy=users.find(u=>u.id===c.used_by);return(
                <div key={c.code} className="list-row">
                  <div className="list-row__body"><span className="code-display">{c.code}</span><RolePill role={c.role} small/>{usedBy&&<span className="user-team-label">@{usedBy.username}</span>}</div>
                </div>
              );})}
            </div>
          </>)}
        </>
      )}
    </>
  );
}

// ─── Playoff Bracket View (shared: read-only display used by both the
// manager's Playoffs tab and Match Lookup / History) ───────────────────────
function PlayoffBracketView({ matches, teams }) {
  const nameOf = (id) => teams.find(t => t.id === id)?.name ?? (id ? "TBD" : "TBD");
  const groups = {};
  for (const m of matches) (groups[m.bracket_group] ??= []).push(m);

  const championship = Object.values(groups).filter(g => g[0].bracket_type === "championship");
  const consolation = Object.values(groups).filter(g => g[0].bracket_type === "consolation");

  const renderBracket = (group) => {
    const label = group[0].bracket_label;
    const semis = group.filter(m => m.round === "semifinal").sort((a,b) => a.slot_num - b.slot_num);
    const final = group.find(m => m.round === "final");
    return (
      <div key={label} className="card">
        <div className="card__title">{label}</div>
        {semis.map(s => (
          <div key={s.id} className="bracket-row">
            <div className={`bracket-row__team ${s.winner_team_id===s.team_home_id?"bracket-row__team--won":""}`}>
              {s.seed_home && <span className="bracket-row__seed">#{s.seed_home}</span>} {nameOf(s.team_home_id)}
            </div>
            <div className="bracket-row__vs">{s.is_bye_home || s.is_bye_away ? "bye" : "vs"}</div>
            <div className={`bracket-row__team ${s.winner_team_id===s.team_away_id?"bracket-row__team--won":""}`}>
              {s.seed_away && <span className="bracket-row__seed">#{s.seed_away}</span>} {nameOf(s.team_away_id)}
            </div>
          </div>
        ))}
        {final && (
          <>
            <div className="bracket-divider">Final</div>
            <div className="bracket-row">
              <div className={`bracket-row__team ${final.winner_team_id===final.team_home_id?"bracket-row__team--won":""}`}>{nameOf(final.team_home_id)}</div>
              <div className="bracket-row__vs">vs</div>
              <div className={`bracket-row__team ${final.winner_team_id===final.team_away_id?"bracket-row__team--won":""}`}>{nameOf(final.team_away_id)}</div>
            </div>
            {final.winner_team_id && (
              <div className="bracket-champion"><Trophy size={13}/> {nameOf(final.winner_team_id)} — {group[0].bracket_type==="championship"?"Division Champion":"Consolation Champion"}</div>
            )}
          </>
        )}
      </div>
    );
  };

  if (championship.length === 0 && consolation.length === 0) {
    return <div className="empty-state">No playoff bracket generated yet.</div>;
  }
  return (
    <>
      {championship.map(renderBracket)}
      {consolation.map(renderBracket)}
    </>
  );
}

// ─── Playoffs read-only view (Match Lookup / History) ──────────────────────
function PlayoffsHistoryView({ divisionId, teams }) {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { db.listPlayoffBrackets(divisionId).then(m => { setMatches(m); setLoading(false); }); }, [divisionId]);
  if (loading) return <Loader/>;
  return <PlayoffBracketView matches={matches} teams={teams} />;
}

// ─── Playoffs Tab (manager: generate + review brackets) ────────────────────
function PlayoffsTab({ divisionId, teams }) {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState(null);

  const refresh = () => { setLoading(true); db.listPlayoffBrackets(divisionId).then(m => { setMatches(m); setLoading(false); }); };
  useEffect(refresh, [divisionId]);

  const hasChampionship = matches.some(m => m.bracket_type === "championship");
  const hasConsolation = matches.some(m => m.bracket_type === "consolation");

  const genChampionship = async () => {
    setGenerating(true); setError("");
    const result = await db.generateChampionshipBracket(divisionId);
    setGenerating(false);
    if (result?.error) { setError(result.error); return; }
    refresh();
  };

  const previewConsolation = async () => {
    setGenerating(true); setError("");
    const result = await db.previewConsolationBrackets(divisionId);
    setGenerating(false);
    if (result?.error) { setError(result.error); return; }
    if (!result.brackets?.length) { setError("No consolation teams found (need standings for 5th place or lower)."); return; }
    setProposal(result.brackets);
  };

  const moveTeam = (teamId, fromLabel, toLabel) => {
    setProposal(prev => {
      const next = prev.map(b => ({ ...b, teams: b.teams.filter(t => t.teamId !== teamId) }));
      const moved = prev.find(b => b.label === fromLabel).teams.find(t => t.teamId === teamId);
      const target = next.find(b => b.label === toLabel);
      if (target) target.teams.push(moved);
      return next;
    });
  };

  const confirmConsolation = async () => {
    setGenerating(true); setError("");
    const ok = await db.generateConsolationBrackets(divisionId, proposal);
    setGenerating(false);
    if (!ok) { setError("Could not save consolation brackets."); return; }
    setProposal(null);
    refresh();
  };

  if (loading) return <Loader/>;

  if (proposal) {
    return (
      <>
        <SectionHeader title="Review Consolation Brackets"/>
        <div style={{fontSize:11.5,color:"#9A9A9A",lineHeight:1.5,marginBottom:8}}>
          Suggested groupings of 4, pulling in teams from other divisions in this season where needed to fill a bracket. Move a team between brackets if this doesn't look right, then confirm.
        </div>
        {proposal.map(b => (
          <div key={b.label} className="card">
            <div className="card__title">{b.label} ({b.teams.length})</div>
            {b.teams.map(t => (
              <div key={t.teamId} className="list-row">
                <div className="list-row__body"><span className="list-row__name">{t.name}</span></div>
                <select className="input" style={{maxWidth:160}} value={b.label} onChange={e=>moveTeam(t.teamId, b.label, e.target.value)}>
                  {proposal.map(pb => <option key={pb.label} value={pb.label}>{pb.label}</option>)}
                </select>
              </div>
            ))}
          </div>
        ))}
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <div style={{display:"flex",gap:8}}>
          <button className="btn-secondary" onClick={()=>setProposal(null)}>Cancel</button>
          <button className="btn-primary" onClick={confirmConsolation} disabled={generating}>{generating?"Saving…":"Confirm & Generate"}</button>
        </div>
      </>
    );
  }

  return (
    <>
      <SectionHeader title="Playoffs"/>
      {!hasChampionship && (
        <div className="card">
          <div className="card__title">Championship Bracket</div>
          <div style={{fontSize:11.5,color:"#9A9A9A",marginBottom:8}}>Seeds the top 4 teams by regular-season standings: 1 vs 4, 2 vs 3.</div>
          <button className="btn-primary" onClick={genChampionship} disabled={generating}>{generating?"Generating…":"Generate Championship Bracket"}</button>
        </div>
      )}
      {!hasConsolation && (
        <div className="card">
          <div className="card__title">Consolation Bracket</div>
          <div style={{fontSize:11.5,color:"#9A9A9A",marginBottom:8}}>Groups 5th place & below into brackets of 4, borrowing from other divisions in this season if needed.</div>
          <button className="btn-primary" onClick={previewConsolation} disabled={generating}>{generating?"Loading…":"Preview Consolation Brackets"}</button>
        </div>
      )}
      {error && <ErrorMsg>{error}</ErrorMsg>}
      <PlayoffBracketView matches={matches} teams={teams} />
    </>
  );
}

// ─── Locations Tab ────────────────────────────────────────────────────────────
function formatAddress(loc) {
  return [loc.street, loc.city, loc.state, loc.zip].filter(part => part && part.trim()).join(", ");
}

function LocationsTab({ locations, onRefresh }) {
  const [newName, setNewName] = useState("");
  const [newStreet, setNewStreet] = useState("");
  const [newCity, setNewCity] = useState("");
  const [newState, setNewState] = useState("");
  const [newZip, setNewZip] = useState("");
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editStreet, setEditStreet] = useState("");
  const [editCity, setEditCity] = useState("");
  const [editState, setEditState] = useState("");
  const [editZip, setEditZip] = useState("");
  const [error, setError] = useState("");

  const addLocation = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    const result = await db.createLocation(newName.trim(), {
      street: newStreet.trim(), city: newCity.trim(), state: newState.trim(), zip: newZip.trim(),
    });
    setAdding(false);
    if (!result) { setError("Could not add — that location may already exist."); return; }
    setError(""); setNewName(""); setNewStreet(""); setNewCity(""); setNewState(""); setNewZip(""); onRefresh();
  };
  const startEdit = (loc) => {
    setEditId(loc.id); setEditName(loc.name);
    setEditStreet(loc.street ?? ""); setEditCity(loc.city ?? ""); setEditState(loc.state ?? ""); setEditZip(loc.zip ?? "");
    setError("");
  };
  const saveEdit = async () => {
    if (!editName.trim()) return;
    const ok = await db.updateLocation(editId, editName.trim(), {
      street: editStreet.trim(), city: editCity.trim(), state: editState.trim(), zip: editZip.trim(),
    });
    if (!ok) { setError("Could not save — that location may already exist."); return; }
    setError(""); setEditId(null); onRefresh();
  };
  const removeLocation = async (loc) => {
    if (!confirm(`Remove "${loc.name}" from the locations list? Teams already using it keep their venue text — this just removes it from the dropdown.`)) return;
    const ok = await db.deleteLocation(loc.id);
    if (!ok) { setError("Could not remove location."); return; }
    setError(""); onRefresh();
  };

  return (
    <>
      <SectionHeader title={`Locations (${locations.length})`} />
      <div className="card">
        <div className="field"><Label>Location Name</Label>
          <input className="input" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. Corner Pocket Billiards"
            onKeyDown={e=>{ if (e.key==="Enter") addLocation(); }} />
        </div>
        <div className="field"><Label>Street Address</Label>
          <input className="input" value={newStreet} onChange={e=>setNewStreet(e.target.value)} placeholder="e.g. 123 Main St"
            onKeyDown={e=>{ if (e.key==="Enter") addLocation(); }} />
        </div>
        <div style={{display:"flex",gap:8}}>
          <div className="field" style={{flex:2}}><Label>City</Label>
            <input className="input" value={newCity} onChange={e=>setNewCity(e.target.value)} placeholder="City"
              onKeyDown={e=>{ if (e.key==="Enter") addLocation(); }} />
          </div>
          <div className="field" style={{flex:1}}><Label>State</Label>
            <input className="input" value={newState} onChange={e=>setNewState(e.target.value)} placeholder="State"
              onKeyDown={e=>{ if (e.key==="Enter") addLocation(); }} />
          </div>
          <div className="field" style={{flex:1}}><Label>Zip</Label>
            <input className="input" value={newZip} onChange={e=>setNewZip(e.target.value)} placeholder="Zip"
              onKeyDown={e=>{ if (e.key==="Enter") addLocation(); }} />
          </div>
        </div>
        <button className="btn-primary" onClick={addLocation} disabled={!newName.trim()||adding}><Plus size={13}/> {adding?"Adding…":"Add Location"}</button>
        {error && <ErrorMsg>{error}</ErrorMsg>}
      </div>
      {locations.length===0
        ? <div className="empty-state">No locations yet. Add one above.</div>
        : (
          <div className="list">
            {locations.map(loc => (
              <div key={loc.id} className="list-row">
                {editId===loc.id ? (
                  <div className="list-row__edit" style={{flexDirection:"column",alignItems:"stretch",gap:8}}>
                    <input className="edit-input" value={editName} onChange={e=>setEditName(e.target.value)} placeholder="Location name"
                      onKeyDown={e=>{ if (e.key==="Enter") saveEdit(); }} />
                    <input className="edit-input" value={editStreet} onChange={e=>setEditStreet(e.target.value)} placeholder="Street address"
                      onKeyDown={e=>{ if (e.key==="Enter") saveEdit(); }} />
                    <div style={{display:"flex",gap:6}}>
                      <input className="edit-input" style={{flex:2}} value={editCity} onChange={e=>setEditCity(e.target.value)} placeholder="City"
                        onKeyDown={e=>{ if (e.key==="Enter") saveEdit(); }} />
                      <input className="edit-input" style={{flex:1}} value={editState} onChange={e=>setEditState(e.target.value)} placeholder="State"
                        onKeyDown={e=>{ if (e.key==="Enter") saveEdit(); }} />
                      <input className="edit-input" style={{flex:1}} value={editZip} onChange={e=>setEditZip(e.target.value)} placeholder="Zip"
                        onKeyDown={e=>{ if (e.key==="Enter") saveEdit(); }} />
                    </div>
                    <div className="list-row__edit-actions" style={{justifyContent:"flex-end"}}>
                      <button className="btn-icon btn-icon--confirm" onClick={saveEdit}><Check size={14}/></button>
                      <button className="btn-icon btn-icon--cancel" onClick={()=>setEditId(null)}><X size={14}/></button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="list-row__body">
                      <div style={{flex:1}}>
                        <div className="list-row__name">{loc.name}</div>
                        {formatAddress(loc) && <div className="list-row__sub">{formatAddress(loc)}</div>}
                      </div>
                    </div>
                    <div className="list-row__actions">
                      <button className="btn-icon" onClick={()=>startEdit(loc)}><Edit2 size={13}/></button>
                      <button className="btn-icon btn-icon--danger" onClick={()=>removeLocation(loc)}><Trash2 size={13}/></button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
    </>
  );
}


// ─── Teams Tab ────────────────────────────────────────────────────────────────
function TeamsTab({ teams, onSave, onDeleteTeam, readOnly, onNext, hideReadOnlyBanner, captainsByTeam, locations, onAssignCaptain, onRemoveCaptain, onGenerateCaptainInvite }) {
  const [pasteMode, setPasteMode] = useState(!readOnly && teams.length===0);
  const [raw, setRaw]       = useState("");
  const [parsed, setParsed] = useState([]);
  const [parseErr, setParseErr] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [saved, setSaved]   = useState(false);
  const [byeAutoAdded, setByeAutoAdded] = useState(false);
  // Only ever fetched in the manager-editable context (never on the
  // read-only Team & Player Information view) -- keeps the full profile
  // list (names, phone numbers) from being pulled for roles that don't
  // need it.
  const [allProfiles, setAllProfiles] = useState(null);
  useEffect(() => { if (!readOnly && onAssignCaptain) db.listProfiles().then(setAllProfiles); }, [readOnly]);

  const handleParse  = () => {
    const r = parseTeams(raw);
    if (!r.length) { setParseErr("No valid rows."); return; }
    // Odd number of teams means someone would have no opponent -- auto-add a
    // BYE team so pairings always work out. The next number is scoped to THIS
    // division specifically -- combining its existing saved teams with the
    // freshly pasted ones (in case this paste doesn't represent every team
    // already on file), never numbers from any other division.
    const isOdd = r.length % 2 === 1;
    const finalTeams = isOdd
      ? [...r, { teamNum: nextTeamNumber([...teams, ...r]), name: "BYE - No Match", venue: "", isBye: true }]
      : r;
    setByeAutoAdded(isOdd);
    setParseErr(""); setParsed(finalTeams);
  };
  const handleImport = async () => {
    if (!onSave) { setParseErr("No division selected. Add a division to this season first (Season tab → expand season → add division)."); return; }
    const ok = await onSave(parsed);
    if (ok === false) { setParseErr("Could not save — check for duplicate team numbers within this division."); return; }
    setPasteMode(false); setSaved(true); setTimeout(()=>setSaved(false),2000);
  };
  const saveEdit = async () => {
    const ok = await onSave(teams.map(t=>t.id===editId?{...editData}:t));
    if (ok === false) { alert("Could not save — that team number may already be in use in this division."); return; }
    setEditId(null);
  };
  const deleteTeam = async (teamId) => { if (onDeleteTeam) await onDeleteTeam(teamId); };

  return (
    <>
      <SectionHeader title={`Teams (${teams.length})`} action={!readOnly&&teams.length>0?(pasteMode?"Cancel":"Re-import"):null} onAction={()=>setPasteMode(v=>!v)}/>
      {readOnly && !hideReadOnlyBanner && <div className="readonly-bar">Read-only</div>}
      {!readOnly && (pasteMode||!teams.length) && (
        <PasteImporter label="Paste team list" hint="ID ⇥ Team Name ⇥ Venue — one per line"
          raw={raw} setRaw={setRaw} onParse={handleParse} parseErr={parseErr}
          onClear={()=>{setRaw("");setParsed([]);setParseErr("");setByeAutoAdded(false);}}
          preview={parsed.length>0&&(<>
            {byeAutoAdded && <div className="import-warning-block__hint" style={{marginBottom:6}}>Odd number of teams — a BYE team (#{parsed[parsed.length-1].teamNum}) was added automatically.</div>}
            <PreviewList rows={parsed.map(t=>({id:t.teamNum,name:t.name+(t.isBye?" (BYE)":""),sub:t.venue}))}/>
          </>)}
          onImport={parsed.length?handleImport:null} importLabel={`Import ${parsed.length} teams`} saved={saved}/>
      )}
      {(!pasteMode||readOnly) && teams.length>0 && (        <div className="list">
          {teams.map(team=>(
            <div key={team.id} className="list-row">
              {!readOnly && editId===team.id ? (
                <div className="list-row__edit" style={{flexDirection:"column",alignItems:"stretch",gap:8}}>
                  <div style={{display:"flex",gap:6}}>
                    <input className="edit-input" style={{maxWidth:70}} value={editData.teamNum} onChange={e=>setEditData(d=>({...d,teamNum:e.target.value}))}/>
                    <input className="edit-input" style={{flex:1}} value={editData.name} onChange={e=>setEditData(d=>({...d,name:e.target.value}))}/>
                  </div>
                  <select className="edit-input edit-input--sub" value={editData.venue} onChange={e=>setEditData(d=>({...d,venue:e.target.value}))}>
                    <option value="">No venue</option>
                    {editData.venue && !locations?.some(l=>l.name===editData.venue) && <option value={editData.venue}>{editData.venue} (not in list)</option>}
                    {locations?.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
                  </select>
                  {!team.isBye && onAssignCaptain && (
                    <CaptainField team={team} allProfiles={allProfiles}
                      onAssign={(newId, prevId)=>onAssignCaptain(team.id, newId, prevId)}
                      onRemove={onRemoveCaptain}
                      onGenerateInvite={(name)=>onGenerateCaptainInvite(team.id, name)}
                      onRefreshProfiles={()=>db.listProfiles().then(setAllProfiles)} />
                  )}
                  <div className="list-row__edit-actions" style={{justifyContent:"flex-end"}}>
                    <button className="btn-icon btn-icon--confirm" onClick={saveEdit}><Check size={14}/></button>
                    <button className="btn-icon btn-icon--cancel"  onClick={()=>setEditId(null)}><X size={14}/></button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="list-row__body">
                    <span className="list-row__id">{team.teamNum}</span>
                    <div style={{display:"flex",flexDirection:"column",gap:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span className="list-row__name">{team.name}</span>
                        {team.isBye && <span className="week-special-badge">BYE</span>}
                      </div>
                      <span className="list-row__sub">{team.venue}</span>
                      {!team.isBye && (() => {
                        const cap = captainsByTeam?.[team.id];
                        return (
                          <span className="list-row__sub" style={{color: cap ? "#9A9A9A" : "#6A6A6A", fontStyle: cap ? "normal" : "italic"}}>
                            {cap ? `Captain: @${cap.username}${cap.phone ? ` · ${cap.phone}` : ""}` : "Captain TBD"}
                          </span>
                        );
                      })()}
                      {!team.isBye && team.rosterSubmittedAt && (
                        <span className="list-row__sub" style={{color:"#5FCF9E"}}>Roster submitted {new Date(team.rosterSubmittedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  {!readOnly && (
                    <div className="list-row__actions">
                      <button className="btn-icon" onClick={()=>{setEditId(team.id);setEditData({...team});}}><Edit2 size={13}/></button>
                      <button className="btn-icon btn-icon--danger" onClick={()=>deleteTeam(team.id)}><Trash2 size={13}/></button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {!readOnly && teams.length>0 && teams.length<2 && (
        <div className="readonly-bar">Import at least 2 teams to continue to Schedule</div>
      )}
      {!readOnly && teams.length>=2 && <button className="btn-next" onClick={onNext}>Next: Import Schedule <ChevronRight size={14}/></button>}
    </>
  );
}

// Lets a manager either assign an existing account as a team's captain, or
// generate an invite code for someone who doesn't have one yet. There's no
// separate "captains" table -- a captain IS just a profile with
// role='captain' and team_id pointing here, so this reads/writes profiles
// directly. Assigning a new captain over an existing one hands off in one
// action (demotes the outgoing captain) so a team never ends up with two
// captains because a manager forgot a manual cleanup step.
function CaptainField({ team, allProfiles, onAssign, onRemove, onGenerateInvite, onRefreshProfiles }) {
  const [mode, setMode] = useState("existing"); // "existing" | "invite"
  const [search, setSearch] = useState("");
  const [pickedId, setPickedId] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [generated, setGenerated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  if (!allProfiles) return <div style={{fontSize:11,color:"#6A6A6A"}}>Loading captain options…</div>;

  const currentCaptain = allProfiles.find(p => p.role === "captain" && p.team_id === team.id) ?? null;
  const candidates = allProfiles
    .filter(p => p.is_active !== false && p.id !== currentCaptain?.id)
    .sort((a,b) => (a.username||"").localeCompare(b.username||""));
  const labelFor = (p) => `@${p.username}${p.role==="captain" && p.team_id ? " (captain elsewhere)" : p.role==="manager" ? " (manager)" : ""}`;

  const assignExisting = async () => {
    const picked = candidates.find(p => p.id === pickedId);
    if (!picked) { setErr("Pick a valid account from the list."); return; }
    if (picked.role === "captain" && picked.team_id && picked.team_id !== team.id) {
      if (!confirm(`@${picked.username} already captains another team. Reassign them to ${team.name}?`)) return;
    }
    setSaving(true); setErr("");
    const ok = await onAssign(picked.id, currentCaptain?.id ?? null);
    setSaving(false);
    if (!ok) { setErr("Could not assign captain."); return; }
    setSearch(""); setPickedId(""); onRefreshProfiles();
  };
  const removeCaptain = async () => {
    if (!currentCaptain) return;
    if (!confirm(`Remove @${currentCaptain.username} as captain of ${team.name}?`)) return;
    setSaving(true); setErr("");
    const ok = await onRemove(currentCaptain.id);
    setSaving(false);
    if (!ok) { setErr("Could not remove captain."); return; }
    onRefreshProfiles();
  };
  const generateInvite = async () => {
    setSaving(true); setErr("");
    const code = await onGenerateInvite(inviteName.trim());
    setSaving(false);
    if (!code) { setErr("Could not generate code."); return; }
    setGenerated(code);
  };
  const copyCode = () => { navigator.clipboard?.writeText(generated.code).catch(()=>{}); setCopied(true); setTimeout(()=>setCopied(false),2000); };

  return (
    <div className="field" style={{margin:0}}>
      <Label>Captain</Label>
      {currentCaptain && (
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <span className="user-team-label">@{currentCaptain.username}{currentCaptain.phone_number?` · ${currentCaptain.phone_number}`:""}</span>
          <button className="btn-icon btn-icon--danger" onClick={removeCaptain} title="Remove captain"><X size={12}/></button>
        </div>
      )}
      <div className="seg-control" style={{marginBottom:6}}>
        <button className={`seg-btn ${mode==="existing"?"seg-btn--active":""}`} onClick={()=>{setMode("existing");setErr("");}}>
          {currentCaptain?"Reassign":"Assign Existing"}
        </button>
        <button className={`seg-btn ${mode==="invite"?"seg-btn--active":""}`} onClick={()=>{setMode("invite");setErr("");}}>Invite New Captain</button>
      </div>
      {mode==="existing" ? (
        <div style={{display:"flex",gap:6}}>
          <input className="edit-input" style={{flex:1}} list={`captain-options-${team.id}`} value={search} autoComplete="off"
            placeholder="Start typing a username…"
            onChange={e=>{
              const val = e.target.value; setSearch(val);
              const match = candidates.find(p => labelFor(p) === val);
              setPickedId(match ? match.id : "");
            }} />
          <datalist id={`captain-options-${team.id}`}>
            {candidates.map(p => <option key={p.id} value={labelFor(p)} />)}
          </datalist>
          <button className="btn-icon btn-icon--confirm" onClick={assignExisting} disabled={!pickedId||saving}><Check size={13}/></button>
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          <input className="edit-input" placeholder="Captain's name (for your reference)" value={inviteName} onChange={e=>setInviteName(e.target.value)} />
          <button className="btn-sm btn-sm--accent" onClick={generateInvite} disabled={saving} style={{alignSelf:"flex-start"}}>
            <Key size={12}/> Generate Invite Code
          </button>
          {generated && (
            <div className="generated-code-block">
              <div className="generated-code-block__label">Share this — expires in 7 days</div>
              <div className="generated-code-block__row">
                <span className="generated-code-block__code">{generated.code}</span>
                <button className="btn-copy" onClick={copyCode}>{copied?<Check size={13}/>:<Copy size={13}/>}{copied?"Copied":"Copy"}</button>
              </div>
            </div>
          )}
        </div>
      )}
      {err && <ErrorMsg>{err}</ErrorMsg>}
    </div>
  );
}

// ─── Schedule Tab ─────────────────────────────────────────────────────────────
function ScheduleTab({ schedule, teams, onSave, onAddPairing, onUpdatePairing, onDeletePairing, readOnly, onNext, hideReadOnlyBanner }) {
  const [pasteMode, setPasteMode] = useState(!readOnly&&schedule.length===0);
  const [raw, setRaw]     = useState("");
  const [parsed, setParsed]   = useState([]);
  const [parseErr, setParseErr] = useState("");
  const [saved, setSaved]   = useState(false);
  const [expanded, setExpanded] = useState(null);
  const teamByIndex = (n) => teams[n-1]??null;
  const sortedTeams = [...teams].sort((a,b)=>a.name.localeCompare(b.name));

  const handleParse  = () => { const r=parseSchedule(raw); if(!r.length){setParseErr("No weeks found.");return;} setParseErr("");setParsed(r); };
  const handleImport = async () => {
    if (!onSave) { setParseErr("No division selected. Add a division to this season first (Season tab → expand season → add division)."); return; }
    await onSave(parsed); setPasteMode(false); setSaved(true); setTimeout(()=>setSaved(false),2000);
  };

  return (
    <>
      <SectionHeader title={`Schedule (${schedule.length} weeks)`} action={!readOnly&&schedule.length>0?(pasteMode?"Cancel":"Re-import"):null} onAction={()=>setPasteMode(v=>!v)}/>
      {readOnly && !hideReadOnlyBanner && <div className="readonly-bar">Read-only</div>}
      {!readOnly && (pasteMode||!schedule.length) && (
        <PasteImporter label="Paste schedule" hint="Week# ⇥ Date, then pairing line: 1vs2  3vs4 …"
          raw={raw} setRaw={setRaw} onParse={handleParse} parseErr={parseErr}
          onClear={()=>{setRaw("");setParsed([]);setParseErr("");}}
          preview={parsed.length>0&&<PreviewList rows={parsed.map(w=>({id:w.week?`Wk ${w.week}`:"—",name:w.date,sub:w.special??`${w.pairings.length} matches`}))}/>}
          onImport={parsed.length?handleImport:null} importLabel={`Import ${parsed.length} weeks`} saved={saved}/>
      )}
      {(!pasteMode||readOnly) && schedule.length>0 && (
        <div className="list">
          {schedule.map((week,i)=>{
            const isExpanded=expanded===i, isSpecial=!!week.special&&!week.pairings.length;
            return (
              <div key={i} className={`list-row ${isSpecial?"list-row--special":""}`}>
                <div className="list-row__week-header" onClick={()=>!isSpecial&&setExpanded(isExpanded?null:i)}>
                  <div className="list-row__body">
                    <span className="list-row__id">{week.week?`Wk ${week.week}`:"—"}</span>
                    <span className="list-row__name">{week.date}</span>
                    {week.isPlayoff && week.playoffLabel && <span className="week-special-badge" style={{color:"#F59E0B"}}>{week.playoffLabel}</span>}
                    {!week.isPlayoff && week.special?<span className="week-special-badge">{week.special}</span>:null}
                    {!week.isPlayoff && !week.special && <span className="list-row__sub">{week.pairings.length} matches</span>}
                  </div>
                  {!isSpecial&&(isExpanded?<ChevronUp size={14} color="#9A9A9A"/>:<ChevronDown size={14} color="#9A9A9A"/>)}
                </div>
                {isExpanded&&(
                  <div className="week-pairings">
                    {week.pairings.map((p,j)=>(
                      <PairingRow key={p.id ?? j} pairing={p} teamByIndex={teamByIndex} sortedTeams={sortedTeams}
                        readOnly={readOnly} onUpdatePairing={onUpdatePairing} onDeletePairing={onDeletePairing}/>
                    ))}
                    {!readOnly && onAddPairing && (
                      <AddPairingRow weekId={week.id} sortedTeams={sortedTeams} onAddPairing={onAddPairing}/>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!readOnly && schedule.length>0 && <button className="btn-next" onClick={onNext}>Next: Import Players <ChevronRight size={14}/></button>}
    </>
  );
}

function PairingRow({ pairing: p, teamByIndex, sortedTeams, readOnly, onUpdatePairing, onDeletePairing }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [homeId, setHomeId] = useState(p.homeTeamId ?? "");
  const [awayId, setAwayId] = useState(p.awayTeamId ?? "");
  const home = teamByIndex(p.home), away = teamByIndex(p.away);
  const isBye = !!(home?.isBye || away?.isBye);

  const startEdit = () => { setHomeId(p.homeTeamId ?? ""); setAwayId(p.awayTeamId ?? ""); setEditing(true); };
  const save = async () => {
    if (!homeId || !awayId || !p.id) { setEditing(false); return; }
    await onUpdatePairing(p.id, homeId, awayId);
    setEditing(false);
  };
  const remove = async () => { if (p.id) await onDeletePairing(p.id); };

  if (editing) {
    return (
      <div className="pairing-row pairing-row--edit">
        <select className="input input--select edit-input" value={homeId} onChange={e=>setHomeId(e.target.value)}>
          <option value="">Home team…</option>
          {sortedTeams.map(t=><option key={t.id} value={t.id}>{t.name}{t.isBye?" (BYE)":""}</option>)}
        </select>
        <select className="input input--select edit-input" value={awayId} onChange={e=>setAwayId(e.target.value)}>
          <option value="">Away team…</option>
          {sortedTeams.map(t=><option key={t.id} value={t.id}>{t.name}{t.isBye?" (BYE)":""}</option>)}
        </select>
        <div className="list-row__edit-actions">
          <button className="btn-icon btn-icon--confirm" onClick={save} disabled={!homeId||!awayId}><Check size={14}/></button>
          <button className="btn-icon btn-icon--cancel" onClick={()=>setEditing(false)}><X size={14}/></button>
        </div>
      </div>
    );
  }

  if (isBye) {
    const byeTeam = home?.isBye ? away : home;
    return (
      <div className="pairing-row" style={{gridTemplateColumns:"1fr auto auto"}}>
        <span className="pairing-name pairing-name--link" style={{color:"#9A9A9A"}} onClick={()=>byeTeam && navigate(`/team-lookup?team=${byeTeam.id}`)}>{byeTeam?.name ?? "—"}</span>
        <span className="week-special-badge">BYE</span>
        {!readOnly && onUpdatePairing && (
          <div className="list-row__edit-actions">
            <button className="btn-icon" onClick={startEdit}><Edit2 size={11}/></button>
            <button className="btn-icon btn-icon--danger" onClick={remove}><Trash2 size={11}/></button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="pairing-row" style={{gridTemplateColumns:"22px 1fr auto 1fr 22px auto"}}>
      <span className="pairing-idx">{p.home}</span>
      <span className="pairing-name pairing-name--home pairing-name--link" onClick={()=>home && navigate(`/team-lookup?team=${home.id}`)}>{home?.name??`Team ${p.home}`}</span>
      <span className="pairing-vs">vs</span>
      <span className="pairing-name pairing-name--away pairing-name--link" onClick={()=>away && navigate(`/team-lookup?team=${away.id}`)}>{away?.name??`Team ${p.away}`}</span>
      <span className="pairing-idx">{p.away}</span>
      {!readOnly && onUpdatePairing && (
        <div className="list-row__edit-actions">
          <button className="btn-icon" onClick={startEdit}><Edit2 size={11}/></button>
          <button className="btn-icon btn-icon--danger" onClick={remove}><Trash2 size={11}/></button>
        </div>
      )}
    </div>
  );
}

function AddPairingRow({ weekId, sortedTeams, onAddPairing }) {
  const [adding, setAdding] = useState(false);
  const [homeId, setHomeId] = useState("");
  const [awayId, setAwayId] = useState("");

  const confirm = async () => {
    if (!homeId || !awayId || !weekId) return;
    await onAddPairing(weekId, homeId, awayId);
    setHomeId(""); setAwayId(""); setAdding(false);
  };

  if (!adding) {
    return <button className="btn-sm" onClick={()=>setAdding(true)} style={{marginTop:4}}><Plus size={12}/> Add Pairing</button>;
  }
  return (
    <div className="pairing-row pairing-row--edit">
      <select className="input input--select edit-input" value={homeId} onChange={e=>setHomeId(e.target.value)}>
        <option value="">Home team…</option>
        {sortedTeams.map(t=><option key={t.id} value={t.id}>{t.name}{t.isBye?" (BYE)":""}</option>)}
      </select>
      <select className="input input--select edit-input" value={awayId} onChange={e=>setAwayId(e.target.value)}>
        <option value="">Away team…</option>
        {sortedTeams.map(t=><option key={t.id} value={t.id}>{t.name}{t.isBye?" (BYE)":""}</option>)}
      </select>
      <div className="list-row__edit-actions">
        <button className="btn-icon btn-icon--confirm" onClick={confirm} disabled={!homeId||!awayId}><Check size={14}/></button>
        <button className="btn-icon btn-icon--cancel" onClick={()=>{setAdding(false);setHomeId("");setAwayId("");}}><X size={14}/></button>
      </div>
    </div>
  );
}

// ─── Players Tab ──────────────────────────────────────────────────────────────
function PlayersTab({ teams, rosters, schedule, eligByNum, onBulkImport, onManualRating, onMovePlayer, lockedTeamId, readOnly, hideReadOnlyBanner, divisionId, onReconciled }) {
  const [pasteMode, setPasteMode] = useState(false);
  const [raw, setRaw]           = useState("");
  const [parsed, setParsed]     = useState(null);
  const [parseErr, setParseErr] = useState("");
  const [saved, setSaved]       = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [ambiguousOverrides, setAmbiguousOverrides] = useState({});
  const [crossDivisionView, setCrossDivisionView] = useState(null); // { teams, rosters } across every division touched by the last import

  const parseBulk = () => {
    const result = parseLeagueRoster(raw);
    if (Object.keys(result.rosters).length === 0) {
      setParseErr("No teams found. Try these steps: 1) Open the PDF directly in your browser (not a PDF app). 2) Select All (⌘A or Ctrl+A). 3) Copy & paste here. The text must include the \"Division Roster and Handicap Report\" header & \"Team NNNNN\" lines to parse correctly.");
      return;
    }
    if (Object.keys(result.registry).length === 0) {
      setParseErr("Teams were found but no player data could be extracted. The text may be incomplete — make sure you copied the full page including all player rows.");
      return;
    }
    setParseErr(""); setParsed(result);
    const defaults = {};
    (result.ambiguousRoster ?? []).forEach(a => { defaults[a.num] = a.guessedTeamId; });
    setAmbiguousOverrides(defaults);
  };

  const handleBulkImport = async () => {
    if (!parsed) return;
    if (!onBulkImport) { setParseErr("No division selected. Add a division to this season first (Season tab → expand season → add division)."); return; }

    const finalRosters = {};
    for (const [tid, nums] of Object.entries(parsed.rosters)) finalRosters[tid] = [...nums];
    for (const a of parsed.ambiguousRoster ?? []) {
      const chosen = ambiguousOverrides[a.num] ?? a.guessedTeamId;
      if (chosen === a.guessedTeamId) continue;
      finalRosters[a.guessedTeamId] = (finalRosters[a.guessedTeamId] ?? []).filter(n => n !== a.num);
      finalRosters[chosen] = finalRosters[chosen] ?? [];
      if (!finalRosters[chosen].includes(a.num)) finalRosters[chosen].push(a.num);
    }
    const finalParsed = { ...parsed, rosters: finalRosters };

    const result = await onBulkImport(finalParsed);
    setImportResult(result);
    setSaved(true); setTimeout(()=>setSaved(false),1800);
    setPasteMode(false); setRaw(""); setParsed(null); setAmbiguousOverrides({});

    // The import itself already writes to every division the pasted report
    // touched (see db.bulkImportPlayers) -- pull that same set of teams back
    // so the roster/ratings view below reflects all of it, not just whatever
    // single division happens to be selected above. touchedNums are the raw
    // team numbers from the pasted report -- resolve to real team ids first,
    // since numbers alone aren't unique across divisions/seasons.
    const touchedNums = Object.keys(finalRosters);
    const allTeams = await db.listAllTeamsWithContext();
    const crossTeams = allTeams.filter(t => touchedNums.includes(t.teamNum));
    const crossRosters = await db.listRostersForTeams(crossTeams.map(t => t.id));
    setCrossDivisionView({ teams: crossTeams, rosters: crossRosters });
  };

  const cancelImport = () => { setPasteMode(false); setRaw(""); setParsed(null); setParseErr(""); setAmbiguousOverrides({}); };

  const bulkTeamList = parsed
    ? Object.entries(parsed.rosters).map(([tid, nums]) => {
        const t = teams.find(x => x.teamNum === tid);
        const parsedTeam = parsed.teams?.[tid];
        const label = t?.name ?? parsedTeam?.name ?? `Team ${tid}`;
        const byeTag = parsedTeam?.isBye ? " (BYE)" : "";
        return { id: tid, name: `${label}${byeTag}`, sub: `${nums.length} players` };
      })
    : [];

  return (
    <>
      <SectionHeader title="Player Rosters"/>
      {readOnly && !hideReadOnlyBanner && <div className="readonly-bar">Read-only</div>}
      {teams.length===0
        ? <div className="empty-state">Import teams first.</div>
        : <>
          {!readOnly && !lockedTeamId && (
            <div className="card">
              <div className="card__title">Weekly Bulk Import</div>
              <div style={{fontSize:12,color:"#9A9A9A",lineHeight:1.5}}>
                Open the IBA roster PDF, select all the text (or copy it from the page), & paste it below each week to update every player's rating & roster at once. Teams belonging to other divisions in this season are automatically routed to their own division.
              </div>

              {!pasteMode && !importResult && (
                <button className="btn-primary" onClick={()=>{setPasteMode(true);setRaw("");setParsed(null);setParseErr("");setImportResult(null);setCrossDivisionView(null);}}>
                  Paste League Roster Report
                </button>
              )}

              {pasteMode && !parsed && (
                <>
                  <textarea className="paste-area" rows={6} value={raw} onChange={e=>setRaw(e.target.value)} placeholder="Paste the full IBA Division Roster Report text here…"/>
                  {parseErr && <ErrorMsg>{parseErr}</ErrorMsg>}
                  <div style={{display:"flex",gap:6}}>
                    <button className="btn-secondary" onClick={parseBulk} disabled={!raw.trim()}>Preview Import</button>
                    {raw.trim() && <button className="btn-secondary btn-secondary--clear" onClick={()=>{setRaw("");setParsed(null);setParseErr("");}}>Clear</button>}
                    <button className="btn-sm" onClick={cancelImport}>Cancel</button>
                  </div>
                </>
              )}

              {parseErr && !pasteMode && <ErrorMsg>{parseErr}</ErrorMsg>}

              {bulkTeamList.length > 0 && (
                <>
                  <div style={{fontSize:11,fontWeight:700,color:"#5FCF9E"}}>
                    Found {bulkTeamList.length} teams · {Object.keys(parsed.registry).length} players
                  </div>
                  <PreviewList rows={bulkTeamList}/>

                  {parsed.needsRating?.length > 0 && (
                    <div className="import-warning-block">
                      <div className="import-warning-block__title">
                        <AlertCircle size={12}/> {parsed.needsRating.length} player{parsed.needsRating.length!==1?"s":""} need a rating entered manually
                      </div>
                      <div className="import-warning-block__list">
                        {parsed.needsRating.map((p,i)=>(
                          <div key={i} className="import-warning-block__row">
                            <span>{p.name}{p.nickname?` "${p.nickname}"`:""}</span>
                            <span className="import-warning-block__meta">Team {p.teamId} · #{p.num}</span>
                          </div>
                        ))}
                      </div>
                      <div className="import-warning-block__hint">These players were NOT added to any roster. Set their rating manually below after importing.</div>
                    </div>
                  )}

                  {parsed.ambiguousRoster?.length > 0 && (
                    <div className="import-warning-block import-warning-block--amber">
                      <div className="import-warning-block__title">
                        <AlertCircle size={12}/> {parsed.ambiguousRoster.length} player{parsed.ambiguousRoster.length!==1?"s":""} have an uncertain team assignment
                      </div>
                      <div className="import-warning-block__list">
                        {parsed.ambiguousRoster.map((a,i)=>{
                          const playerName = parsed.registry[a.num] ? `${parsed.registry[a.num].name}${parsed.registry[a.num].nickname?` "${parsed.registry[a.num].nickname}"`:""}` : `Player #${a.num}`;
                          return (
                            <div key={i} className="import-warning-block__row" style={{flexDirection:"column",alignItems:"stretch",gap:4}}>
                              <span>{playerName} <span className="import-warning-block__meta">#{a.num}</span></span>
                              <select className="input input--select edit-input" style={{fontSize:12,padding:"6px 8px"}}
                                value={ambiguousOverrides[a.num] ?? a.guessedTeamId}
                                onChange={e=>setAmbiguousOverrides(o=>({...o, [a.num]: e.target.value}))}>
                                {a.candidateTeamIds.map(tid => (
                                  <option key={tid} value={tid}>
                                    Team {tid}{parsed.teams?.[tid]?.name ? ` · ${parsed.teams[tid].name}` : ""}{tid===a.guessedTeamId ? " (guessed)" : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                      <div className="import-warning-block__hint">Ratings for these players are correct — confirm or change which team they're actually on before importing.</div>
                    </div>
                  )}

                  {parseErr && <ErrorMsg>{parseErr}</ErrorMsg>}
                  <div style={{display:"flex",gap:6}}>
                    <button className="btn-primary" onClick={handleBulkImport}>
                      {saved ? <><Check size={13}/> Saved!</> : `Import All ${bulkTeamList.length} Teams`}
                    </button>
                    <button className="btn-sm" onClick={cancelImport}>Cancel</button>
                  </div>
                </>
              )}

              {importResult && (
                <div className="import-warning-block" style={{background:"#0F2D1F",borderColor:"#1F6B4A"}}>
                  <div className="import-warning-block__title" style={{color:"#5FCF9E"}}>
                    <Check size={12}/> Tagged as {importResult.weekTag?.label}
                  </div>
                  {importResult.updatedDivisions.length > 0 && (
                    <div style={{fontSize:11,color:"#E0E0E0"}}>
                      Updated {importResult.updatedDivisions.length} division{importResult.updatedDivisions.length!==1?"s":""} ({importResult.updatedDivisions.reduce((s,d)=>s+d.teamCount,0)} teams total).
                    </div>
                  )}
                  {importResult.unmatchedTeams?.length > 0 && (
                    <div className="import-warning-block" style={{marginTop:0}}>
                      <div className="import-warning-block__title">
                        <AlertCircle size={12}/> {importResult.unmatchedTeams.length} team number{importResult.unmatchedTeams.length!==1?"s":""} from the report didn't match an existing team
                      </div>
                      <div className="import-warning-block__hint">Their players & ratings were already saved above — this just fixes which team's roster they belong to.</div>
                      <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:6}}>
                        {importResult.unmatchedTeams.map(u => (
                          <UnmatchedTeamRow key={u.teamNum} unmatched={u} divisionId={divisionId} existingTeams={teams}
                            onResolved={() => {
                              setImportResult(r => ({ ...r, unmatchedTeams: r.unmatchedTeams.filter(x => x.teamNum !== u.teamNum) }));
                              onReconciled?.();
                            }} />
                        ))}
                      </div>
                    </div>
                  )}
                  {importResult.ambiguousTeamIds?.length > 0 && (
                    <div style={{fontSize:11,color:"#F87171"}}>
                      Team number{importResult.ambiguousTeamIds.length!==1?"s":""} {importResult.ambiguousTeamIds.join(", ")} matched more than one active team across divisions — skipped rather than guessed. Deactivate the season that no longer needs it, or re-import from within that specific division.
                    </div>
                  )}
                  <button className="btn-sm" onClick={()=>{setImportResult(null);setCrossDivisionView(null);}}>Dismiss</button>
                </div>
              )}

              {crossDivisionView && crossDivisionView.teams.length > 0 && (
                <RosterRatingsCard
                  title={`Imported Rosters & Ratings — ${crossDivisionView.teams.length} team${crossDivisionView.teams.length!==1?"s":""} across every division touched`}
                  teams={crossDivisionView.teams} rosters={crossDivisionView.rosters} schedule={schedule} eligByNum={eligByNum}
                  onManualRating={null} onMovePlayer={null} lockedTeamId={null} readOnly />
              )}
            </div>
          )}

          {!pasteMode && (
            <RosterRatingsCard teams={teams} rosters={rosters} schedule={schedule} eligByNum={eligByNum}
              onManualRating={onManualRating} onMovePlayer={onMovePlayer} lockedTeamId={lockedTeamId} readOnly={readOnly} />
          )}
        </>
      }
    </>
  );
}

// ─── Unmatched team reconciliation ─────────────────────────────────────────
// One row per team number from a bulk import that didn't match an existing
// team. Its players/ratings are already saved (bulkImportPlayers does that
// regardless of team match) -- this only fixes the roster LINKAGE, either
// by creating the missing team outright or by routing it to an existing
// team the manager picks (the typo/renumbering case). Either path succeeds
// without needing the report re-pasted.
function UnmatchedTeamRow({ unmatched, divisionId, existingTeams, onResolved }) {
  const [mode, setMode] = useState(null); // null | "existing"
  const [pickedTeamId, setPickedTeamId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const createAsNew = async () => {
    if (!divisionId) { setErr("No division selected — pick a division above first."); return; }
    setSaving(true); setErr("");
    const ok = await db.reconcileUnmatchedTeamAsNew(divisionId, unmatched.teamNum, unmatched.teamName, unmatched.playerNums);
    setSaving(false);
    if (!ok) { setErr("Could not create this team — that number may already be in use in this division."); return; }
    onResolved();
  };
  const mapToExisting = async () => {
    if (!pickedTeamId) return;
    setSaving(true); setErr("");
    const ok = await db.reconcileUnmatchedTeamToExisting(pickedTeamId, unmatched.playerNums);
    setSaving(false);
    if (!ok) { setErr("Could not update that team's roster."); return; }
    onResolved();
  };

  return (
    <div className="import-warning-block__row" style={{flexDirection:"column",alignItems:"stretch",gap:6}}>
      <span>
        Team {unmatched.teamNum}{unmatched.teamName ? ` — "${unmatched.teamName}"` : ""}
        <span className="import-warning-block__meta"> · {unmatched.playerNums.length} player{unmatched.playerNums.length!==1?"s":""}</span>
      </span>
      {mode !== "existing" ? (
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <button className="btn-sm btn-sm--accent" onClick={createAsNew} disabled={saving}>{saving?"Creating…":"Create as New Team"}</button>
          <button className="btn-sm" onClick={()=>setMode("existing")} disabled={saving}>Map to Existing Team…</button>
        </div>
      ) : (
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <select className="input input--select edit-input" style={{fontSize:12,padding:"6px 8px",flex:1}} value={pickedTeamId} onChange={e=>setPickedTeamId(e.target.value)}>
            <option value="">Select a team…</option>
            {existingTeams.filter(t=>!t.isBye).map(t => <option key={t.id} value={t.id}>{t.name} (#{t.teamNum})</option>)}
          </select>
          <button className="btn-icon btn-icon--confirm" onClick={mapToExisting} disabled={!pickedTeamId||saving}><Check size={13}/></button>
          <button className="btn-icon btn-icon--cancel" onClick={()=>{setMode(null);setPickedTeamId("");}} disabled={saving}><X size={13}/></button>
        </div>
      )}
      {err && <ErrorMsg>{err}</ErrorMsg>}
    </div>
  );
}

// ─── Roster + rating editor ────────────────────────────────────────────────────
function RosterRatingsCard({ teams, rosters, schedule, eligByNum, onManualRating, onMovePlayer, lockedTeamId, readOnly, title }) {
  const [openTeamId, setOpenTeamId] = useState(null);
  const visibleTeams = lockedTeamId ? teams.filter(t => t.id === lockedTeamId) : teams;
  const weekOptions = scheduleWeekOptions(schedule);
  const defaultTag = currentWeekTag(schedule);

  if (visibleTeams.length === 0) return null;

  return (
    <div className="card">
      <div className="card__title">{title || "Rosters & Ratings"}</div>
      <div className="team-select-list">
        {visibleTeams.map(team => {
          const players = rosters[team.id] ?? [];
          const isOpen = openTeamId === team.id;
          return (
            <div key={team.id}>
              <button className={`team-select-btn ${isOpen?"team-select-btn--active":""}`} onClick={()=>setOpenTeamId(isOpen?null:team.id)}>
                <span className="team-select-name">{team.name}{team.context ? ` · ${team.context}` : ""}</span>
                <span className="team-select-count">{players.length}p</span>
              </button>
              {isOpen && (
                <div className="list" style={{marginTop:6, marginBottom:6}}>
                  {players.length === 0 && <div className="empty-state" style={{border:"none"}}>No players on this roster yet.</div>}
                  {players.map(player => (
                    <PlayerRatingRow key={player.num} player={player}
                      weekOptions={weekOptions} defaultTag={defaultTag}
                      onManualRating={onManualRating}
                      currentTeamId={team.id} allTeams={teams} onMovePlayer={onMovePlayer}
                      eligibility={eligByNum?.[player.num]} readOnly={readOnly}/>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlayerRatingRow({ player, weekOptions, defaultTag, onManualRating, currentTeamId, allTeams, onMovePlayer, eligibility, readOnly }) {
  const [editing, setEditing] = useState(false);
  const [ratingInput, setRatingInput] = useState("");
  const [weekKey, setWeekKey] = useState(defaultTag.weekKey);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState(null);
  const [moving, setMoving] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");

  if (!player) return null;
  const options = weekOptions.some(w=>w.weekKey===defaultTag.weekKey) ? weekOptions : [...weekOptions, defaultTag];
  const moveTargets = (allTeams ?? []).filter(t => t.id !== currentTeamId && !t.isBye);

  const startEdit = () => { setRatingInput(String(player.rating ?? "")); setWeekKey(defaultTag.weekKey); setEditing(true); };
  const save = async () => {
    const val = parseInt(ratingInput, 10);
    if (isNaN(val)) return;
    const opt = options.find(o=>o.weekKey===weekKey) ?? defaultTag;
    await onManualRating(player.num, opt.weekKey, opt.label, val);
    setEditing(false);
  };
  const startMove = () => { setMoveTarget(moveTargets[0]?.id ?? ""); setMoving(true); };
  const confirmMove = async () => {
    if (!moveTarget) return;
    await onMovePlayer(player.num, currentTeamId, moveTarget);
    setMoving(false);
  };
  const toggleHistory = async () => {
    if (!showHistory && history === null) {
      const rows = await db.listRosterHistory(player.num);
      setHistory(rows);
    }
    setShowHistory(v => !v);
  };

  return (
    <div className="list-row">
      {editing ? (
        <div className="list-row__edit" style={{flexWrap:"wrap"}}>
          <select className="input input--select edit-input" style={{flex:"1 1 140px"}} value={weekKey} onChange={e=>setWeekKey(e.target.value)}>
            {options.map(o=><option key={o.weekKey} value={o.weekKey}>{o.label}</option>)}
          </select>
          <input className="edit-input edit-input--rating" type="number" inputMode="numeric" value={ratingInput} onChange={e=>setRatingInput(e.target.value)} />
          <div className="list-row__edit-actions">
            <button className="btn-icon btn-icon--confirm" onClick={save}><Check size={14}/></button>
            <button className="btn-icon btn-icon--cancel" onClick={()=>setEditing(false)}><X size={14}/></button>
          </div>
        </div>
      ) : moving ? (
        <div className="list-row__edit" style={{flexWrap:"wrap"}}>
          <span style={{fontSize:11.5,color:"#9A9A9A",width:"100%"}}>Move {player.name} to:</span>
          <select className="input input--select edit-input" style={{flex:"1 1 160px"}} value={moveTarget} onChange={e=>setMoveTarget(e.target.value)}>
            {moveTargets.length === 0 && <option value="">No other teams in this division</option>}
            {moveTargets.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="list-row__edit-actions">
            <button className="btn-icon btn-icon--confirm" onClick={confirmMove} disabled={!moveTarget}><Check size={14}/></button>
            <button className="btn-icon btn-icon--cancel" onClick={()=>setMoving(false)}><X size={14}/></button>
          </div>
        </div>
      ) : (
        <>
          <div className="list-row__body" onClick={toggleHistory} style={{cursor:"pointer"}}>
            <div style={{display:"flex",flexDirection:"column",gap:1}}>
              <span className="list-row__name">{player.name}</span>
              {player.nickname && <span className="player-nickname">"{player.nickname}"</span>}
            </div>
          </div>
          <div className="list-row__actions">
            {eligibility && <span className={`elig-badge ${eligibility.code === "E" ? "elig-badge--eligible" : "elig-badge--ineligible"}`} title={db.ELIGIBILITY_REASONS[eligibility.code]}>{eligibility.code}</span>}
            <span className="player-rating-badge">{player.rating ?? "—"}</span>
            {!readOnly && onMovePlayer && <button className="btn-icon" onClick={startMove} title="Move to another team"><ArrowLeftRight size={13}/></button>}
            {!readOnly && onManualRating && <button className="btn-icon" onClick={startEdit}><Edit2 size={13}/></button>}
          </div>
        </>
      )}
      {showHistory && !editing && !moving && history?.length > 0 && (
        <div className="week-pairings" style={{gridColumn:"1 / -1"}}>
          {history.map((h,i) => (
            <div key={i} className="pairing-row" style={{gridTemplateColumns:"1fr auto auto"}}>
              <span className="pairing-name" style={{color:"#9A9A9A",fontWeight:600,fontSize:11}}>{h.label}</span>
              <span className="player-rating-badge" style={{fontSize:11,padding:"2px 8px"}}>{h.rating ?? "—"}</span>
              <span className="code-expiry" style={{color: h.source==="manual" ? "#F59E0B" : "#5FCF9E"}}>{h.source}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RolePill({ role, small }) {
  const r = ROLES[role] ?? ROLES.player;
  return (
    <span className={`role-pill ${small ? "role-pill--sm" : ""}`} style={{ color: r.color, background: r.bg, borderColor: r.border }}>
      {r.label}
    </span>
  );
}
function SectionHeader({ title, action, onAction }) {
  return (
    <div className="section-header">
      <span className="section-header__title">{title}</span>
      {action && <button className="btn-ghost" onClick={onAction}>{action}</button>}
    </div>
  );
}
function PasteImporter({ label, hint, raw, setRaw, onParse, parseErr, preview, onImport, importLabel, saved, onClear, preHint }) {
  return (
    <div className="paste-importer">
      <div className="paste-importer__label">{label}</div>
      {preHint}
      <div className="paste-importer__hint">{hint}</div>
      <textarea className="paste-area" value={raw} onChange={e => setRaw(e.target.value)} placeholder="Paste here…" rows={5} />
      {parseErr && <ErrorMsg>{parseErr}</ErrorMsg>}
      <div style={{display:"flex",gap:6}}>
        <button className="btn-secondary" onClick={onParse} disabled={!raw.trim()}>Preview Import</button>
        {raw.trim() && <button className="btn-secondary btn-secondary--clear" onClick={()=>{setRaw(""); if(onClear) onClear();}}>Clear</button>}
      </div>
      {preview}
      {onImport && <button className="btn-primary" onClick={onImport}>{saved ? <><Check size={13} /> Saved!</> : importLabel}</button>}
    </div>
  );
}
function PreviewList({ rows }) {
  return (
    <div className="preview-list">
      {rows.map((r, i) => (
        <div key={i} className="preview-row">
          {r.id && <span className="preview-id">{r.id}</span>}
          <span className="preview-name">{r.name}</span>
          {r.sub && <span className="preview-sub">{r.sub}</span>}
        </div>
      ))}
    </div>
  );
}
function Label({ children }) { return <div className="form-label">{children}</div>; }
function ErrorMsg({ children }) { return <div className="error-msg"><AlertCircle size={11} /> {children}</div>; }
function TabBtn({ children, active, onClick }) {
  return <button className={`tab-btn ${active ? "tab-btn--active" : ""}`} onClick={onClick}>{children}</button>;
}
export function Loader() {
  return <div style={{ background: "#0E0E0E", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontFamily: "system-ui" }}>Loading…</div>;
}
function UploadIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export const css = `
.elig-badge{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:800;padding:3px 8px;border-radius:7px;min-width:22px;text-align:center;cursor:help;}
.elig-badge--eligible{background:#16332A;color:#5FCF9E;}
.elig-badge--ineligible{background:#2A1010;color:#F87171;}

@import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
html{scrollbar-gutter:stable;}
html,body{width:100%;overflow-x:hidden;}
.app{font-family:'Archivo',sans-serif;background:#0E0E0E;min-height:100vh;width:100%;max-width:480px;margin:0 auto;color:#FFF;padding-bottom:78px;overflow-x:hidden;}
.header{background:#0B3D2E;background-image:radial-gradient(circle at 50% 0%,#0F4A37 0%,#0B3D2E 70%);padding:14px 16px;display:flex;align-items:center;justify-content:space-between;}
.header__left{display:flex;align-items:center;gap:10px;}
.header__title{font-family:'Archivo Black',sans-serif;font-size:16px;color:#FFF;}
.header__season{font-size:10px;font-weight:700;color:#9FC4B4;letter-spacing:0.05em;margin-top:1px;}
.header__right{display:flex;align-items:center;gap:8px;}
.btn-icon-sm{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:8px;border:1.5px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#FFF;cursor:pointer;}
.btn-icon-sm--active{background:#5FCF9E;border-color:#5FCF9E;color:#0B3D2E;}
.auth-screen{display:flex;flex-direction:column;gap:14px;padding:32px 20px 24px;}
.auth-screen__icon{display:flex;justify-content:center;margin-bottom:4px;}
.auth-screen__title{font-family:'Archivo Black',sans-serif;font-size:24px;text-align:center;}
.auth-screen__sub{font-size:13px;color:#9A9A9A;text-align:center;}
.auth-hint{font-size:11px;color:#5A5A5A;text-align:center;font-family:'JetBrains Mono',monospace;}
.auth-hint code{color:#9A9A9A;}
.code-verified-badge{display:flex;align-items:center;gap:7px;background:#16332A;border:1.5px solid #1F6B4A;color:#5FCF9E;font-size:12px;font-weight:600;padding:10px 12px;border-radius:10px;}
.tab-bar{display:flex;background:#141414;border-bottom:1.5px solid #2E2E2E;padding:6px 10px;gap:5px;overflow-x:auto;}
.tab-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;padding:9px 6px;border-radius:8px;border:none;background:none;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#6A6A6A;cursor:pointer;white-space:nowrap;min-width:0;}
.tab-btn--active{background:#0B3D2E;color:#5FCF9E;}
.sub-tab-bar{display:flex;gap:6px;margin-bottom:4px;}
.sub-tab{flex:1;padding:8px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:8px;font-family:'Archivo',sans-serif;font-size:11.5px;font-weight:700;color:#6A6A6A;cursor:pointer;}
.sub-tab--active{background:#0B3D2E;border-color:#0B3D2E;color:#5FCF9E;}
.tab-content{padding:14px;display:flex;flex-direction:column;gap:12px;}
.role-pill{font-size:10.5px;font-weight:700;letter-spacing:0.04em;padding:3px 9px;border-radius:20px;border:1px solid;white-space:nowrap;}
.role-pill--sm{font-size:9.5px;padding:2px 7px;}
.section-header{display:flex;align-items:center;justify-content:space-between;}
.section-header__title{font-size:13px;font-weight:700;color:#E0E0E0;}
.field{display:flex;flex-direction:column;gap:5px;}
.form-label{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9A9A9A;}
.input{width:100%;background:#121212;border:1.5px solid #3A3A3A;border-radius:9px;padding:10px 12px;font-family:'Archivo',sans-serif;font-size:16px;color:#FFF;outline:none;}
.input:focus{border-color:#5FCF9E;}
.input--pin{font-family:'JetBrains Mono',monospace;font-size:18px;letter-spacing:0.15em;text-align:center;}
.input--code{font-family:'JetBrains Mono',monospace;font-size:20px;letter-spacing:0.2em;text-align:center;text-transform:uppercase;}
.input--select{appearance:none;cursor:pointer;font-size:16px;}
.input-wrap{position:relative;}
.input-wrap .input{padding-right:40px;}
.input-eye{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:#6A6A6A;cursor:pointer;display:flex;align-items:center;}
input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;}
.card{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:12px;}
.card__title{font-size:12px;font-weight:700;color:#9A9A9A;text-transform:uppercase;letter-spacing:0.06em;}
.settings-who{display:flex;align-items:center;gap:10px;padding:4px 0;}
.settings-username{font-family:'JetBrains Mono',monospace;font-size:14px;color:#E0E0E0;font-weight:700;}
.btn-primary{width:100%;background:#5FCF9E;color:#0B1F16;font-family:'Archivo',sans-serif;font-size:14px;font-weight:700;padding:13px;border-radius:10px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;}
.btn-primary:disabled{opacity:.35;cursor:not-allowed;}
.btn-secondary{width:100%;background:transparent;color:#E0E0E0;font-family:'Archivo',sans-serif;font-size:13px;font-weight:600;padding:11px;border-radius:10px;border:1.5px solid #3A3A3A;cursor:pointer;}
.btn-secondary:disabled{opacity:.3;cursor:not-allowed;}
.btn-secondary--clear{color:#F87171;border-color:#3A1F1F;background:#1A0E0E;}
.btn-next{width:100%;display:flex;align-items:center;justify-content:center;gap:6px;background:#16332A;border:1.5px solid #1F6B4A;color:#5FCF9E;font-family:'Archivo',sans-serif;font-size:13px;font-weight:700;padding:12px;border-radius:10px;cursor:pointer;}
.btn-ghost{background:none;border:none;font-family:'Archivo',sans-serif;font-size:12px;font-weight:600;color:#5FCF9E;cursor:pointer;padding:4px 0;}
.btn-icon{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:7px;border:1.5px solid #3A3A3A;background:#121212;color:#9A9A9A;cursor:pointer;flex-shrink:0;}
.btn-icon--confirm{border-color:#1F6B4A;background:#16332A;color:#5FCF9E;}
.btn-icon--cancel{border-color:#3A3A3A;color:#9A9A9A;}
.btn-icon--danger{border-color:#3A1F1F;background:#1A0E0E;color:#F87171;}
.btn-sm{display:flex;align-items:center;gap:4px;padding:6px 10px;background:#1C1C1C;border:1.5px solid #3A3A3A;border-radius:7px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#9A9A9A;cursor:pointer;white-space:nowrap;}
.btn-sm--accent{border-color:#1F6B4A;color:#5FCF9E;background:#16332A;}
.btn-sm--warn{border-color:#92400E;color:#F59E0B;background:#2A1F00;}
.btn-copy{display:flex;align-items:center;gap:5px;padding:7px 12px;background:#1C1C1C;border:1.5px solid #3A3A3A;border-radius:8px;font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#E0E0E0;cursor:pointer;}
.generated-code-block{background:#121212;border:1.5px solid #2E2E2E;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;}
.generated-code-block__label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#5A5A5A;}
.generated-code-block__row{display:flex;align-items:center;gap:10px;}
.generated-code-block__code{font-family:'JetBrains Mono',monospace;font-size:26px;font-weight:700;color:#5FCF9E;letter-spacing:0.15em;}
.generated-code-block__meta{display:flex;align-items:center;gap:7px;}
.code-display{font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:#E0E0E0;letter-spacing:0.1em;}
.code-expiry{font-size:10px;color:#F59E0B;font-weight:600;}
.list{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:12px;overflow:hidden;}
.list-row{border-bottom:1px solid #2A2A2A;}
.match-history-row{width:100%;display:flex;align-items:center;gap:6px;padding:0 12px 0 0;font-family:inherit;}
.match-history-row:last-child{border-bottom:none;}
.list-row:last-child{border-bottom:none;}
.list-row--special{opacity:.6;}
.list-row--active-season{background:#0F2D1F;border-left:3px solid #5FCF9E;}
.list-row__week-header{display:flex;align-items:center;padding:11px 12px;cursor:pointer;gap:6px;}
.list-row__body{display:flex;align-items:center;gap:8px;flex:1;padding:11px 12px;}
.list-row__week-header .list-row__body{padding:0;}
.list-row__id{font-family:'JetBrains Mono',monospace;font-size:10px;color:#5A5A5A;min-width:44px;}
.list-row__name{font-size:13px;font-weight:600;color:#E0E0E0;flex:1;}
.list-row__sub{font-size:10.5px;color:#6A6A6A;}
.list-row__actions{display:flex;align-items:center;gap:6px;padding-right:10px;}
.list-row__edit{display:flex;align-items:center;gap:6px;padding:8px 10px;}
.list-row__edit-actions{display:flex;gap:4px;}
.week-special-badge{font-size:10px;font-weight:700;background:#2A1F00;color:#F59E0B;padding:2px 8px;border-radius:20px;white-space:nowrap;}
.week-pairings{background:#141414;border-top:1px solid #2A2A2A;padding:8px 12px;display:flex;flex-direction:column;gap:6px;}
.pairing-row{display:grid;grid-template-columns:22px 1fr auto 1fr 22px;align-items:center;gap:6px;font-size:11.5px;}
.pairing-row--edit{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 0;}
.pairing-row--edit .edit-input{flex:1 1 120px;}
.pairing-idx{font-family:'JetBrains Mono',monospace;font-size:9.5px;color:#5A5A5A;text-align:center;}
.pairing-name{font-weight:600;color:#E0E0E0;}
.pairing-name--home{color:#5FCF9E;}
.pairing-name--away{color:#6FA8DC;text-align:right;}
.pairing-name--link{cursor:pointer;}
.pairing-name--link:hover{text-decoration:underline;}
.pairing-vs{font-size:9.5px;color:#5A5A5A;text-align:center;font-weight:700;}
.edit-input{flex:1;background:#121212;border:1.5px solid #3A3A3A;border-radius:7px;padding:7px 9px;font-family:'Archivo',sans-serif;font-size:16px;color:#FFF;outline:none;}
.edit-input:focus{border-color:#5FCF9E;}
.edit-input--sub{font-size:16px;color:#9A9A9A;}
.edit-input--rating{font-family:'JetBrains Mono',monospace;width:64px;flex:none;text-align:center;font-size:16px;}
.add-player-row{display:flex;align-items:center;gap:6px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:10px;padding:8px 10px;}
.team-select-list{display:flex;flex-direction:column;gap:4px;}
.team-select-btn{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:9px;cursor:pointer;color:#E0E0E0;font-family:'Archivo',sans-serif;text-align:left;}
.team-select-btn--active{border-color:#1F6B4A;background:#0F2D1F;}
.team-select-name{font-size:12.5px;font-weight:600;flex:1;}
.team-select-count{font-family:'JetBrains Mono',monospace;font-size:10px;color:#5A5A5A;}
.roster-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;}
.roster-team-name{font-size:14px;font-weight:700;color:#E0E0E0;}
.roster-meta{font-size:10.5px;color:#5A5A5A;margin-top:2px;}
.player-rating-badge{font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:#FFF;background:#2E2E2E;padding:3px 10px;border-radius:7px;min-width:40px;text-align:center;}
.makeup-pending-badge{font-family:'Archivo',sans-serif;font-size:10.5px;font-weight:800;letter-spacing:0.02em;color:#F59E0B;background:#2A2410;padding:4px 9px;border-radius:7px;white-space:nowrap;}
.bracket-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #2A2A2A;}
.bracket-row:last-of-type{border-bottom:none;}
.bracket-row__team{flex:1;font-size:12.5px;font-weight:600;color:#9A9A9A;}
.bracket-row__team--won{color:#5FCF9E;font-weight:700;}
.bracket-row__vs{font-size:10px;color:#5A5A5A;font-weight:700;text-transform:uppercase;}
.bracket-row__seed{font-family:'JetBrains Mono',monospace;font-size:10px;color:#5A5A5A;margin-right:3px;}
.bracket-divider{font-size:10px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#5A5A5A;margin:8px 0 2px;}
.bracket-champion{display:flex;align-items:center;gap:6px;margin-top:8px;padding:8px 10px;background:#0F2D1F;border-radius:8px;font-size:12px;font-weight:700;color:#5FCF9E;}
.user-team-label{font-size:10px;color:#9A9A9A;font-weight:600;}
.you-badge{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;background:#2A1F00;color:#F59E0B;padding:2px 6px;border-radius:20px;}
.save-flash{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:#5FCF9E;padding:6px 10px;}
.paste-importer{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;}
.paste-importer__label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#9A9A9A;}
.paste-importer__hint{font-size:11px;color:#5A5A5A;font-family:'JetBrains Mono',monospace;}
.paste-area{width:100%;background:#121212;border:1.5px solid #3A3A3A;border-radius:9px;padding:10px;font-family:'JetBrains Mono',monospace;font-size:16px;color:#E0E0E0;resize:vertical;outline:none;line-height:1.6;}
.paste-area:focus{border-color:#5FCF9E;}
.preview-list{background:#121212;border:1px solid #2E2E2E;border-radius:8px;overflow:hidden;max-height:160px;overflow-y:auto;}
.preview-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #1E1E1E;font-size:11.5px;}
.preview-row:last-child{border-bottom:none;}
.preview-id{font-family:'JetBrains Mono',monospace;color:#5A5A5A;font-size:10px;min-width:46px;}
.preview-name{color:#E0E0E0;flex:1;font-weight:600;}
.preview-sub{color:#6A6A6A;font-size:10.5px;}
.error-msg{display:flex;align-items:center;gap:5px;font-size:11.5px;color:#F87171;font-weight:600;}
.success-msg{display:flex;align-items:center;gap:5px;font-size:11.5px;color:#5FCF9E;font-weight:600;}
.empty-state{font-size:12.5px;color:#5A5A5A;text-align:center;padding:24px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:10px;}
.readonly-bar{font-size:10.5px;font-weight:700;text-align:center;padding:7px;background:#2A1F00;color:#F59E0B;border-radius:8px;letter-spacing:0.04em;}
.import-warning-block{background:#1A0E0E;border:1.5px solid #3A1F1F;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;}
.import-warning-block--amber{background:#2A1F00;border-color:#92400E;}
.import-warning-block__title{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:#F87171;}
.import-warning-block--amber .import-warning-block__title{color:#F59E0B;}
.import-warning-block__list{display:flex;flex-direction:column;gap:3px;max-height:140px;overflow-y:auto;}
.import-warning-block__row{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#E0E0E0;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);}
.import-warning-block__row:last-child{border-bottom:none;}
.import-warning-block__meta{color:#9A9A9A;font-size:10px;white-space:nowrap;}
.import-warning-block__hint{font-size:10px;color:#9A9A9A;font-style:italic;}
.season-banner{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:12px;overflow:hidden;}
.season-banner__row{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;cursor:pointer;}
.season-banner__label{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#5A5A5A;margin-bottom:2px;}
.season-banner__name{font-size:13px;font-weight:700;color:#FFF;}
.season-banner__div{font-size:11px;color:#5FCF9E;font-weight:600;margin-top:2px;}
.season-picker{border-top:1px solid #2E2E2E;}
.season-picker__season-header{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#141414;font-size:11px;font-weight:700;color:#6A6A6A;text-transform:uppercase;letter-spacing:0.05em;}
.season-picker__season-header--active{color:#5FCF9E;}
.season-picker__btn{width:100%;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:none;border:none;border-bottom:1px solid #222;font-family:'Archivo',sans-serif;font-size:12.5px;font-weight:600;color:#9A9A9A;cursor:pointer;text-align:left;}
.season-picker__btn--div{padding-left:24px;font-size:12px;}
.season-picker__btn:last-child{border-bottom:none;}
.season-picker__btn--active{background:#0F2D1F;color:#5FCF9E;}
.active-dot{font-size:10px;color:#5FCF9E;font-weight:700;}
.active-season-badge{font-size:10px;font-weight:700;color:#5FCF9E;}
.season-card{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:12px;overflow:hidden;}
.season-card--active{border-color:#1F6B4A;}
.season-card__header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;gap:8px;}
.season-card__name{font-size:13px;font-weight:700;color:#E0E0E0;}
.season-card__meta{font-size:10.5px;color:#6A6A6A;margin-top:2px;}
.season-card__body{border-top:1px solid #2A2A2A;padding:10px 14px;display:flex;flex-direction:column;gap:6px;}
.div-row{display:flex;align-items:center;gap:8px;padding:6px 8px;background:#141414;border-radius:7px;}
.div-row__num{font-family:'JetBrains Mono',monospace;font-size:10px;color:#5A5A5A;min-width:48px;}
.div-row__name{font-size:12px;font-weight:600;color:#E0E0E0;flex:1;}
.div-add-row{display:flex;align-items:center;gap:6px;margin-top:2px;}
.player-nickname{font-size:11px;color:#6A6A6A;font-style:italic;}
@keyframes spin{to{transform:rotate(360deg);}}
.seg-control{display:flex;gap:4px;}
.seg-btn{flex:1;padding:8px 6px;background:#121212;border:1.5px solid #3A3A3A;border-radius:8px;font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;color:#6A6A6A;cursor:pointer;}
.seg-btn--active{background:#0B3D2E;border-color:#1F6B4A;color:#5FCF9E;}
.season-preview{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#F59E0B;background:#2A1F00;padding:8px 12px;border-radius:8px;}
.tonight-header{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:4px;}
.tonight-header__week{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#5FCF9E;}
.tonight-header__date{font-family:'Archivo Black',sans-serif;font-size:20px;color:#FFF;}
.tonight-header__status{font-size:11px;color:#6A6A6A;margin-top:2px;}
.match-card{background:#FFF;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;}
.match-card__venue{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#5A5A5A;}
.match-card__teams{display:flex;align-items:center;gap:8px;}
.match-card__team{flex:1;display:flex;flex-direction:column;gap:4px;}
.match-card__team--away{align-items:flex-end;}
.match-card__team-name{font-size:13px;font-weight:700;color:#1A1A1A;}
.match-card__vs{font-size:10px;font-weight:700;color:#9A9A9A;flex-shrink:0;}
.roster-badge{font-family:'JetBrains Mono',monospace;font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:20px;}
.roster-badge--ready{background:#DCEAE2;color:#1F6B4A;}
.roster-badge--warn{background:#2A1F00;color:#F59E0B;}
.match-card__rosters{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.roster-col{display:flex;flex-direction:column;gap:3px;}
.roster-col--away{align-items:flex-end;}
.roster-slot{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 6px;background:#F7F7F7;border-radius:6px;}
.roster-col--away .roster-slot{flex-direction:row-reverse;}
.roster-slot--empty{background:#F0F0F0;opacity:.5;}
.roster-slot__name{font-size:10.5px;font-weight:600;color:#1A1A1A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px;}
.roster-slot__rating{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:#5A5A5A;flex-shrink:0;}
.roster-slot__tbd{font-size:10px;color:#AAAAAA;font-style:italic;}
.match-card__launch{width:100%;padding:11px;border-radius:9px;border:none;font-family:'Archivo',sans-serif;font-size:12.5px;font-weight:700;cursor:pointer;background:#E5E5E5;color:#6A6A6A;}
.match-card__launch--ready{background:#0B3D2E;color:#5FCF9E;}
.match-card__launch:disabled{opacity:.3;cursor:not-allowed;}
.match-card--bye{background:#1C1C1C;border:1.5px dashed #3A3A3A;}
.match-card__bye-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#F59E0B;text-align:center;}
.match-card--bye .match-card__team-name{color:#E0E0E0;}

/* ─── Responsive scale-up (tablet / laptop+) ───────────────────────────────
   Base rules above are the phone design, unchanged below 768px. Widens the
   single-column layout and scales up the highest-visibility text/spacing at
   two breakpoints so a laptop gets a comfortably larger, better-proportioned
   column instead of a phone-width strip floating in empty space. This does
   not introduce multi-column layouts -- every component still stacks the
   same way, just with more room. */
@media (min-width:768px){
  .app{max-width:640px;}
  .page-header{padding:16px 20px;}
  .page-header__title{font-size:16px;}
  .tab-content{padding:16px;}
  .card{padding:16px;}
  .tab-btn{font-size:11.5px;padding:9px 8px;}
  .section-header__title{font-size:14px;}
  .card__title{font-size:12.5px;}
  .btn-primary{font-size:14.5px;padding:14px;}
}
@media (min-width:1200px){
  .app{max-width:840px;}
  .page-header{padding:18px 24px;}
  .page-header__title{font-size:17px;}
  .page-header__subtitle{font-size:11px;}
  .tab-content{padding:22px;}
  .card{padding:20px;}
  .tab-btn{font-size:12.5px;padding:11px 10px;}
  .section-header__title{font-size:15px;}
  .card__title{font-size:13px;}
  .btn-primary{font-size:15px;padding:15px;}
}

/* ─── Print / export ─────────────────────────────────────────────────────
   Activated only by the browser's native print dialog (window.print(),
   triggered from a "Print / Save as PDF" button) -- no PDF library, no
   server round trip. Hides app chrome (header, tab bar, buttons, filter
   chips, Track a Rack widgets) and forces ink-friendly light colors, since
   the dark theme that works on-screen prints as a wall of black. Anything
   given the .no-print class is hidden too, for one-off buttons that don't
   fit a broader selector. */
@media print {
  .page-header, .tab-bar-nav, .drawer, .drawer-scrim, .btn-primary, .btn-secondary,
  .btn-sm, .btn-icon, .shot-tracker, .no-print { display: none !important; }
  body, .app { background: #FFFFFF !important; max-width: 100% !important; }
  .card, .list, .list-row { background: #FFFFFF !important; border-color: #CCCCCC !important; box-shadow: none !important; break-inside: avoid; }
  .card, .card__title, .list-row__name, .list-row__sub, .list-row__id, * { color: #111111 !important; }
  .player-rating-badge { background: #EEEEEE !important; }
}
`;
