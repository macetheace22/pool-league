import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Check, Wifi, WifiOff, RefreshCw, Trophy, Lock, Coins, AlertTriangle, UserCircle } from "lucide-react";
import { PageHeader, shellCss } from "./Shell";
import { supabase } from "./supabaseClient";
import * as db from "./db";
import { useAuth } from "./AuthContext";
import ShotTracker, { shotTrackerCss } from "./ShotTracker";
import { mergeLiveMatchState } from "./liveMatchSync";

// ─── Constants ────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 3000;
const FALLBACK_FORMAT   = "masters";

// Draft sequencing: which side puts up first for each set ("block" or "choice")
// Sets 1,3,5 -> block puts up first. Sets 2,4 -> choice puts up first.
const PUTUP_FIRST = { 1: "block", 2: "choice", 3: "block", 4: "choice", 5: "block" };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function runningTotal(racks, slot) {
  return racks.reduce((s, r) => s + (r[slot] ?? 0), 0);
}
function safetyTotal(racks, side) {
  const key = side === "home" ? "safetyHome" : "safetyAway";
  return racks.reduce((s, r) => s + (r[key] ?? 0), 0);
}

// Ratings of 0, 1, or 2 signal a new/unrated (NR) player, not a real skill
// rating -- distinct from a genuinely missing rating (null), which already
// keeps a player out of the draftable roster entirely (see resolveRoster).
const UNRATED_MAX = 2;
function isUnrated(rating) {
  return rating != null && rating <= UNRATED_MAX;
}
// Open races to 45, Advanced/Masters to 50.
function fixedRaceTarget(format) {
  return (format || "masters").toLowerCase() === "open" ? 45 : 50;
}
// Normally each player races to their OWN rating. If either player in the
// set is unrated, BOTH players instead race to the same fixed number for
// the format -- an unrated player has no personal target to race to, so a
// mismatched individual-rating race isn't meaningful for either side.
function effectiveTarget(player, otherPlayer, format) {
  if (isUnrated(player.rating) || isUnrated(otherPlayer.rating)) return fixedRaceTarget(format);
  return player.rating;
}

function detectWinner(racks, playerHome, playerAway, format) {
  if (playerHome?.rating == null || playerAway?.rating == null) return null;
  const targetHome = effectiveTarget(playerHome, playerAway, format);
  const targetAway = effectiveTarget(playerAway, playerHome, format);
  let runH = 0, runA = 0;
  for (const r of racks) {
    runH += r.home ?? 0;
    runA += r.away ?? 0;
    const hDone = runH >= targetHome;
    const aDone = runA >= targetAway;
    // If a single rack pushes both players past their targets at once, the
    // winner is whoever won that specific rack -- not just the higher total.
    if (hDone && aDone) return (r.home > r.away ? "home" : r.away > r.home ? "away" : r.tiebreak ?? "home");
    if (hDone) return "home";
    if (aDone) return "away";
  }
  return null;
}

async function loadMatch(pairingId) {
  try { return await db.getLiveMatch(pairingId); }
  catch { return null; }
}
async function saveMatch(pairingId, match) {
  try { return await db.setLiveMatch(pairingId, match); }
  catch { return false; }
}

// Which side is "block" / "choice" given the coin flip loser
function sideForRole(match, role) {
  // coinFlipLoser is "home" or "away" — that side is "block"
  if (!match.coinFlipLoser) return null;
  if (role === "block") return match.coinFlipLoser;
  return match.coinFlipLoser === "home" ? "away" : "home";
}
function roleForSide(match, side) {
  if (!match.coinFlipLoser) return null;
  return match.coinFlipLoser === side ? "block" : "choice";
}

// Player numbers already used anywhere in this match (any set, either side)
// ─── Forfeit points ─────────────────────────────────────────────────────────
// Flat point value credited to the player RECEIVING a forfeited set. The
// player on the forfeiting team always gets 0. Tier depends on format
// (season-level) and whether the match falls on/after the season's playoffs
// start date (regular season vs playoff/tournament).
const FORFEIT_POINTS = {
  masters:  { regular: 100, playoff: 200 },
  advanced: { regular: 150, playoff: 250 },
  open:     { regular: 125, playoff: (rating) => 100 + (rating ?? 0) },
};
function isPlayoffMatch(match) {
  if (!match.playoffsStartDate || !match.weekDate) return false;
  return new Date(match.weekDate) >= new Date(match.playoffsStartDate);
}
function computeForfeitPoints(match, receivingPlayerRating) {
  const format = (match.format || "masters").toLowerCase();
  const tier = FORFEIT_POINTS[format] ?? FORFEIT_POINTS.masters;
  const val = isPlayoffMatch(match) ? tier.playoff : tier.regular;
  return typeof val === "function" ? val(receivingPlayerRating) : val;
}

// ─── Playoff eligibility (Division Playoffs - Roster and Handicap Report) ──
// match.isPlayoff comes straight from the schedule week's own is_playoff
// flag (set when the match is launched from the Tonight tab) -- distinct
// from isPlayoffMatch() above, which is a date comparison used only for
// forfeit-point tiers. Gating who's allowed to actually shoot uses THIS
// flag, not that one. Only players who resolved to a real player_num when
// the eligibility report was imported carry an eligCode at all (see
// TonightTab's buildSeed in AdminApp.jsx) -- a player with no eligCode on a
// playoff match roster is treated as eligible rather than blocked, since
// "no data imported yet" isn't the same thing as "known ineligible."
const ELIGIBILITY_REASONS = {
  T: "Less than 4 sets played with this team",
  A: "No membership application on file",
  S: "Too few calculated scores in rating history",
};
function playoffIneligibleReason(match, player) {
  if (!match.isPlayoff) return null;
  if (!player?.eligCode || player.eligCode === "E") return null;
  return ELIGIBILITY_REASONS[player.eligCode] ?? "Not eligible for playoffs";
}

function usedPlayerNums(match) {
  const used = new Set();
  for (const s of match.sets) {
    if (s.playerHome?.num) used.add(s.playerHome.num);
    if (s.playerAway?.num) used.add(s.playerAway.num);
  }
  return used;
}

// Determine the draft state of a given set index (0-based)
// Returns: "locked" | "putup_block" | "putup_choice" | "counter_block" | "counter_choice" | "ready" | "live" | "done"
function setDraftState(match, setIdx) {
  const set = match.sets[setIdx];
  if (set.complete) return "done";
  if (set.playerHome && set.playerAway) return "live"; // both assigned, scoring in progress
  const setNum = setIdx + 1;

  // Sets 1 & 2 are always open from the start (simultaneous)
  if (setNum <= 2) {
    const firstRole = PUTUP_FIRST[setNum]; // "block" or "choice"
    const firstSide = sideForRole(match, firstRole);
    const firstAssigned = set[`player${firstSide === "home" ? "Home" : "Away"}`];
    if (!firstAssigned) return `putup_${firstRole}`;
    return `counter_${firstRole === "block" ? "choice" : "block"}`;
  }

  // Sets 3-5 unlock when enough prior sets are complete/in-progress-resolved
  // Set 3 unlocks once 1 of {1,2} is complete. Set 4 unlocks once 2 total sets complete. Set 5 once 3 complete.
  const completedBefore = match.sets.slice(0, setIdx).filter(s => s.complete).length;
  const unlockThreshold = setNum - 2; // set3 needs 1 completed, set4 needs 2, set5 needs 3
  if (completedBefore < unlockThreshold) return "locked";

  const firstRole = PUTUP_FIRST[setNum];
  const firstSide = sideForRole(match, firstRole);
  const firstAssigned = set[`player${firstSide === "home" ? "Home" : "Away"}`];
  if (!firstAssigned) return `putup_${firstRole}`;
  return `counter_${firstRole === "block" ? "choice" : "block"}`;
}

function emptyMatch() {
  return {
    matchId: `match-${Date.now()}`,
    format: FALLBACK_FORMAT,
    venue: "",
    teamHome: { id: null, name: "", roster: [] },
    teamAway: { id: null, name: "", roster: [] },
    sets: Array(5).fill(null).map((_, i) => ({
      setNum: i + 1, playerHome: null, playerAway: null, racks: [], winnerSlot: null, complete: false,
    })),
    coinFlipLoser: null,
    phase: "lineup",
    confirmedHome: false,
    confirmedAway: false,
    disputedBy: null,
    disputeNote: null,
    archiving: false,
    makeup: null, // { shortTeam, reason, confirmedHome, confirmedAway, disputedBy, disputeNote }
    resumingMatchId: null, // set when this session finishes an already-archived makeup-pending match, so archiving updates that row instead of inserting a new one
    playoffsStartDate: null,
    schedulePairingId: null,
    scorerHome: null, // { profileId, username, claimedAt } -- who currently has the claim to score for home
    scorerAway: null,
    unavailableHome: false, // true if that team has no one to score -- lets the other side's confirm alone finalize the match
    unavailableAway: false,
    submissionReady: false, // explicit final-review gate before archiving
  };
}

// ─── Top-level App ────────────────────────────────────────────────────────────
export default function LiveEntryApp() {
  const [searchParams] = useSearchParams();
  const pairingId = searchParams.get("pairing");
  const { profile } = useAuth();

  const [match, setMatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [syncErr, setSyncErr] = useState(false);
  const [activeSet, setActiveSet] = useState(0);

  useEffect(() => {
    if (!pairingId) { setLoading(false); return; }
    loadMatch(pairingId).then((m) => {
      setMatch(m ?? emptyMatch());
      setLoading(false);
      setLastSync(Date.now());
    });
  }, [pairingId]);

  useEffect(() => {
    if (!match || !pairingId) return;
    const id = setInterval(async () => {
      const remote = await loadMatch(pairingId);
      if (!remote) { setSyncErr(true); return; }
      setSyncErr(false);
      setLastSync(Date.now());
      setMatch((local) => {
        if (!local) return remote;
        // Overwrite if remote has more racks OR more assigned players (covers draft updates too)
        const countSig = (m) => m.sets.reduce((s, st) => s + st.racks.length + (st.playerHome?1:0) + (st.playerAway?1:0) + (st.complete?1:0), 0) + (m.coinFlipLoser?1:0);
        return countSig(remote) > countSig(local) ? remote : local;
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [match?.matchId, pairingId]);

  const persist = useCallback(async (updated) => {
    setSyncing(true);
    const result = await db.setLiveMatch(pairingId, updated);
    if (result?.ok) {
      const saved = { ...updated, _revision: Number.isInteger(updated?._revision) ? updated._revision + 1 : 0 };
      setSyncErr(false);
      setSyncing(false);
      setLastSync(Date.now());
      setMatch(saved);
      return true;
    }

    // Another scorer saved after this screen last read. Merge the user's
    // change with the newer server state, then retry against that revision.
    if (result?.conflict) {
      const remote = await loadMatch(pairingId);
      if (remote) {
        const merged = mergeLiveMatchState(match, updated, remote);
        const retry = await db.setLiveMatch(pairingId, merged);
        if (retry?.ok) {
          const saved = { ...merged, _revision: Number.isInteger(merged?._revision) ? merged._revision + 1 : 0 };
          setSyncErr(false);
          setSyncing(false);
          setLastSync(Date.now());
          setMatch(saved);
          return true;
        }
      }
    }

    setSyncErr(true);
    setSyncing(false);
    setLastSync(Date.now());
    setMatch(updated);
    return false;
  }, [pairingId, match]);

  const refreshFromServer = useCallback(async () => {
    const fresh = await loadMatch(pairingId);
    if (fresh) { setMatch(fresh); setLastSync(Date.now()); }
  }, [pairingId]);

  const handleClaim = async (side) => {
    const ok = await db.claimScoringSide(pairingId, side);
    if (ok) await refreshFromServer();
  };
  const handleMarkUnavailable = async (side) => {
    const ok = await db.markSideUnavailable(pairingId, side);
    if (ok) await refreshFromServer();
  };

  // Fires on EITHER device, whichever notices first (via its own confirm tap or
  // the next poll) that both sides have confirmed. The `archiving` flag is
  // persisted as the very first step specifically so the other device's next
  // poll sees it and skips triggering a second, duplicate archive. A side
  // marked unavailable doesn't need its own confirm -- the other side's
  // confirmation alone is enough, since no one's expected to confirm for it.
  const archivingRef = useRef(false);
  useEffect(() => {
    if (!match) return;
    const homeOk = match.unavailableHome || match.confirmedHome;
    const awayOk = match.unavailableAway || match.confirmedAway;
    const normalReady = match.phase === "confirm" && homeOk && awayOk && !match.disputedBy && !(match.unavailableHome && match.unavailableAway) && match.submissionReady;
    const makeupReady = match.makeup && match.makeup.confirmedHome && match.makeup.confirmedAway && !match.makeup.disputedBy;
    if ((normalReady || makeupReady) && !match.archiving && !archivingRef.current) {
      archivingRef.current = true;
      (async () => {
        const marked = { ...match, archiving: true };
        await saveMatch(pairingId, marked);
        const archiveResult = await db.archiveMatch(marked, marked.divisionId ?? null);

        // Only the caller that created the archive (or completed a pending
        // makeup row) may advance the bracket. A duplicate concurrent submit
        // returns the existing row with _shouldAdvanceBracket=false.
        if (archiveResult?._shouldAdvanceBracket && marked.schedulePairingId) {
          const homeSets = marked.sets.filter(s => s.winnerSlot === "home").length;
          const awaySets = marked.sets.filter(s => s.winnerSlot === "away").length;
          const winnerId = homeSets > awaySets ? marked.teamHome?.id : awaySets > homeSets ? marked.teamAway?.id : null;
          if (winnerId) await db.advancePlayoffBracket(marked.schedulePairingId, winnerId);
        }

        const finalState = { ...marked, phase: "archived" };
        await saveMatch(pairingId, finalState);
        setMatch(finalState);
        setLastSync(Date.now());
        archivingRef.current = false;
      })();
    }
  }, [match?.confirmedHome, match?.confirmedAway, match?.disputedBy, match?.phase, match?.archiving, match?.makeup, match?.unavailableHome, match?.unavailableAway, match?.submissionReady, pairingId]);

  const resetMatch = async () => {
    const fresh = emptyMatch();
    await persist(fresh);
    setActiveSet(0);
  };

  if (!pairingId) {
    return (
      <div className="app">
        <style>{css}</style>
        <style>{shellCss}</style>
        <PageHeader title="Score Your Match" hideBack />
        <div className="screen"><div className="empty-state">No match selected. Go back to Current League Matches and pick a match to score.</div></div>
      </div>
    );
  }

  if (loading || !match) return <div style={{ background: "#0E0E0E", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#FFF", fontFamily: "system-ui" }}>Loading…</div>;

  const fmt = match.format ?? FALLBACK_FORMAT;
  const IS_MASTERS = fmt === "masters";
  const hasRosters = match.teamHome.roster?.length > 0 && match.teamAway.roster?.length > 0;
  const phase = match.phase;

  const isManager = profile?.role === "manager";
  const mySide = hasRosters ? db.eligibleSide(match, profile) : null;
  const myClaim = mySide === "home" ? match.scorerHome : mySide === "away" ? match.scorerAway : null;
  const myClaimedByMe = myClaim?.profileId === profile?.id;
  const otherSideUnavailable = mySide === "home" ? match.unavailableAway : mySide === "away" ? match.unavailableHome : false;
  const canEnter = isManager || (mySide && (myClaimedByMe || otherSideUnavailable));
  const showGateScreens = hasRosters && phase !== "archived";

  return (
    <div className="app">
      <style>{css}</style>
      <style>{shellCss}</style>
      <Header match={match} syncing={syncing} syncErr={syncErr} lastSync={lastSync} />
      {!hasRosters && <NoMatchScreen />}
      {showGateScreens && !mySide && !isManager && <NotYourMatchScreen />}
      {showGateScreens && (mySide || isManager) && !canEnter && (
        <ClaimGateScreen match={match} mySide={mySide} profile={profile} onClaim={handleClaim} />
      )}
      {(!showGateScreens || canEnter) && hasRosters && (
        <>
          {phase !== "archived" && (
            <ScorerStatusBar match={match} mySide={mySide} isManager={isManager}
              onClaim={handleClaim} onMarkUnavailable={handleMarkUnavailable} />
          )}
          {match.makeup && phase !== "archived" && (
            <MakeupConfirmScreen match={match} onSave={persist} />
          )}
          {!match.makeup && phase === "lineup" && !match.coinFlipLoser && (
            <CoinFlipScreen match={match} onSave={persist} />
          )}
          {!match.makeup && phase === "lineup" && match.coinFlipLoser && (
            <>
              <DraftScreen match={match} activeSet={activeSet} setActiveSet={setActiveSet} onSave={persist} />
              <MidMatchMakeupTrigger match={match} onSave={persist} />
            </>
          )}
          {!match.makeup && phase === "live" && (
            <>
              <LiveScreen match={match} activeSet={activeSet} setActiveSet={setActiveSet} onSave={persist} pairingId={pairingId} />
              <MidMatchMakeupTrigger match={match} onSave={persist} />
            </>
          )}
          {!match.makeup && phase === "confirm" && (
            <ConfirmScreen match={match} onSave={persist} />
          )}
          {phase === "archived" && <DoneScreen match={match} onReset={resetMatch} />}
        </>
      )}
    </div>
  );
}

function NotYourMatchScreen() {
  return (
    <div className="screen">
      <div className="empty-state">This isn't your team's match tonight.</div>
    </div>
  );
}

// Blocks entry to scoring until the viewer claims their side (or takes over
// from whoever currently holds it) -- this is what actually prevents two
// people on the same team from entering conflicting scores at once.
function ClaimGateScreen({ match, mySide, profile, onClaim }) {
  const [claiming, setClaiming] = useState(false);
  const teamName = mySide === "home" ? match.teamHome.name : match.teamAway.name;
  const currentClaim = mySide === "home" ? match.scorerHome : match.scorerAway;

  const claim = async () => {
    setClaiming(true);
    await onClaim(mySide);
    setClaiming(false);
  };

  return (
    <div className="screen">
      <div className="card" style={{textAlign:"center"}}>
        <UserCircle size={28} color="#5FCF9E" style={{margin:"0 auto 10px"}}/>
        {currentClaim ? (
          <>
            <div className="card__title">@{currentClaim.username} is scoring for {teamName}</div>
            <div style={{fontSize:12,color:"#9A9A9A",margin:"8px 0 14px"}}>You can take over if they need to go play or step away.</div>
            <button className="btn-primary" onClick={claim} disabled={claiming}>{claiming?"Taking over…":"Take Over"}</button>
          </>
        ) : (
          <>
            <div className="card__title">Score for {teamName}?</div>
            <div style={{fontSize:12,color:"#9A9A9A",margin:"8px 0 14px"}}>Claiming keeps two people from entering the same match at once. You can hand this off to a teammate any time.</div>
            <button className="btn-primary" onClick={claim} disabled={claiming}>{claiming?"Starting…":"I'm Scoring for This Team"}</button>
          </>
        )}
      </div>
    </div>
  );
}

// Persistent status strip once past the claim gate -- shows who's scoring
// for each side, and lets the active scorer mark the other team unavailable
// if no one from that side has an account to claim it.
function ScorerStatusBar({ match, mySide, isManager, onClaim, onMarkUnavailable }) {
  const sideInfo = (side) => {
    const claim = side === "home" ? match.scorerHome : match.scorerAway;
    const unavailable = side === "home" ? match.unavailableHome : match.unavailableAway;
    const teamName = side === "home" ? match.teamHome.name : match.teamAway.name;
    return { claim, unavailable, teamName };
  };
  const home = sideInfo("home");
  const away = sideInfo("away");
  const iHoldASide = (mySide === "home" && match.scorerHome) || (mySide === "away" && match.scorerAway) || isManager;

  const renderSide = (info, side) => {
    if (info.unavailable) return <span className="scorer-status__badge scorer-status__badge--unavailable">{info.teamName}: Unavailable</span>;
    if (info.claim) return <span className="scorer-status__badge">{info.teamName}: @{info.claim.username}</span>;
    return (
      <span className="scorer-status__badge scorer-status__badge--empty">
        {info.teamName}: Unclaimed
        {iHoldASide && <button className="scorer-status__mark-btn" onClick={()=>onMarkUnavailable(side)}>Mark unavailable</button>}
      </span>
    );
  };

  return (
    <div className="scorer-status">
      {renderSide(home, "home")}
      {renderSide(away, "away")}
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
function Header({ match, syncing, syncErr, lastSync }) {
  const ago = lastSync ? Math.round((Date.now() - lastSync) / 1000) : null;
  return (
    <>
      <PageHeader title="Score Your Match" hideBack />
      <div className="header-info">
        <div className="header-info__row">
          {match.seasonLabel && (
            <span className="header-info__season">{match.seasonLabel}{match.divNum ? ` · Div ${match.divNum}` : ""}</span>
          )}
          <span className="header__sync">
            {syncErr ? <WifiOff size={12} color="#F87171" /> : syncing ? <RefreshCw size={12} color="#9FC4B4" className="spin" /> : <Wifi size={12} color="#5FCF9E" />}
            <span className="header__sync-label" style={{ color: syncErr ? "#F87171" : "#9FC4B4" }}>
              {syncErr ? "Sync error" : syncing ? "Saving…" : ago !== null ? `${ago}s ago` : ""}
            </span>
          </span>
        </div>
        {match.teamHome.name && (
          <div className="header__match">
            <span className="header__venue">{match.venue || "—"}</span>
            <span className="header__teams">{match.teamHome.name} <span className="vs">vs</span> {match.teamAway.name}</span>
          </div>
        )}
      </div>
    </>
  );
}

function NoMatchScreen() {
  return (
    <div className="screen">
      <div className="empty-state">No match seeded yet. Use the admin panel's Tonight tab to seed a match.</div>
    </div>
  );
}

// ─── Coin Flip Screen ─────────────────────────────────────────────────────────
function CoinFlipScreen({ match, onSave }) {
  const [reporting, setReporting] = useState(false);
  const callFlip = (loserSide) => {
    onSave({ ...match, coinFlipLoser: loserSide });
  };

  if (reporting) {
    return <MakeupReportForm match={match} onSave={onSave} onCancel={()=>setReporting(false)}
      title="Which team can't field any shooters tonight?" />;
  }

  return (
    <div className="screen">
      <div className="screen__eyebrow"><Coins size={12}/> Coin Flip</div>
      <div className="screen__title">Who lost the flip?</div>
      <div className="card" style={{textAlign:"center",color:"#9A9A9A",fontSize:12.5,lineHeight:1.6}}>
        The team that lost the coin flip puts up a player first for sets 1, 3, & 5.<br/>
        The team that won puts up first for sets 2 & 4.
      </div>
      <div className="coinflip-choices">
        <button className="coinflip-btn coinflip-btn--home" onClick={()=>callFlip("home")}>
          {match.teamHome.name}<span className="coinflip-btn__sub">lost the flip</span>
        </button>
        <button className="coinflip-btn coinflip-btn--away" onClick={()=>callFlip("away")}>
          {match.teamAway.name}<span className="coinflip-btn__sub">lost the flip</span>
        </button>
      </div>
      <button className="makeup-trigger-link" onClick={()=>setReporting(true)}>
        <AlertTriangle size={12}/> A team has no shooters tonight — report a makeup
      </button>
    </div>
  );
}

// Shared reporting form -- used both before any tables are set (whole match
// becomes a makeup) and mid-match (whatever tables are already complete keep
// their real score; whatever's left gets flagged pending).
function MakeupReportForm({ match, onSave, onCancel, title }) {
  const [side, setSide] = useState("home");
  const [reason, setReason] = useState("");
  const submit = () => {
    onSave({ ...match, makeup: { shortTeam: side, reason: reason.trim() || "Team could not field 5 shooters.", confirmedHome: false, confirmedAway: false, disputedBy: null, disputeNote: null } });
  };
  return (
    <div className="screen">
      <div className="screen__eyebrow"><AlertTriangle size={12}/> Report Makeup</div>
      <div className="screen__title">{title}</div>
      <div className="coinflip-choices">
        <button className={`coinflip-btn coinflip-btn--home ${side==="home"?"":"coinflip-btn--dim"}`} onClick={()=>setSide("home")}>{match.teamHome.name}</button>
        <button className={`coinflip-btn coinflip-btn--away ${side==="away"?"":"coinflip-btn--dim"}`} onClick={()=>setSide("away")}>{match.teamAway.name}</button>
      </div>
      <div className="card">
        <div className="card__title">Details (optional)</div>
        <textarea className="flag-textarea" rows={2} value={reason} onChange={e=>setReason(e.target.value)} placeholder="e.g. Only 3 shooters available tonight"/>
        <div style={{display:"flex",gap:8}}>
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={submit}>Report Makeup</button>
        </div>
      </div>
    </div>
  );
}

// Small persistent trigger shown mid-match (once some tables may already be
// played) -- reports a makeup for whatever tables aren't complete yet,
// without touching the score of tables that already finished.
function MidMatchMakeupTrigger({ match, onSave }) {
  const [reporting, setReporting] = useState(false);
  const completedCount = match.sets.filter(s => s.complete).length;
  if (reporting) {
    return <MakeupReportForm match={match} onSave={onSave} onCancel={()=>setReporting(false)}
      title={completedCount > 0 ? "Which team is out of shooters for the remaining tables?" : "Which team can't field any shooters tonight?"} />;
  }
  return (
    <button className="makeup-trigger-link" onClick={()=>setReporting(true)}>
      <AlertTriangle size={12}/> {completedCount > 0 ? "Out of shooters for the rest of the night — report a makeup" : "A team has no shooters tonight — report a makeup"}
    </button>
  );
}

// ─── Draft Screen (alternating player selection) ──────────────────────────────
function DraftScreen({ match, activeSet, setActiveSet, onSave }) {
  const used = usedPlayerNums(match);

  // Find which sets are unlocked/active for navigation
  const statuses = match.sets.map((_, i) => setDraftState(match, i));
  const firstOpenIdx = statuses.findIndex(s => s !== "locked" && s !== "done");

  useEffect(() => {
    if (statuses[activeSet] === "locked" && firstOpenIdx !== -1) setActiveSet(firstOpenIdx);
  }, [statuses.join(",")]);

  const nextPhase = (newSets) => {
    if (newSets.every(s => s.complete)) return "confirm";
    if (newSets.every(s => s.playerHome && s.playerAway)) return "live";
    return "lineup";
  };

  const assignPlayer = (setIdx, side, player) => {
    const newSets = match.sets.map((s, i) => i !== setIdx ? s : {
      ...s, [`player${side === "home" ? "Home" : "Away"}`]: { num: player.num, name: player.name, nickname: player.nickname, rating: player.rating }
    });
    onSave({ ...match, sets: newSets, phase: nextPhase(newSets) });
  };

  const forfeitSet = (setIdx, forfeitingSide, forfeitingPlayer, receivingPlayer) => {
    const receivingSide = forfeitingSide === "home" ? "away" : "home";
    const points = computeForfeitPoints(match, receivingPlayer.rating);
    const newSets = match.sets.map((s, i) => i !== setIdx ? s : {
      ...s,
      playerHome: forfeitingSide === "home"
        ? { num: forfeitingPlayer.num, name: forfeitingPlayer.name, nickname: forfeitingPlayer.nickname, rating: forfeitingPlayer.rating }
        : { num: receivingPlayer.num, name: receivingPlayer.name, nickname: receivingPlayer.nickname, rating: receivingPlayer.rating },
      playerAway: forfeitingSide === "away"
        ? { num: forfeitingPlayer.num, name: forfeitingPlayer.name, nickname: forfeitingPlayer.nickname, rating: forfeitingPlayer.rating }
        : { num: receivingPlayer.num, name: receivingPlayer.name, nickname: receivingPlayer.nickname, rating: receivingPlayer.rating },
      racks: [], complete: true, winnerSlot: receivingSide,
      forfeited: true, forfeitedBy: forfeitingSide, forfeitPoints: points,
    });
    onSave({ ...match, sets: newSets, phase: nextPhase(newSets) });
  };

  return (
    <div className="screen">
      <div className="screen__eyebrow"><Lock size={12}/> Setting Lineups</div>
      <div className="screen__title">Pick Players</div>
      <DraftSetTabBar statuses={statuses} activeSet={activeSet} onSelect={setActiveSet} />
      <DraftSetEntry
        key={activeSet}
        match={match}
        setIdx={activeSet}
        status={statuses[activeSet]}
        used={used}
        onAssign={assignPlayer}
        onForfeit={forfeitSet}
      />
    </div>
  );
}

function DraftSetTabBar({ statuses, activeSet, onSelect }) {
  return (
    <div className="set-tabs">
      {statuses.map((status, i) => {
        const locked = status === "locked";
        const done = status === "done";
        const live = status === "live";
        return (
          <button key={i}
            className={`set-tab ${i === activeSet ? "set-tab--active" : ""} ${done?"set-tab--done":""} ${locked?"set-tab--locked":""} ${live?"set-tab--live":""}`}
            onClick={() => !locked && onSelect(i)} disabled={locked}>
            {done ? <Check size={10}/> : locked ? <Lock size={10}/> : i + 1}
          </button>
        );
      })}
    </div>
  );
}

function DraftSetEntry({ match, setIdx, status, used, onAssign, onForfeit }) {
  const set = match.sets[setIdx];
  const [forfeiting, setForfeiting] = useState(false);

  if (status === "locked") {
    return <div className="empty-state">This table unlocks once an earlier set finishes.</div>;
  }
  if (status === "done" || status === "live") {
    return (
      <div className="card" style={{textAlign:"center"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#5FCF9E",marginBottom:6}}>Table {setIdx+1} matchup set</div>
        <div className="draft-matchup-display">
          <span className="draft-matchup-display__home">{set.playerHome?.name}</span>
          <span className="draft-matchup-display__vs">vs</span>
          <span className="draft-matchup-display__away">{set.playerAway?.name}</span>
        </div>
      </div>
    );
  }

  // status is putup_block | putup_choice | counter_block | counter_choice
  const isPutup = status.startsWith("putup");
  const role = status.split("_")[1]; // "block" or "choice"
  const side = sideForRole(match, role); // "home" or "away" -- whoever's turn it currently is
  const otherSide = side === "home" ? "away" : "home";
  const team = match[`team${side === "home" ? "Home" : "Away"}`];
  const otherTeam = match[`team${otherSide === "home" ? "Home" : "Away"}`];

  // Figure out who's been put up already this set (the side that already has a player assigned)
  const alreadyAssignedSide = set.playerHome ? "home" : set.playerAway ? "away" : null;
  const opponentPlayer = alreadyAssignedSide ? set[`player${alreadyAssignedSide==="home"?"Home":"Away"}`] : null;

  const availableRoster = (team.roster ?? []).filter(p => !used.has(p.num));

  if (forfeiting) {
    return (
      <ForfeitTableForm match={match} setIdx={setIdx} used={used}
        defaultForfeitingSide={side} lockForfeitingSide={!!alreadyAssignedSide}
        lockedReceivingPlayer={alreadyAssignedSide ? opponentPlayer : null}
        onForfeit={onForfeit} onCancel={()=>setForfeiting(false)} />
    );
  }

  return (
    <div className="draft-step">
      <div className={`draft-step__banner draft-step__banner--${side}`}>
        {isPutup
          ? <>{team.name} puts up a player for Table {setIdx+1}</>
          : <>{opponentPlayer?.name} ({opponentPlayer?.rating}) is on the table — {team.name} picks a counter</>
        }
      </div>
      <div className="draft-roster-list">
        {availableRoster.length === 0 && <div className="empty-state">No available players left on this roster.</div>}
        {availableRoster
          .slice()
          .sort((a,b)=>b.rating-a.rating)
          .map(p => {
            const ineligibleReason = playoffIneligibleReason(match, p);
            if (ineligibleReason) {
              return (
                <div key={p.num} className="draft-roster-row draft-roster-row--ineligible">
                  <span className="draft-roster-row__name">{p.name}{p.nickname?<span className="player-nickname"> "{p.nickname}"</span>:""}</span>
                  <span className="draft-roster-row__ineligible-tag">{p.eligCode} — {ineligibleReason}</span>
                </div>
              );
            }
            return (
              <button key={p.num} className="draft-roster-row" onClick={()=>onAssign(setIdx, side, p)}>
                <span className="draft-roster-row__name">{p.name}{p.nickname?<span className="player-nickname"> "{p.nickname}"</span>:""}</span>
                <span className="draft-roster-row__rating">{p.rating}</span>
              </button>
            );
          })
        }
      </div>
      <button className="makeup-trigger-link" onClick={()=>setForfeiting(true)}>
        <AlertTriangle size={12}/> No eligible player for this table — forfeit it
      </button>
    </div>
  );
}

// Records a forfeited table. The forfeiting team may list any member who
// hasn't played elsewhere in this match; the receiving team must list a
// present player who also hasn't played elsewhere. If one side was already
// put up before it became clear the other side can't counter, that already-
// assigned player is locked in as the receiving player automatically.
function ForfeitTableForm({ match, setIdx, used, defaultForfeitingSide, lockForfeitingSide, lockedReceivingPlayer, onForfeit, onCancel }) {
  const [forfeitingSide, setForfeitingSide] = useState(defaultForfeitingSide);
  const [forfeitingPlayer, setForfeitingPlayer] = useState(null);
  const [receivingPlayer, setReceivingPlayer] = useState(lockedReceivingPlayer ?? null);

  const receivingSide = forfeitingSide === "home" ? "away" : "home";
  const forfeitingTeam = match[`team${forfeitingSide === "home" ? "Home" : "Away"}`];
  const receivingTeam = match[`team${receivingSide === "home" ? "Home" : "Away"}`];
  const forfeitingRoster = (forfeitingTeam.roster ?? []).filter(p => !used.has(p.num));
  const receivingRoster = (receivingTeam.roster ?? []).filter(p => !used.has(p.num));

  const points = receivingPlayer ? computeForfeitPoints(match, receivingPlayer.rating) : null;

  const submit = () => {
    if (!forfeitingPlayer || !receivingPlayer) return;
    onForfeit(setIdx, forfeitingSide, forfeitingPlayer, receivingPlayer);
  };

  return (
    <div className="draft-step">
      <div className="draft-step__banner" style={{background:"#2A1F00",color:"#F59E0B"}}>
        <AlertTriangle size={13} style={{marginRight:5,verticalAlign:-2}}/> Forfeit Table {setIdx+1}
      </div>

      {!lockForfeitingSide && (
        <div className="card">
          <div className="card__title">Which team is forfeiting?</div>
          <div className="coinflip-choices">
            <button className={`coinflip-btn coinflip-btn--home ${forfeitingSide==="home"?"":"coinflip-btn--dim"}`}
              onClick={()=>{setForfeitingSide("home"); setForfeitingPlayer(null); setReceivingPlayer(null);}}>{match.teamHome.name}</button>
            <button className={`coinflip-btn coinflip-btn--away ${forfeitingSide==="away"?"":"coinflip-btn--dim"}`}
              onClick={()=>{setForfeitingSide("away"); setForfeitingPlayer(null); setReceivingPlayer(null);}}>{match.teamAway.name}</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card__title">{forfeitingTeam.name} — forfeiting player (hasn't played yet)</div>
        {forfeitingRoster.length === 0 && <div className="empty-state" style={{border:"none"}}>No eligible players left.</div>}
        <div className="draft-roster-list">
          {forfeitingRoster.slice().sort((a,b)=>b.rating-a.rating).map(p => {
            const ineligibleReason = playoffIneligibleReason(match, p);
            if (ineligibleReason) {
              return (
                <div key={p.num} className="draft-roster-row draft-roster-row--ineligible">
                  <span className="draft-roster-row__name">{p.name}{p.nickname?<span className="player-nickname"> "{p.nickname}"</span>:""}</span>
                  <span className="draft-roster-row__ineligible-tag">{p.eligCode} — {ineligibleReason}</span>
                </div>
              );
            }
            return (
              <button key={p.num} className={`draft-roster-row ${forfeitingPlayer?.num===p.num?"draft-roster-row--selected":""}`} onClick={()=>setForfeitingPlayer(p)}>
                <span className="draft-roster-row__name">{p.name}{p.nickname?<span className="player-nickname"> "{p.nickname}"</span>:""}</span>
                <span className="draft-roster-row__rating">{p.rating}</span>
              </button>
            );
          })}
        </div>
      </div>

      {!lockedReceivingPlayer && (
        <div className="card">
          <div className="card__title">{receivingTeam.name} — receiving player (present, hasn't played yet)</div>
          {receivingRoster.length === 0 && <div className="empty-state" style={{border:"none"}}>No eligible players left.</div>}
          <div className="draft-roster-list">
            {receivingRoster.slice().sort((a,b)=>b.rating-a.rating).map(p => {
              const ineligibleReason = playoffIneligibleReason(match, p);
              if (ineligibleReason) {
                return (
                  <div key={p.num} className="draft-roster-row draft-roster-row--ineligible">
                    <span className="draft-roster-row__name">{p.name}{p.nickname?<span className="player-nickname"> "{p.nickname}"</span>:""}</span>
                    <span className="draft-roster-row__ineligible-tag">{p.eligCode} — {ineligibleReason}</span>
                  </div>
                );
              }
              return (
                <button key={p.num} className={`draft-roster-row ${receivingPlayer?.num===p.num?"draft-roster-row--selected":""}`} onClick={()=>setReceivingPlayer(p)}>
                  <span className="draft-roster-row__name">{p.name}{p.nickname?<span className="player-nickname"> "{p.nickname}"</span>:""}</span>
                  <span className="draft-roster-row__rating">{p.rating}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {lockedReceivingPlayer && (
        <div className="card">
          <div className="card__title">{receivingTeam.name} — receiving player</div>
          <div style={{fontSize:13,fontWeight:700,color:"#5FCF9E"}}>{lockedReceivingPlayer.name} (already on the table)</div>
        </div>
      )}

      {receivingPlayer && (
        <div className="card" style={{textAlign:"center"}}>
          <div style={{fontSize:11,color:"#9A9A9A",marginBottom:2}}>{receivingPlayer.name} will be credited</div>
          <div style={{fontSize:22,fontFamily:"'JetBrains Mono',monospace",fontWeight:700,color:"#5FCF9E"}}>{points} pts</div>
        </div>
      )}

      <div style={{display:"flex",gap:8}}>
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={!forfeitingPlayer || !receivingPlayer}>Record Forfeit</button>
      </div>
    </div>
  );
}

// ─── Live Screen (scoring) ────────────────────────────────────────────────────
function LiveScreen({ match, activeSet, setActiveSet, onSave, pairingId }) {
  const completedCount = match.sets.filter((s) => s.complete).length;
  return (
    <div className="screen">
      <SetTabBar sets={match.sets} activeSet={activeSet} onSelect={setActiveSet} />
      <SetEntry
        key={activeSet}
        set={match.sets[activeSet]}
        match={match}
        contextType="live_match"
        contextId={pairingId}
        onUpdateSet={(updatedSet) => {
          const newSets = match.sets.map((s, i) => (i === activeSet ? updatedSet : s));
          const allDone = newSets.every((s) => s.complete);
          onSave({ ...match, sets: newSets, phase: allDone ? "confirm" : "live" });
        }}
      />
      {completedCount > 0 && <div className="completed-banner">{completedCount} of 5 sets complete</div>}
    </div>
  );
}

function SetTabBar({ sets, activeSet, onSelect }) {
  return (
    <div className="set-tabs">
      {sets.map((s, i) => (
        <button key={i} className={`set-tab ${i === activeSet ? "set-tab--active" : ""} ${s.complete ? "set-tab--done" : ""}`} onClick={() => onSelect(i)}>
          {s.complete ? <Check size={10} /> : i + 1}
        </button>
      ))}
    </div>
  );
}

export function SetEntry({ set, match, onUpdateSet, contextType, contextId }) {
  const TIMEOUTS_ENABLED = match.format === "open" || match.format === "advanced";
  const [homeVal, setHomeVal] = useState("");
  const [awayVal, setAwayVal] = useState("");
  const [inningsVal, setInningsVal] = useState("");
  const [timeoutHome, setTimeoutHome] = useState(false);
  const [timeoutAway, setTimeoutAway] = useState(false);
  const [safHomeVal, setSafHomeVal] = useState(0);
  const [safAwayVal, setSafAwayVal] = useState(0);

  if (!set.playerHome || !set.playerAway) {
    return <div className="empty-state">Waiting on lineup for this table.</div>;
  }

  const runHome = runningTotal(set.racks, "home");
  const runAway = runningTotal(set.racks, "away");
  const safHome = safetyTotal(set.racks, "home");
  const safAway = safetyTotal(set.racks, "away");
  const winner = detectWinner(set.racks, set.playerHome, set.playerAway, match.format);
  const ratingH = set.playerHome.rating;
  const ratingA = set.playerAway.rating;
  const targetH = effectiveTarget(set.playerHome, set.playerAway, match.format);
  const targetA = effectiveTarget(set.playerAway, set.playerHome, match.format);

  const pctH = targetH ? Math.min(100, Math.round((runHome / targetH) * 100)) : 0;
  const pctA = targetA ? Math.min(100, Math.round((runAway / targetA) * 100)) : 0;

  const canAdd = !set.complete && homeVal !== "" && awayVal !== "" && !isNaN(Number(homeVal)) && !isNaN(Number(awayVal));

  const addRack = () => {
    const rack = { home: Number(homeVal), away: Number(awayVal), innings: Number(inningsVal) || 0, safetyHome: safHomeVal, safetyAway: safAwayVal, ...(TIMEOUTS_ENABLED && { timeoutHome, timeoutAway }) };
    const newRacks = [...set.racks, rack];
    const newWinner = detectWinner(newRacks, set.playerHome, set.playerAway, match.format);
    onUpdateSet({ ...set, racks: newRacks, winnerSlot: newWinner, complete: newWinner !== null });
    setHomeVal(""); setAwayVal(""); setInningsVal(""); setTimeoutHome(false); setTimeoutAway(false); setSafHomeVal(0); setSafAwayVal(0);
  };

  const removeLastRack = () => {
    if (set.racks.length === 0) return;
    const newRacks = set.racks.slice(0, -1);
    const newWinner = detectWinner(newRacks, set.playerHome, set.playerAway, match.format);
    onUpdateSet({ ...set, racks: newRacks, winnerSlot: newWinner, complete: newWinner !== null });
  };

  return (
    <div className="set-entry">
      <div className="set-entry__players">
        <PlayerBar name={set.playerHome.name} rating={ratingH} target={targetH} run={runHome} pct={pctH} side="home" winner={winner === "home"} />
        <PlayerBar name={set.playerAway.name} rating={ratingA} target={targetA} run={runAway} pct={pctA} side="away" winner={winner === "away"} />
      </div>
      {set.complete && (
        <div className={`set-winner-badge set-winner-badge--${set.winnerSlot}`}>
          <Trophy size={14} />{set.winnerSlot === "home" ? set.playerHome.name : set.playerAway.name} wins this set!
        </div>
      )}
      {set.racks.length > 0 && (
        <div className="rack-history">
          <div className="rack-history__header"><span>Rack</span><span>{set.playerHome.name.split(" ")[0]}</span><span>{set.playerAway.name.split(" ")[0]}</span><span>Inn.</span></div>
          {set.racks.map((r, i) => (
            <div key={i} className="rack-history__row">
              <span className="rack-num">{i + 1}</span>
              <span className="rack-score">{r.home}{r.safetyHome ? <span className="rack-safety-tag">·{r.safetyHome}s</span> : null}</span>
              <span className="rack-score">{r.away}{r.safetyAway ? <span className="rack-safety-tag">·{r.safetyAway}s</span> : null}</span>
              <span className="rack-inn">{r.innings || "—"}</span>
            </div>
          ))}
          <div className="rack-history__totals">
            <span>Total</span>
            <span className={runHome >= ratingH ? "rack-total--done" : ""}>{runHome}{safHome ? <span className="rack-safety-tag">·{safHome}s</span> : null}</span>
            <span className={runAway >= ratingA ? "rack-total--done" : ""}>{runAway}{safAway ? <span className="rack-safety-tag">·{safAway}s</span> : null}</span>
            <span></span>
          </div>
        </div>
      )}
      {!set.complete && (
        <div className="rack-entry-form">
          <div className="rack-entry-form__title">Rack {set.racks.length + 1}</div>
          <div className="rack-entry-form__row">
            <div className="rack-entry-form__field">
              <label className="rack-entry-form__label rack-entry-form__label--home">{set.playerHome.name.split(" ")[0]}</label>
              <input className="rack-entry-form__input" type="number" min={0} value={homeVal} onChange={(e) => setHomeVal(e.target.value)} placeholder="0" />
            </div>
            <div className="rack-entry-form__field">
              <label className="rack-entry-form__label rack-entry-form__label--away">{set.playerAway.name.split(" ")[0]}</label>
              <input className="rack-entry-form__input" type="number" min={0} value={awayVal} onChange={(e) => setAwayVal(e.target.value)} placeholder="0" />
            </div>
            <div className="rack-entry-form__field rack-entry-form__field--inn">
              <label className="rack-entry-form__label">Inn.</label>
              <input className="rack-entry-form__input" type="number" min={0} value={inningsVal} onChange={(e) => setInningsVal(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="safety-row">
            <SafetyStepper label={`${set.playerHome.name.split(" ")[0]} Saf.`} value={safHomeVal} onChange={setSafHomeVal} color="home" />
            <SafetyStepper label={`${set.playerAway.name.split(" ")[0]} Saf.`} value={safAwayVal} onChange={setSafAwayVal} color="away" />
          </div>
          {TIMEOUTS_ENABLED && (
            <div className="timeout-row">
              <ToggleChip label={`${set.playerHome.name.split(" ")[0]} TO`} active={timeoutHome} color="home" onToggle={() => setTimeoutHome((v) => !v)} />
              <ToggleChip label={`${set.playerAway.name.split(" ")[0]} TO`} active={timeoutAway} color="away" onToggle={() => setTimeoutAway((v) => !v)} />
            </div>
          )}
          <div className="rack-entry-form__actions">
            {set.racks.length > 0 && <button className="btn-undo" onClick={removeLastRack}>↩ Undo</button>}
            <button className="btn-add-rack" disabled={!canAdd} onClick={addRack}><Plus size={14} /> Add Rack</button>
          </div>
        </div>
      )}
      {set.complete && set.racks.length > 0 && <button className="btn-undo" style={{ marginTop: 8 }} onClick={removeLastRack}>↩ Undo last rack</button>}
      {contextId && (
        <>
          <ShotTracker contextType={contextType} contextId={contextId} setNum={set.setNum}
            player={{ num: set.playerHome.num, name: set.playerHome.name }} teamId={match.teamHome?.id ?? null}
            opponentNum={set.playerAway.num} gameType="8ball" divisionId={match.divisionId ?? null} />
          <ShotTracker contextType={contextType} contextId={contextId} setNum={set.setNum}
            player={{ num: set.playerAway.num, name: set.playerAway.name }} teamId={match.teamAway?.id ?? null}
            opponentNum={set.playerHome.num} gameType="8ball" divisionId={match.divisionId ?? null} />
        </>
      )}
    </div>
  );
}

function SafetyStepper({ label, value, onChange, color }) {
  return (
    <div className={`safety-stepper safety-stepper--${color}`}>
      <span className="safety-stepper__label">{label}</span>
      <div className="safety-stepper__controls">
        <button type="button" className="safety-stepper__btn" onClick={() => onChange(Math.max(0, value - 1))}>−</button>
        <span className="safety-stepper__value">{value}</span>
        <button type="button" className="safety-stepper__btn" onClick={() => onChange(value + 1)}>+</button>
      </div>
    </div>
  );
}

function PlayerBar({ name, rating, target, run, pct, side, winner }) {
  const unrated = isUnrated(rating);
  return (
    <div className={`player-bar player-bar--${side} ${winner ? "player-bar--winner" : ""}`}>
      <div className="player-bar__info">
        <span className="player-bar__name">{name}{unrated && <span className="player-bar__nr">NR</span>}</span>
        <span className="player-bar__score">{run}<span className="player-bar__rating">/{target}</span></span>
      </div>
      <div className="player-bar__track">
        <div className={`player-bar__fill player-bar__fill--${side} ${pct >= 100 ? "player-bar__fill--done" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ToggleChip({ label, active, color, onToggle }) {
  return <button className={`toggle-chip toggle-chip--${color} ${active ? "toggle-chip--active" : ""}`} onClick={onToggle}>{label}</button>;
}

// ─── Makeup Confirm Screen (both sides sign off that this match is a makeup) ──
function MakeupConfirmScreen({ match, onSave }) {
  const [flagging, setFlagging] = useState(null);
  const [note, setNote] = useState("");
  const m = match.makeup;
  const shortTeamName = m.shortTeam === "home" ? match.teamHome.name : match.teamAway.name;
  const completedCount = match.sets.filter(s => s.complete).length;

  const confirmSide = (side) => {
    onSave({ ...match, makeup: { ...m, [side === "home" ? "confirmedHome" : "confirmedAway"]: true } });
  };
  const submitFlag = () => {
    onSave({ ...match, makeup: { ...m, confirmedHome: false, confirmedAway: false, disputedBy: flagging, disputeNote: note.trim() || "No details given." } });
    setFlagging(null); setNote("");
  };
  const clearDispute = () => {
    onSave({ ...match, makeup: { ...m, disputedBy: null, disputeNote: null } });
  };
  const cancelMakeup = () => {
    onSave({ ...match, makeup: null });
  };

  return (
    <div className="screen">
      <div className="screen__eyebrow"><AlertTriangle size={12}/> Makeup Reported</div>
      <div className="screen__title">Confirm This Is a Makeup</div>
      <div className="card" style={{borderColor:"#92400E",background:"#2A1F00"}}>
        <div style={{fontSize:12.5,fontWeight:700,color:"#F59E0B",marginBottom:4}}>{shortTeamName} is short players tonight</div>
        <div style={{fontSize:12,color:"#E0E0E0",lineHeight:1.4}}>{m.reason}</div>
      </div>
      <div style={{fontSize:11.5,color:"#9A9A9A",lineHeight:1.5}}>
        {completedCount > 0
          ? `${completedCount} of 5 tables already played tonight keep their real score. The rest will show as "Makeup Pending" in team history until they're rescheduled & played.`
          : `Once both teams confirm, tonight's match is recorded with no score — it'll show as "Makeup Pending" in team history until it's rescheduled & played.`}
      </div>

      {m.disputedBy && (
        <div className="dispute-banner">
          <div className="dispute-banner__title">{m.disputedBy === "home" ? match.teamHome.name : match.teamAway.name} flagged a problem</div>
          <div className="dispute-banner__note">{m.disputeNote}</div>
          <button className="btn-secondary" onClick={clearDispute}>Reviewed together — clear flag</button>
        </div>
      )}

      {!m.disputedBy && (
        <div className="confirm-row">
          <ConfirmCard teamName={match.teamHome.name} side="home" confirmed={m.confirmedHome}
            onConfirm={() => confirmSide("home")} onFlag={() => setFlagging("home")} confirmLabel="Confirm Makeup" />
          <ConfirmCard teamName={match.teamAway.name} side="away" confirmed={m.confirmedAway}
            onConfirm={() => confirmSide("away")} onFlag={() => setFlagging("away")} confirmLabel="Confirm Makeup" />
        </div>
      )}

      {flagging && (
        <div className="card">
          <div className="card__title">What looks wrong?</div>
          <textarea className="flag-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. We actually have 5 shooters"/>
          <div style={{display:"flex",gap:8}}>
            <button className="btn-secondary" onClick={()=>setFlagging(null)}>Cancel</button>
            <button className="btn-primary" onClick={submitFlag}>Submit Flag</button>
          </div>
        </div>
      )}

      <SecondaryBtn onClick={cancelMakeup}>{completedCount > 0 ? "Cancel — we can finish tonight after all" : "Cancel — we can play tonight after all"}</SecondaryBtn>
    </div>
  );
}

// ─── Confirm Screen (both sides sign off before archiving) ───────────────────
// Two sub-steps now, not one: first each PRESENT side confirms (a side
// marked unavailable -- e.g. the other team doesn't have the app tonight --
// shows a plain "not present" indicator instead of a card, same as the
// makeup flow already does at the "match night" level). Once every present
// side has confirmed, a final explicit "Submit Final Score" review replaces
// the confirm cards -- that review step, not the per-side confirms alone, is
// what actually triggers archiving (see submissionReady in the parent's
// effect). This gives BOTH scoring scenarios (one team scoring for both
// sides vs. two teams each confirming their own) the same unmistakable final
// action, instead of solo mode silently archiving off a single tap that was
// never meant to double as a safeguard.
function ConfirmScreen({ match, onSave }) {
  const [flagging, setFlagging] = useState(null); // "home" | "away" | null
  const [noteHome, setNoteHome] = useState("");
  const [noteAway, setNoteAway] = useState("");

  const homeSets = match.sets.filter((s) => s.winnerSlot === "home").length;
  const awaySets = match.sets.filter((s) => s.winnerSlot === "away").length;
  const matchWinner = homeSets > awaySets ? match.teamHome.name : awaySets > homeSets ? match.teamAway.name : "Tie";

  const confirmSide = (side) => {
    onSave({ ...match, [side === "home" ? "confirmedHome" : "confirmedAway"]: true });
  };
  const submitFlag = (side) => {
    const note = (side === "home" ? noteHome : noteAway).trim();
    onSave({ ...match, confirmedHome: false, confirmedAway: false, disputedBy: side, disputeNote: note || "No details given." });
    setFlagging(null); setNoteHome(""); setNoteAway("");
  };
  const clearDispute = () => {
    onSave({ ...match, disputedBy: null, disputeNote: null });
  };

  const homeOk = match.unavailableHome || match.confirmedHome;
  const awayOk = match.unavailableAway || match.confirmedAway;
  const readyForFinalReview = homeOk && awayOk && !match.disputedBy;

  if (readyForFinalReview) {
    return <FinalSubmitScreen match={match} onSave={onSave} homeSets={homeSets} awaySets={awaySets} matchWinner={matchWinner} />;
  }

  return (
    <div className="screen">
      <div className="screen__eyebrow"><Check size={12}/> Match Complete</div>
      <div className="screen__title">Confirm Final Score</div>
      <div className="done-banner">
        <div className="done-banner__label">Result</div>
        <div className="done-banner__winner">{matchWinner}</div>
        <div className="done-banner__record">{homeSets}–{awaySets} sets</div>
      </div>
      <div className="sets-summary">
        {match.sets.map((s) => (
          <div key={s.setNum} className="sets-summary__row">
            <span className={`sets-summary__name ${s.winnerSlot === "home" ? "sets-summary__name--won" : ""}`}>{s.playerHome?.name}</span>
            <span className="sets-summary__score">{runningTotal(s.racks, "home")}–{runningTotal(s.racks, "away")}</span>
            <span className={`sets-summary__name sets-summary__name--right ${s.winnerSlot === "away" ? "sets-summary__name--won" : ""}`}>{s.playerAway?.name}</span>
          </div>
        ))}
      </div>

      {match.disputedBy && (
        <div className="dispute-banner">
          <div className="dispute-banner__title">{match.disputedBy === "home" ? match.teamHome.name : match.teamAway.name} flagged a problem</div>
          <div className="dispute-banner__note">{match.disputeNote}</div>
          <button className="btn-secondary" onClick={clearDispute}>Reviewed together — clear flag</button>
        </div>
      )}

      {!match.disputedBy && (
        <div className="confirm-row">
          {match.unavailableHome
            ? <UnavailableCard teamName={match.teamHome.name} side="home" />
            : <ConfirmCard teamName={match.teamHome.name} side="home" confirmed={match.confirmedHome}
                onConfirm={() => confirmSide("home")} onFlag={() => setFlagging("home")} />}
          {match.unavailableAway
            ? <UnavailableCard teamName={match.teamAway.name} side="away" />
            : <ConfirmCard teamName={match.teamAway.name} side="away" confirmed={match.confirmedAway}
                onConfirm={() => confirmSide("away")} onFlag={() => setFlagging("away")} />}
        </div>
      )}

      {flagging && (
        <div className="card">
          <div className="card__title">What looks wrong?</div>
          <textarea className="flag-textarea" rows={3}
            value={flagging === "home" ? noteHome : noteAway}
            onChange={(e) => (flagging === "home" ? setNoteHome(e.target.value) : setNoteAway(e.target.value))}
            placeholder="e.g. Set 3 score looks off" />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-secondary" onClick={() => setFlagging(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => submitFlag(flagging)}>Submit Flag</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmCard({ teamName, side, confirmed, onConfirm, onFlag, confirmLabel }) {
  return (
    <div className={`confirm-card confirm-card--${side} ${confirmed ? "confirm-card--confirmed" : ""}`}>
      <div className="confirm-card__team">{teamName}</div>
      {confirmed ? (
        <div className="confirm-card__status"><Check size={14} /> Confirmed</div>
      ) : (
        <>
          <button className="confirm-card__btn" onClick={onConfirm}>{confirmLabel || "Confirm Score"}</button>
          <button className="confirm-card__flag" onClick={onFlag}>Flag a problem</button>
        </>
      )}
    </div>
  );
}

// Stands in for a ConfirmCard when a side has been marked unavailable (e.g.
// the other team doesn't have the app tonight and is keeping score on
// paper) -- makes clear in the UI that this team simply isn't confirming
// in-app, rather than looking like an ignored, still-pending action item.
function UnavailableCard({ teamName, side }) {
  return (
    <div className={`confirm-card confirm-card--${side}`} style={{opacity:0.65}}>
      <div className="confirm-card__team">{teamName}</div>
      <div className="confirm-card__status" style={{color:"#9A9A9A"}}>Not present tonight</div>
    </div>
  );
}

// The real safeguard: one explicit, unmistakable final action, shown after
// every present side's confirm state is satisfied. In solo mode (either
// side marked unavailable) this doubles as the closest thing to a second
// pair of eyes the match is going to get, so it requires reviewing the full
// set list and checking an acknowledgment box before Submit unlocks. In
// dual mode both real confirms already happened, so this is a lighter final
// "make it official" tap -- but it's still a distinct, deliberate action in
// both cases, not something that fires automatically the moment the last
// checkbox is ticked.
function FinalSubmitScreen({ match, onSave, homeSets, awaySets, matchWinner }) {
  const solo = match.unavailableHome || match.unavailableAway;
  const unavailableTeamName = match.unavailableHome ? match.teamHome.name : match.unavailableAway ? match.teamAway.name : null;
  const [ack, setAck] = useState(false);

  const submit = () => {
    onSave({ ...match, submissionReady: true });
  };

  return (
    <div className="screen">
      <div className="screen__eyebrow"><Check size={12}/> Final Review</div>
      <div className="screen__title">Submit Final Score</div>
      <div className="done-banner">
        <div className="done-banner__label">Result</div>
        <div className="done-banner__winner">{matchWinner}</div>
        <div className="done-banner__record">{homeSets}–{awaySets} sets</div>
      </div>
      <div className="sets-summary">
        {match.sets.map((s) => (
          <div key={s.setNum} className="sets-summary__row">
            <span className={`sets-summary__name ${s.winnerSlot === "home" ? "sets-summary__name--won" : ""}`}>{s.playerHome?.name}</span>
            <span className="sets-summary__score">{s.forfeited ? `FF · ${s.forfeitPoints}pt` : `${runningTotal(s.racks, "home")}–${runningTotal(s.racks, "away")}`}</span>
            <span className={`sets-summary__name sets-summary__name--right ${s.winnerSlot === "away" ? "sets-summary__name--won" : ""}`}>{s.playerAway?.name}</span>
          </div>
        ))}
      </div>

      {solo ? (
        <div className="card" style={{borderColor:"#92400E",background:"#2A1F00"}}>
          <div style={{fontSize:12.5,fontWeight:700,color:"#F59E0B",marginBottom:6}}>Scored for both teams</div>
          <div style={{fontSize:11.5,color:"#E0E0E0",lineHeight:1.5,marginBottom:12}}>
            {unavailableTeamName} wasn't confirming in the app tonight, so this score is only checked by one side. Double-check every set above before submitting — once you submit, this becomes the official record for both teams.
          </div>
          <label style={{display:"flex",alignItems:"flex-start",gap:9,fontSize:12.5,color:"#E0E0E0",cursor:"pointer"}}>
            <input type="checkbox" checked={ack} onChange={(e)=>setAck(e.target.checked)} style={{marginTop:2,flexShrink:0}} />
            I've reviewed every set above and confirm this score is accurate for both teams.
          </label>
        </div>
      ) : (
        <div className="card" style={{textAlign:"center"}}>
          <div style={{fontSize:12,color:"#9A9A9A",lineHeight:1.5}}>
            Both teams have confirmed. Submitting locks this in as the official final score.
          </div>
        </div>
      )}

      <button className="btn-primary" onClick={submit} disabled={solo && !ack}>Submit Final Score</button>
    </div>
  );
}


// ─── Done Screen ──────────────────────────────────────────────────────────────
function DoneScreen({ match, onReset }) {
  const homeSets = match.sets.filter((s) => s.winnerSlot === "home").length;
  const awaySets = match.sets.filter((s) => s.winnerSlot === "away").length;
  const completedCount = homeSets + awaySets;

  if (match.makeup) {
    const matchWinner = completedCount > 0 ? (homeSets > awaySets ? match.teamHome.name : awaySets > homeSets ? match.teamAway.name : "Tie so far") : null;
    return (
      <div className="screen">
        <div className="done-banner" style={{background:"#2A1F00",borderColor:"#92400E"}}>
          <div className="done-banner__label" style={{color:"#F59E0B"}}>Makeup Pending</div>
          <div className="done-banner__winner">{completedCount > 0 ? `${matchWinner} — so far` : "No score recorded"}</div>
          <div className="done-banner__record">{completedCount > 0 ? `${homeSets}–${awaySets} sets played · ${5-completedCount} remaining` : "Reschedule & play to complete this match"}</div>
        </div>
        <div className="archived-badge"><Check size={12}/> Saved to league history as pending</div>
        {completedCount > 0 && (
          <div className="sets-summary">
            {match.sets.filter(s=>s.complete).map((s) => {
              const runH = runningTotal(s.racks, "home");
              const runA = runningTotal(s.racks, "away");
              return (
                <div key={s.setNum} className="sets-summary__row">
                  <span className={`sets-summary__name ${s.winnerSlot === "home" ? "sets-summary__name--won" : ""}`}>{s.playerHome?.name}</span>
                  <span className="sets-summary__score">{s.forfeited ? `FF · ${s.forfeitPoints}pt` : `${runH}–${runA}`}</span>
                  <span className={`sets-summary__name sets-summary__name--right ${s.winnerSlot === "away" ? "sets-summary__name--won" : ""}`}>{s.playerAway?.name}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="card">
          <div className="card__title">Reason for remaining tables</div>
          <div style={{fontSize:12.5,color:"#E0E0E0",lineHeight:1.5}}>{match.makeup.reason}</div>
        </div>
        <SecondaryBtn onClick={onReset}>Start New Match</SecondaryBtn>
      </div>
    );
  }

  const matchWinner = homeSets > awaySets ? match.teamHome.name : awaySets > homeSets ? match.teamAway.name : "Tie";

  return (
    <div className="screen">
      <div className="done-banner">
        <div className="done-banner__label">Match Complete</div>
        <div className="done-banner__winner">{matchWinner}</div>
        <div className="done-banner__record">{homeSets}–{awaySets} sets</div>
      </div>
      <div className="archived-badge"><Check size={12}/> Saved to league history</div>
      <div className="sets-summary">
        {match.sets.map((s) => {
          const runH = runningTotal(s.racks, "home");
          const runA = runningTotal(s.racks, "away");
          return (
            <div key={s.setNum} className="sets-summary__row">
              <span className={`sets-summary__name ${s.winnerSlot === "home" ? "sets-summary__name--won" : ""}`}>{s.playerHome?.name}</span>
              <span className="sets-summary__score">{s.forfeited ? `FF · ${s.forfeitPoints}pt` : `${runH}–${runA}`}</span>
              <span className={`sets-summary__name sets-summary__name--right ${s.winnerSlot === "away" ? "sets-summary__name--won" : ""}`}>{s.playerAway?.name}</span>
            </div>
          );
        })}
      </div>
      <SecondaryBtn onClick={onReset}>Start New Match</SecondaryBtn>
    </div>
  );
}

function SecondaryBtn({ children, onClick }) {
  return <button className="btn-secondary" onClick={onClick}>{children}</button>;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
// Exported (alongside SetEntry) so other pages that reuse the rack-entry UI
// -- e.g. AdminApp.jsx's manager-only manual match entry -- render with the
// exact same styling live scoring uses, instead of a second, drifting copy.
export const css = `
.draft-roster-row--ineligible{cursor:default;background:#1A1010;border-color:#3A1F1F;opacity:0.85;flex-wrap:wrap;gap:4px;}
.draft-roster-row--ineligible .draft-roster-row__name{color:#9A9A9A;text-decoration:line-through;text-decoration-color:#5A2A2A;}
.draft-roster-row__ineligible-tag{font-size:10px;color:#F87171;font-weight:700;}

${shotTrackerCss}
@import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html,body{width:100%;overflow-x:hidden;}
.app { font-family: 'Archivo', sans-serif; background: #0E0E0E; min-height: 100vh; width:100%; padding: 0 0 40px; max-width: 480px; margin: 0 auto; color: #FFF; overflow-x:hidden; }

.header-info { background: #0B3D2E; background-image: radial-gradient(circle at 50% 0%, #0F4A37 0%, #0B3D2E 70%); padding: 8px 16px 12px; margin-bottom: 14px; }
.header-info__row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; min-height: 15px; }
.header-info__season { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; color: #F59E0B; }
.header__sync { display: flex; align-items: center; gap: 5px; margin-left: auto; }
.header__sync-label { font-size: 10px; font-weight: 600; }
.header__match { display: flex; flex-direction: column; gap: 1px; }
.header__venue { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #9FC4B4; }
.header__teams { font-size: 15px; font-family: 'Archivo Black', sans-serif; color: #FFF; }
.vs { font-family: 'Archivo', sans-serif; font-weight: 400; font-size: 12px; color: #7FA593; margin: 0 4px; }

.screen { padding: 0 14px; display: flex; flex-direction: column; gap: 12px; }
.screen__eyebrow { display: flex; align-items: center; gap: 5px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #5FCF9E; }
.screen__title { font-family: 'Archivo Black', sans-serif; font-size: 22px; color: #FFF; margin-top: -4px; }

.card { background: #1C1C1C; border: 1.5px solid #2E2E2E; border-radius: 14px; padding: 14px; }

.coinflip-choices{display:flex;flex-direction:column;gap:10px;}
.coinflip-btn{display:flex;flex-direction:column;align-items:center;gap:4px;padding:18px;border-radius:14px;border:1.5px solid #3A3A3A;background:#1C1C1C;color:#FFF;font-family:'Archivo',sans-serif;font-size:16px;font-weight:700;cursor:pointer;}
.coinflip-btn--home{border-color:#1F6B4A;}
.coinflip-btn--away{border-color:#1E3A5F;}
.coinflip-btn--dim{opacity:0.45;}
.makeup-trigger-link{background:none;border:none;color:#9A9A9A;font-size:11.5px;font-weight:600;text-decoration:underline;cursor:pointer;display:flex;align-items:center;gap:5px;justify-content:center;padding:8px;}
.coinflip-btn__sub{font-size:10.5px;font-weight:600;color:#6A6A6A;text-transform:uppercase;letter-spacing:0.05em;}

.draft-step{display:flex;flex-direction:column;gap:10px;}
.draft-step__banner{padding:12px 14px;border-radius:12px;font-size:13px;font-weight:700;text-align:center;}
.draft-step__banner--home{background:#16332A;color:#5FCF9E;border:1.5px solid #1F6B4A;}
.draft-step__banner--away{background:#16273A;color:#6FA8DC;border:1.5px solid #1E3A5F;}
.draft-roster-list{display:flex;flex-direction:column;gap:6px;}
.draft-roster-row{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:10px;color:#E0E0E0;font-family:'Archivo',sans-serif;font-size:13px;font-weight:600;cursor:pointer;}
.draft-roster-row--selected{border-color:#5FCF9E;background:#0F2D1F;}
.draft-roster-row__rating{font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:#5FCF9E;background:#16332A;padding:2px 9px;border-radius:7px;}
.draft-matchup-display{display:flex;align-items:center;justify-content:center;gap:10px;font-size:14px;font-weight:700;}
.draft-matchup-display__home{color:#5FCF9E;}
.draft-matchup-display__away{color:#6FA8DC;}
.draft-matchup-display__vs{color:#5A5A5A;font-size:11px;font-weight:600;}
.player-nickname{font-size:11px;color:#6A6A6A;font-style:italic;}

.form-label { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #9A9A9A; margin-bottom: 6px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.input { width: 100%; background: #121212; border: 1.5px solid #3A3A3A; border-radius: 9px; padding: 10px 12px; font-family: 'Archivo', sans-serif; font-size: 16px; color: #FFF; outline: none; }
.input:focus { border-color: #5FCF9E; }
.input-wrap { position: relative; }
.input-wrap .input { padding-right: 40px; }
.input-eye { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; color: #6A6A6A; cursor: pointer; display: flex; align-items: center; }
.error-msg { font-size: 11.5px; color: #F87171; font-weight: 600; }
input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; }

.btn-primary { width: 100%; background: #5FCF9E; color: #0B1F16; font-family: 'Archivo', sans-serif; font-size: 14px; font-weight: 700; padding: 14px; border-radius: 12px; border: none; cursor: pointer; letter-spacing: 0.02em; }
.btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-secondary { width: 100%; background: #1C1C1C; color: #E0E0E0; font-family: 'Archivo', sans-serif; font-size: 14px; font-weight: 600; padding: 13px; border-radius: 12px; border: 1.5px solid #3A3A3A; cursor: pointer; }

.set-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.set-tab { flex: 1; height: 36px; border-radius: 9px; border: 1.5px solid #3A3A3A; background: #1C1C1C; color: #9A9A9A; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.set-tab--active { background: #0B3D2E; border-color: #0B3D2E; color: #FFF; }
.set-tab--done { background: #16332A; border-color: #1F6B4A; color: #5FCF9E; }
.set-tab--active.set-tab--done { background: #0B3D2E; border-color: #5FCF9E; }
.set-tab--locked{ opacity:.35; cursor:not-allowed; }
.set-tab--live{ border-color:#F59E0B; color:#F59E0B; }

.set-entry__players { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.player-bar { background: #1C1C1C; border: 1.5px solid #2E2E2E; border-radius: 12px; padding: 10px 12px 8px; }
.player-bar--winner { border-color: transparent; }
.player-bar--home.player-bar--winner { border-color: #1F6B4A; background: #0F2D1F; }
.player-bar--away.player-bar--winner { border-color: #1E3A5F; background: #0D1E33; }
.player-bar__info { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.player-bar__name { font-size: 13px; font-weight: 700; color: #E0E0E0; }
.player-bar__nr { font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 800; color: #F59E0B; background: #2A2410; padding: 1px 5px; border-radius: 5px; margin-left: 5px; vertical-align: 1px; }
.player-bar__score { font-family: 'JetBrains Mono', monospace; font-size: 16px; font-weight: 700; color: #FFF; }
.player-bar__rating { font-size: 11px; color: #6A6A6A; }
.player-bar__track { height: 6px; background: #2E2E2E; border-radius: 3px; overflow: hidden; }
.player-bar__fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.player-bar__fill--home { background: #5FCF9E; }
.player-bar__fill--away { background: #6FA8DC; }
.player-bar__fill--done { background: #FFD700; }

.set-winner-badge { display: flex; align-items: center; justify-content: center; gap: 7px; font-size: 14px; font-weight: 700; padding: 11px 14px; border-radius: 10px; margin-bottom: 4px; }
.set-winner-badge--home { color: #5FCF9E; background: #16332A; border: 1.5px solid #1F6B4A; }
.set-winner-badge--away { color: #6FA8DC; background: #16273A; border: 1.5px solid #1E3A5F; }

.rack-history { background: #141414; border: 1px solid #2E2E2E; border-radius: 10px; overflow: hidden; margin-bottom: 10px; }
.rack-history__header { display: grid; grid-template-columns: 36px 1fr 1fr 44px; padding: 6px 10px; background: #1E1E1E; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #5A5A5A; }
.rack-history__row { display: grid; grid-template-columns: 36px 1fr 1fr 44px; padding: 7px 10px; border-top: 1px solid #1E1E1E; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #E0E0E0; align-items: center; }
.rack-num { color: #5A5A5A; font-size: 10px; }
.rack-score { font-weight: 700; }
.rack-inn { color: #6A6A6A; font-size: 11px; }
.rack-history__totals { display: grid; grid-template-columns: 36px 1fr 1fr 44px; padding: 7px 10px; border-top: 2px solid #3A3A3A; font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; color: #FFF; background: #1A1A1A; }
.rack-history__totals span:first-child { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #5A5A5A; font-family: 'Archivo', sans-serif; }
.rack-total--done { color: #FFD700; }

.rack-entry-form { background: #1C1C1C; border: 1.5px solid #2E2E2E; border-radius: 14px; padding: 14px; }
.rack-entry-form__title { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: #5FCF9E; margin-bottom: 10px; }
.rack-entry-form__row { display: flex; gap: 8px; margin-bottom: 10px; }
.rack-entry-form__field { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.rack-entry-form__field--inn { flex: 0.7; }
.rack-entry-form__label { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #6A6A6A; }
.rack-entry-form__label--home { color: #5FCF9E; }
.rack-entry-form__label--away { color: #6FA8DC; }
.rack-entry-form__input { width: 100%; background: #121212; border: 1.5px solid #3A3A3A; border-radius: 9px; padding: 12px 10px; font-family: 'JetBrains Mono', monospace; font-size: 20px; font-weight: 700; color: #FFF; text-align: center; outline: none; }
.rack-entry-form__input:focus { border-color: #5FCF9E; }
.rack-entry-form__actions { display: flex; gap: 8px; align-items: center; }
.btn-add-rack { flex: 1; background: #5FCF9E; color: #0B1F16; font-family: 'Archivo', sans-serif; font-size: 14px; font-weight: 700; padding: 13px; border-radius: 10px; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
.btn-add-rack:disabled { opacity: 0.3; cursor: not-allowed; }
.btn-undo { background: #1E1E1E; border: 1.5px solid #3A3A3A; color: #9A9A9A; font-family: 'Archivo', sans-serif; font-size: 12px; font-weight: 600; padding: 10px 14px; border-radius: 10px; cursor: pointer; }

.timeout-row { display: flex; gap: 8px; margin-bottom: 10px; }
.toggle-chip { flex: 1; padding: 8px; border-radius: 8px; font-size: 11px; font-weight: 700; cursor: pointer; border: 1.5px solid #3A3A3A; background: #121212; color: #5A5A5A; font-family: 'Archivo', sans-serif; }
.toggle-chip--home.toggle-chip--active { background: #16332A; border-color: #1F6B4A; color: #5FCF9E; }
.toggle-chip--away.toggle-chip--active { background: #16273A; border-color: #1E3A5F; color: #6FA8DC; }

.rack-safety-tag { font-size: 9.5px; color: #F59E0B; font-weight: 700; margin-left: 3px; }

.safety-row { display: flex; gap: 8px; margin-bottom: 10px; }
.safety-stepper { flex: 1; display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 8px; border: 1.5px solid #3A3A3A; background: #121212; }
.safety-stepper--home { border-color: #1F6B4A; }
.safety-stepper--away { border-color: #1E3A5F; }
.safety-stepper__label { font-size: 10px; font-weight: 700; color: #9A9A9A; }
.safety-stepper__controls { display: flex; align-items: center; gap: 8px; }
.safety-stepper__btn { width: 22px; height: 22px; border-radius: 6px; border: 1px solid #3A3A3A; background: #1C1C1C; color: #E0E0E0; font-size: 14px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; line-height: 1; }
.safety-stepper__value { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; color: #F59E0B; min-width: 14px; text-align: center; }

.confirm-row { display: flex; gap: 10px; }
.confirm-card { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 14px 10px; border-radius: 12px; border: 1.5px solid #3A3A3A; background: #1C1C1C; }
.confirm-card--home { border-color: #1F6B4A; }
.confirm-card--away { border-color: #1E3A5F; }
.confirm-card--confirmed.confirm-card--home { background: #0F2D1F; }
.confirm-card--confirmed.confirm-card--away { background: #0D1E33; }
.confirm-card__team { font-size: 12.5px; font-weight: 700; color: #E0E0E0; text-align: center; }
.confirm-card__btn { width: 100%; background: #5FCF9E; color: #0B1F16; font-family: 'Archivo', sans-serif; font-size: 12.5px; font-weight: 700; padding: 10px; border-radius: 9px; border: none; cursor: pointer; }
.confirm-card__flag { background: none; border: none; color: #9A9A9A; font-family: 'Archivo', sans-serif; font-size: 10.5px; font-weight: 600; text-decoration: underline; cursor: pointer; padding: 0; }
.confirm-card__status { display: flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 700; color: #5FCF9E; }

.dispute-banner { background: #2A1F00; border: 1.5px solid #92400E; border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.dispute-banner__title { font-size: 12.5px; font-weight: 700; color: #F59E0B; }
.dispute-banner__note { font-size: 12px; color: #E0E0E0; line-height: 1.4; }

.flag-textarea { width: 100%; background: #121212; border: 1.5px solid #3A3A3A; border-radius: 9px; padding: 10px; font-family: 'Archivo', sans-serif; font-size: 13px; color: #E0E0E0; resize: vertical; outline: none; margin-bottom: 10px; }
.flag-textarea:focus { border-color: #5FCF9E; }

.archived-badge { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 11.5px; font-weight: 700; color: #5FCF9E; background: #16332A; border: 1.5px solid #1F6B4A; border-radius: 9px; padding: 8px; }

.completed-banner { text-align: center; font-size: 11px; font-weight: 700; color: #5A5A5A; letter-spacing: 0.04em; }
.empty-state{font-size:12.5px;color:#5A5A5A;text-align:center;padding:24px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:10px;}

.done-banner { background: #0B3D2E; border-radius: 16px; padding: 22px 16px; text-align: center; }
.done-banner__label { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #9FC4B4; margin-bottom: 6px; }
.done-banner__winner { font-family: 'Archivo Black', sans-serif; font-size: 26px; color: #FFF; margin-bottom: 4px; }
.done-banner__record { font-size: 13px; color: #9FC4B4; font-weight: 600; }
.sets-summary { background: #1C1C1C; border: 1.5px solid #2E2E2E; border-radius: 12px; overflow: hidden; }
.sets-summary__row { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 10px 14px; border-bottom: 1px solid #2E2E2E; gap: 8px; }
.sets-summary__row:last-child { border-bottom: none; }
.sets-summary__name { font-size: 12px; font-weight: 600; color: #5A5A5A; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sets-summary__name--right { text-align: right; }
.sets-summary__name--won { color: #5FCF9E; font-weight: 700; }
.sets-summary__score { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 700; color: #FFF; text-align: center; white-space: nowrap; }

.scorer-status { display: flex; gap: 8px; padding: 0 14px; flex-wrap: wrap; }
.scorer-status__badge { display: flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700; color: #9FC4B4; background: #0F2D1F; border: 1px solid #1F6B4A; border-radius: 8px; padding: 5px 9px; }
.scorer-status__badge--unavailable { color: #9A9A9A; background: #1C1C1C; border-color: #3A3A3A; }
.scorer-status__badge--empty { color: #F59E0B; background: #2A2410; border-color: #92400E; }
.scorer-status__mark-btn { background: none; border: none; color: #F59E0B; font-size: 10px; font-weight: 700; text-decoration: underline; cursor: pointer; padding: 0; }

@keyframes spin { to { transform: rotate(360deg); } }
.spin { animation: spin 1s linear infinite; }
`;
