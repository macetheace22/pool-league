import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BarChart3, Trophy, Dumbbell, Award, ChevronRight, MapPin, Calendar, Building2,
  Newspaper, Wrench, AlertCircle, Users, Check, TrendingUp, Settings2, Upload,
} from "lucide-react";
import { useAuth } from "./AuthContext";
import { PageHeader, TabBar, navItemsForRole, shellCss, AccessDenied } from "./Shell";
import { css, Loader } from "./AdminApp";
import * as db from "./db";
import { getActiveTeamIds } from "./teamMembership";

// Free-text schedule dates are typically M/D/YYYY (same format used
// throughout the rest of the app) -- an unparseable value is treated as
// "no date" rather than guessing.
function parseWeekDate(str) {
  const timestamp = db.parseScheduleDate(str);
  return timestamp == null ? null : new Date(timestamp);
}
function opponentName(pairing, teamId, teams) {
  const oppId = pairing.homeTeamId === teamId ? pairing.awayTeamId : pairing.homeTeamId;
  return teams.find(t => t.id === oppId)?.name ?? "TBD";
}
// Same win/loss/points-string logic MatchRow uses below, generalized to a
// match tagged with _teamId (see db.mostRecentCompletedMatch) instead of
// always reading it off a single overview.team.id.
function matchResultLabel(m) {
  const isHome = m.team_home_id === m._teamId;
  const myPts = isHome ? m.team_home_points : m.team_away_points;
  const oppPts = isHome ? m.team_away_points : m.team_home_points;
  return m.is_makeup_pending ? "Makeup Pending" : (myPts != null && oppPts != null ? `${myPts} – ${oppPts}` : "—");
}
function matchOpponentName(m) {
  const isHome = m.team_home_id === m._teamId;
  return isHome ? m.team_away_name : m.team_home_name;
}

// ─── Home ───────────────────────────────────────────────────────────────────
export function Home() {
  const { profile } = useAuth();
  // undefined = loading, [] = not linked to any current team. One entry per
  // ACTIVE team the player is on right now -- see db.getMyTeamsOverview for
  // why this can genuinely be more than one.
  const [teamOverviews, setTeamOverviews] = useState(undefined);
  const [snapshotStats, setSnapshotStats] = useState(undefined); // undefined = loading/n-a, null = no player_num linked
  const [recentPractice, setRecentPractice] = useState(undefined); // undefined = loading, null = none

  useEffect(() => {
    if (!profile) return;
    setTeamOverviews(undefined);
    db.getMyTeamsOverview(profile).then(setTeamOverviews).catch(() => setTeamOverviews([]));
  }, [profile?.team_memberships, profile?.player_num]);

  useEffect(() => {
    if (!profile?.id) return;
    db.listMyPracticeGames(profile.id).then(games => setRecentPractice(games[0] ?? null)).catch(() => setRecentPractice(null));
  }, [profile?.id]);

  useEffect(() => {
    if (teamOverviews === undefined) return;
    if (!profile?.player_num || teamOverviews.length === 0) { setSnapshotStats(null); return; }
    setSnapshotStats(undefined);
    Promise.all(teamOverviews.map(async (o) => {
      const [teamRank, mvpRank] = await Promise.all([
        db.getTeamStandingsRow(o.team.id, o.team.division_id),
        db.getPlayerMvpRankRow(profile.player_num, o.team.division_id),
      ]);
      return { teamId: o.team.id, teamName: o.team.name, teamRank, mvpRank };
    })).then(setSnapshotStats).catch(() => setSnapshotStats([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamOverviews, profile?.player_num]);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  // One nearest-upcoming-match entry per team, soonest first -- collapses to
  // the single card it always used to be when there's only one team.
  const nextMatches = (teamOverviews ?? []).map(o => {
    const upcoming = o.myWeeks
      .map(w => ({ ...w, _date: parseWeekDate(w.date) }))
      .filter(w => w._date && w._date >= today)
      .sort((a, b) => a._date - b._date);
    const nextWeek = upcoming[0];
    if (!nextWeek) return null;
    const p = nextWeek.pairings[0];
    return {
      teamId: o.team.id, teamName: o.team.name, _date: nextWeek._date,
      date: nextWeek.date, week: nextWeek.week, venue: o.team.venue,
      opponent: opponentName(p, o.team.id, o.teams),
    };
  }).filter(Boolean).sort((a, b) => a._date - b._date);
  const showTeamLabels = (teamOverviews ?? []).length > 1;

  const recentMatch = teamOverviews ? db.mostRecentCompletedMatch(teamOverviews) : undefined;
  const homeLoading = !!profile && (teamOverviews === undefined || snapshotStats === undefined || recentPractice === undefined);

  const areas = [
    { key: "stats", label: "My Stats", desc: "Your record & stats", icon: BarChart3, path: "/my-stats" },
    { key: "leagues", label: "Leagues", desc: "Matches, standings & more", icon: Trophy, path: "/leagues" },
    { key: "practice", label: "Practice", desc: "Play & track practice games", icon: Dumbbell, path: "/practice" },
    { key: "tournaments", label: "Tournaments", desc: "Brackets & tournament play", icon: Award, path: "/tournaments" },
    ...(profile?.role === "manager"
      ? [{ key: "office", label: "League Office", desc: "Full league administration", icon: Wrench, path: "/league-office" }]
      : []),
  ];

  return (
    <div className="app">
      <style>{css}</style>
      <style>{shellCss}</style>
      <style>{dashboardCss}</style>
      <PageHeader title="Home" subtitle={profile ? `Welcome, ${profile.username}` : undefined} hideBack />
      <div className="tab-content">
        {homeLoading ? <Loader /> : <>
        {nextMatches.map(nm => (
          <Link key={nm.teamId} to="/leagues" className="next-match-card">
            <div className="next-match-card__eyebrow">
              Next Match{nm.week ? ` · Week ${nm.week}` : ""}{showTeamLabels ? ` · ${nm.teamName}` : ""}
            </div>
            <div className="next-match-card__opponent">vs {nm.opponent}</div>
            <div className="next-match-card__meta">
              <Calendar size={11} /> {nm.date}
              {nm.venue && <><MapPin size={11} style={{marginLeft:8}} /> {nm.venue}</>}
            </div>
          </Link>
        ))}

        <div className="area-grid">
          {areas.map(a => {
            const Icon = a.icon;
            return (
              <Link key={a.key} to={a.path} className="area-card">
                <div className="area-card__icon"><Icon size={22} /></div>
                <div className="area-card__label">{a.label}</div>
                <div className="area-card__desc">{a.desc}</div>
              </Link>
            );
          })}
        </div>

        {(getActiveTeamIds(profile).length > 0 || profile?.player_num) && (
          <DashCard icon={TrendingUp} title="Your Standing">
            {snapshotStats === undefined && <Loader />}
            {snapshotStats === null && (
              <div className="dash-empty">Link your player number in My Profile to see your rank here.</div>
            )}
            {snapshotStats && snapshotStats.length === 0 && (
              <div className="dash-empty">No standings yet for your team's division.</div>
            )}
            {snapshotStats && snapshotStats.map(s => (
              <div key={s.teamId} className="match-row">
                <div className="match-row__opponent">{s.teamName}</div>
                <div className="match-row__meta">
                  {s.teamRank ? `Team: ${s.teamRank.rank} of ${s.teamRank.totalTeams}` : "Team: not yet ranked"}
                  {s.mvpRank ? ` · You: #${s.mvpRank.rank} of ${s.mvpRank.totalPlayers}` : ""}
                </div>
              </div>
            ))}
          </DashCard>
        )}

        {(getActiveTeamIds(profile).length > 0 || profile?.player_num) && (
          <DashCard icon={Calendar} title="Recent Activity">
            {(recentMatch === undefined || recentPractice === undefined) && <Loader />}
            {recentMatch === null && recentPractice === null && (
              <div className="dash-empty">No recent league or practice activity yet.</div>
            )}
            {recentMatch && (
              <div className="match-row">
                <div className="match-row__opponent">
                  {showTeamLabels ? `${recentMatch._teamName} — ` : ""}vs {matchOpponentName(recentMatch)}
                </div>
                <div className="match-row__meta"><Calendar size={10} /> {recentMatch.week_date || ""} · {matchResultLabel(recentMatch)}</div>
              </div>
            )}
            {recentPractice && (
              <div className="match-row">
                <div className="match-row__opponent">Practice vs {recentPractice.opponent_name}</div>
                <div className="match-row__meta">
                  <Calendar size={10} /> {new Date(recentPractice.played_at).toLocaleDateString()} · {recentPractice.winner === "me" ? "Won" : recentPractice.winner === "opponent" ? "Lost" : "—"}
                </div>
              </div>
            )}
          </DashCard>
        )}
        </>}
      </div>
      <TabBar />
    </div>
  );
}

// ─── Leagues dashboard ──────────────────────────────────────────────────────
export function TeamsPlayersDashboard() {
  const navigate = useNavigate();
  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style><style>{dashboardCss}</style>
      <PageHeader title="Teams and Players" subtitle="Look up league players and teams." />
      <div className="tab-content">
        <div style={{display:"flex",flexDirection:"column",gap:12,maxWidth:620,margin:"0 auto"}}>
          <button className="btn-secondary" onClick={() => navigate("/player-lookup")}
            style={{display:"flex",alignItems:"center",gap:12,textAlign:"left",padding:16,minHeight:76,width:"100%"}}>
            <Users size={22} color="#5FCF9E" />
            <span style={{display:"flex",flexDirection:"column",gap:4,flex:1}}>
              <strong style={{fontSize:14}}>Player Lookup</strong>
              <span style={{fontSize:12,color:"#9A9A9A",fontWeight:400}}>Find players, ratings, and player history.</span>
            </span>
            <ChevronRight size={18} />
          </button>
          <button className="btn-secondary" onClick={() => navigate("/team-lookup")}
            style={{display:"flex",alignItems:"center",gap:12,textAlign:"left",padding:16,minHeight:76,width:"100%"}}>
            <Building2 size={22} color="#5FCF9E" />
            <span style={{display:"flex",flexDirection:"column",gap:4,flex:1}}>
              <strong style={{fontSize:14}}>Team Lookup</strong>
              <span style={{fontSize:12,color:"#9A9A9A",fontWeight:400}}>Find teams and explore team details.</span>
            </span>
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <TabBar />
    </div>
  );
}

export function LeaguesDashboard() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const isManager = profile?.role === "manager";
  const isCaptain = profile?.role === "captain";
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const selectedTeamIds = getActiveTeamIds(profile)[0] ?? nulls ?? [];
  const effectiveTeamId = selectedTeamId && selectedTeamIds.includes(selectedTeamId)
    ? selectedTeamId
    : selectedTeamIds[0] ?? null;
  const [overview, setOverview] = useState(undefined); // undefined = loading, null = no team
  const [lineupPlans, setLineupPlans] = useState(undefined); // undefined until initial team context has loaded
  const [unavailability, setUnavailability] = useState(undefined); // undefined until initial team context has loaded
  const [markingWeekId, setMarkingWeekId] = useState(null);
  const [reasonInput, setReasonInput] = useState("");
  const [view, setView] = useState("main"); // "main" | "upcoming" | "previous"

  const refreshUnavailability = () => { if (effectiveTeamId) db.listTeamUnavailability(effectiveTeamId).then(setUnavailability); };

  useEffect(() => {
    let cancelled = false;
    if (!effectiveTeamId) {
      setOverview(null);
      setLineupPlans([]);
      setUnavailability([]);
      return () => { cancelled = true; };
    }

    setOverview(undefined);
    setLineupPlans(undefined);
    setUnavailability(undefined);
    Promise.all([
      db.getTeamScheduleOverview(effectiveTeamId),
      db.listTeamLineupPlans(effectiveTeamId),
      db.listTeamUnavailability(effectiveTeamId),
    ]).then(([nextOverview, plans, unavailable]) => {
      if (cancelled) return;
      setOverview(nextOverview ?? null);
      setLineupPlans(plans ?? []);
      setUnavailability(unavailable ?? []);
    }).catch(() => {
      if (cancelled) return;
      setOverview(null);
      setLineupPlans([]);
      setUnavailability([]);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTeamId]);

  const leaguesLoading = overview === undefined || lineupPlans === undefined || unavailability === undefined;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcomingAll = overview ? overview.myWeeks
    .map(w => ({ ...w, _date: parseWeekDate(w.date) }))
    .filter(w => w._date && w._date >= today)
    .sort((a, b) => a._date - b._date) : [];
  const previousAll = overview?.myCompleted ?? [];
  const myMakeups = previousAll.filter(m => m.is_makeup_pending);
  const upcomingWeekIds = new Set(upcomingAll.map(w => w.id));
  const upcomingPlans = lineupPlans.filter(p => upcomingWeekIds.has(p.scheduleWeekId) && (p.players.length > 0 || p.note));
  const myUnavailableByWeek = new Map(
    unavailability.filter(u => u.playerNum === profile?.player_num).map(u => [u.scheduleWeekId, u])
  );
  const markUnavailable = async (weekId) => {
    await db.setUnavailability(effectiveTeamId, weekId, profile.player_num, reasonInput, profile.id);
    setReasonInput(""); setMarkingWeekId(null);
    refreshUnavailability();
  };
  const markAvailableAgain = async (weekId) => {
    await db.clearUnavailability(effectiveTeamId, weekId, profile.player_num);
    refreshUnavailability();
  };

  if (view === "upcoming" || view === "previous") {
    const isUpcoming = view === "upcoming";
    return (
      <div className="app">
        <style>{css}</style><style>{shellCss}</style><style>{dashboardCss}</style>
        <PageHeader title={isUpcoming ? "Upcoming Matches" : "Previous Matches"} />
        <div className="tab-content">
          {(isUpcoming ? upcomingAll : previousAll).length === 0
            ? <div className="empty-state">No {isUpcoming ? "upcoming" : "previous"} matches.</div>
            : (isUpcoming ? upcomingAll : previousAll).map((item, i) => (
                <MatchRow key={i} isUpcoming={isUpcoming} item={item} overview={overview} />
              ))
          }
          <button className="btn-secondary" onClick={() => setView("main")} style={{marginTop:4}}>← Back to Leagues</button>
        </div>
        <TabBar />
      </div>
    );
  }

  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style><style>{dashboardCss}</style>
      <PageHeader title="Leagues" hideBack />
      <div className="tab-content">
        {leaguesLoading ? <Loader /> : <>
        {/* League News -- fee/membership tracking not built yet */}
        <DashCard icon={Newspaper} title="League News">
          <div className="empty-state" style={{padding:14}}>Coming soon — league fees and IBA membership status will show here.</div>
        </DashCard>

        {overview === undefined && <Loader />}

        {overview && (
          <>
            <DashCard icon={Calendar} title="Next Match">
              {upcomingAll.length === 0
                ? <div className="dash-empty">No upcoming match scheduled.</div>
                : <MatchRow item={upcomingAll[0]} overview={overview} isUpcoming clickable={false} />}
            </DashCard>

            {upcomingPlans.length > 0 && (
              <DashCard icon={Users} title="Who's Shooting">
                {upcomingPlans.map(p => (
                  <div key={p.id} className="match-row">
                    <div className="match-row__opponent">{p.weekNum ? `Week ${p.weekNum} · ` : ""}{p.weekDate}</div>
                    <div className="match-row__meta">
                      {p.players.length > 0 ? p.players.map(pl => pl.name).join(", ") : "No players noted yet"}
                      {p.note && <div style={{marginTop:2,fontStyle:"italic",color:"#8A8A8A"}}>"{p.note}"</div>}
                    </div>
                  </div>
                ))}
              </DashCard>
            )}

            {effectiveTeamId && upcomingAll.length > 0 && (
              <DashCard icon={AlertCircle} title="My Availability">
                {!profile.player_num ? (
                  <div className="dash-empty">Link your player number in My Profile to set your availability for upcoming weeks.</div>
                ) : (
                  <>
                    <div style={{fontSize:10.5,color:"#6A6A6A",marginBottom:6}}>Let your captain know if you can't shoot an upcoming week — optional, just a heads-up.</div>
                    {upcomingAll.map(w => {
                      const marked = myUnavailableByWeek.get(w.id);
                      return (
                        <div key={w.id} style={{padding:"8px 0",borderTop:"1px solid #2A2A2A"}}>
                          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                            <span style={{fontSize:12,fontWeight:700,color:"#E0E0E0"}}>{w.week ? `Week ${w.week} · ` : ""}{w.date}</span>
                            {marked ? (
                              <button className="btn-sm" onClick={() => markAvailableAgain(w.id)}>Available After All</button>
                            ) : (
                              <button className="btn-sm btn-sm--warn" onClick={() => { setMarkingWeekId(markingWeekId === w.id ? null : w.id); setReasonInput(""); }}>
                                Can't Shoot
                              </button>
                            )}
                          </div>
                          {marked?.reason && <div style={{fontSize:10.5,color:"#8A8A8A",fontStyle:"italic",marginTop:2}}>"{marked.reason}"</div>}
                          {markingWeekId === w.id && !marked && (
                            <div style={{display:"flex",gap:6,marginTop:6}}>
                              <input className="input" style={{flex:1}} value={reasonInput} onChange={e => setReasonInput(e.target.value)} placeholder="Reason (optional)" />
                              <button className="btn-icon btn-icon--confirm" onClick={() => markUnavailable(w.id)}><Check size={13}/></button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </DashCard>
            )}

            <DashCard icon={Calendar} title="Upcoming Matches" onMore={upcomingAll.length > 3 ? () => setView("upcoming") : null}>
              {upcomingAll.length === 0
                ? <div className="dash-empty">Nothing scheduled yet.</div>
                : upcomingAll.slice(0, 3).map((w, i) => <MatchRow key={i} item={w} overview={overview} isUpcoming clickable={false} />)}
            </DashCard>

            <DashCard icon={Trophy} title="Previous Matches" onMore={previousAll.length > 3 ? () => setView("previous") : null}>
              {previousAll.length === 0
                ? <div className="dash-empty">No matches played yet.</div>
                : previousAll.slice(0, 3).map((m, i) => <MatchRow key={i} item={m} overview={overview} clickable={false} />)}
            </DashCard>

            {(isCaptain || isManager) && (
              <DashCard icon={AlertCircle} title="Makeups">
                {isManager ? (
                  <div className="dash-empty">Manager view — see all leaguewide makeups in Match Lookup / History.
                    <button className="link-btn" onClick={()=>navigate("/match-lookup")}>Open →</button>
                  </div>
                ) : myMakeups.length === 0 ? (
                  <div className="dash-empty">No makeups pending for your team.</div>
                ) : myMakeups.map((m, i) => <MatchRow key={i} item={m} overview={overview} clickable={false} />)}
              </DashCard>
            )}
          </>
        )}

        {!overview && overview !== undefined && selectedTeamIds.length === 0 && (
          <div className="empty-state">No team linked to your account yet — match cards will show once you're linked to a team.</div>
        )}

        <DashCard icon={Calendar} title="League Schedule">
          <button className="btn-secondary" onClick={() => navigate("/schedules")}>View Full Schedule →</button>
        </DashCard>

        <DashCard icon={BarChart3} title="League Standings & History">
          <button className="btn-secondary" onClick={()=>navigate("/team-standings")}>View Team Standings →</button>
          <button className="btn-secondary" onClick={()=>navigate("/mvp-standings")}>View MVP Standings →</button>
          <button className="btn-secondary" onClick={()=>navigate("/match-lookup")}>Look Up Previous Matches →</button>
        </DashCard>

        {(isManager || isCaptain) && (
          <Link to="/league-office" className="office-card">
            <Wrench size={18} />
            <div>
              <div className="office-card__title">League Office</div>
              <div className="office-card__desc">{isManager ? "Full league administration" : "Manage your team"}</div>
            </div>
            <ChevronRight size={16} />
          </Link>
        )}
        {!isManager && !isCaptain && (
          <Link to="/league-office" className="office-card">
            <Wrench size={18} />
            <div>
              <div className="office-card__title">League Office</div>
              <div className="office-card__desc">Team & player lookup tools</div>
            </div>
            <ChevronRight size={16} />
          </Link>
        )}
        </>}
      </div>
      <TabBar />
    </div>
  );
}

function DashCard({ icon: Icon, title, onMore, children }) {
  return (
    <div className="dash-card">
      <div className="dash-card__header">
        <div className="dash-card__title"><Icon size={14} /> {title}</div>
        {onMore && <button className="dash-card__more" onClick={onMore}>More <ChevronRight size={12} /></button>}
      </div>
      {children}
    </div>
  );
}

// A single schedule pairing (upcoming) or completed_matches row (previous) --
// same visual row either way. Clicking through to head-to-head history
// against the opponent is deferred (noted in the handoff), so rows are
// informational only for now.
function MatchRow({ item, overview, isUpcoming, clickable }) {
  if (isUpcoming) {
    const p = item.pairings[0];
    const opp = opponentName(p, overview.team.id, overview.teams);
    return (
      <div className="match-row">
        <div className="match-row__opponent">vs {opp}</div>
        <div className="match-row__meta"><Calendar size={10} /> {item.date}{overview.team.venue && <><MapPin size={10} style={{marginLeft:6}}/> {overview.team.venue}</>}</div>
      </div>
    );
  }
  const isHome = item.team_home_id === overview.team.id;
  const oppName = isHome ? item.team_away_name : item.team_home_name;
  const myPts = isHome ? item.team_home_points : item.team_away_points;
  const oppPts = isHome ? item.team_away_points : item.team_home_points;
  const result = item.is_makeup_pending ? "Makeup Pending" : myPts != null && oppPts != null ? `${myPts} – ${oppPts}` : "—";
  return (
    <div className="match-row">
      <div className="match-row__opponent">vs {oppName ?? "—"}</div>
      <div className="match-row__meta"><Calendar size={10} /> {item.week_date || ""} · {result}</div>
    </div>
  );
}

// ─── League Office ──────────────────────────────────────────────────────────
export function LeagueOffice() {
  const { profile } = useAuth();
  if (!profile) return null;
  const items = navItemsForRole(profile.role);
  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style><style>{dashboardCss}</style>
      <PageHeader title="League Office" />
      <div className="tab-content">
        {items.map(item => {
          const Icon = item.icon;
          return (
            <Link key={item.key} to={item.path} className="office-list-item">
              <Icon size={16} />
              <span>{item.label}</span>
              <ChevronRight size={14} style={{marginLeft:"auto"}} color="#6A6A6A" />
            </Link>
          );
        })}
      </div>
      <TabBar />
    </div>
  );
}

// ─── Season setup and maintenance hub ────────────────────────────────────────
export function SeasonManagementHub() {
  const { profile } = useAuth();
  if (!profile) return null;

  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style><style>{dashboardCss}</style>
      <PageHeader title="Season Setup & Management" />
      <div className="tab-content">
        {profile.role !== "manager" ? <AccessDenied /> : (
          <>
            <p className="season-hub-intro">
              Use these focused pages to set up the season, update weekly reports, and manage playoff eligibility, playoffs, and locations.
            </p>
            <div className="season-hub-section">
              <div className="season-hub-section__title">1. Set up the season, teams & schedule</div>
              <Link to="/seasons" className="season-hub-card">
                <div className="season-hub-card__icon"><Calendar size={19} /></div>
                <div className="season-hub-card__body">
                  <div className="season-hub-card__title">Create the season & import from IBA</div>
                  <div className="season-hub-card__desc">Create or activate the season, then expand its season card to automatically discover and import published divisions, teams, and schedules.</div>
                </div>
                <ChevronRight size={17} className="season-hub-card__arrow" />
              </Link>
              <Link to="/manage-divisions" className="season-hub-card">
                <div className="season-hub-card__icon"><Settings2 size={19} /></div>
                <div className="season-hub-card__body">
                  <div className="season-hub-card__title">Manage Divisions</div>
                  <div className="season-hub-card__desc">Add, edit, or remove divisions for a selected season. Division setup is separate from importing teams and schedules.</div>
                </div>
                <ChevronRight size={17} className="season-hub-card__arrow" />
              </Link>
            </div>
            <div className="season-hub-section">
              <div className="season-hub-section__title">2. Update weekly league data</div>
              <Link to="/weekly-data" className="season-hub-card">
                <div className="season-hub-card__icon"><Upload size={19} /></div>
                <div className="season-hub-card__body">
                  <div className="season-hub-card__title">Roster & ratings, team standings, and MVP standings</div>
                  <div className="season-hub-card__desc">Choose automatic IBA sync or manual import independently for each weekly data category.</div>
                </div>
                <ChevronRight size={17} className="season-hub-card__arrow" />
              </Link>
            </div>
            <div className="season-hub-section">
              <div className="season-hub-section__title">3. Maintain playoff setup & locations</div>
              <Link to="/playoff-eligibility" className="season-hub-card">
                <div className="season-hub-card__icon"><AlertCircle size={19} /></div>
                <div className="season-hub-card__body">
                  <div className="season-hub-card__title">Playoff eligibility</div>
                  <div className="season-hub-card__desc">Manually import and review the IBA playoff-eligibility report when it becomes available.</div>
                </div>
                <ChevronRight size={17} className="season-hub-card__arrow" />
              </Link>
              <Link to="/playoffs" className="season-hub-card">
                <div className="season-hub-card__icon"><Trophy size={19} /></div>
                <div className="season-hub-card__body">
                  <div className="season-hub-card__title">Playoffs</div>
                  <div className="season-hub-card__desc">Maintain playoff-related setup for the selected season and division.</div>
                </div>
                <ChevronRight size={17} className="season-hub-card__arrow" />
              </Link>
              <Link to="/locations" className="season-hub-card">
                <div className="season-hub-card__icon"><MapPin size={19} /></div>
                <div className="season-hub-card__body">
                  <div className="season-hub-card__title">Locations</div>
                  <div className="season-hub-card__desc">Maintain the locations used for league teams and venues.</div>
                </div>
                <ChevronRight size={17} className="season-hub-card__arrow" />
              </Link>
            </div>
          </>
        )}
      </div>
      <TabBar />
    </div>
  );
}

// ─── Tournaments placeholder ────────────────────────────────────────────────
export function TournamentsPlaceholder() {
  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style><style>{dashboardCss}</style>
      <PageHeader title="Tournaments" hideBack />
      <div className="tab-content">
        <div className="empty-state">Tournament brackets — Scotch Doubles, Singles, and Team — are coming soon.</div>
      </div>
      <TabBar />
    </div>
  );
}

export const dashboardCss = `
.next-match-card{display:block;background:#0F2D1F;border:1.5px solid #1F6B4A;border-radius:14px;padding:16px;text-decoration:none;margin-bottom:4px;}
.next-match-card__eyebrow{font-size:10px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#5FCF9E;margin-bottom:4px;}
.next-match-card__opponent{font-family:'Archivo Black',sans-serif;font-size:18px;color:#FFF;margin-bottom:4px;}
.next-match-card__meta{font-size:11px;color:#9FC4B4;display:flex;align-items:center;}

.area-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.area-card{display:flex;flex-direction:column;gap:6px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;padding:16px;text-decoration:none;color:#FFF;}
.area-card__icon{width:38px;height:38px;border-radius:10px;background:#0F2D1F;color:#5FCF9E;display:flex;align-items:center;justify-content:center;}
.area-card__label{font-family:'Archivo Black',sans-serif;font-size:14px;}
.area-card__desc{font-size:10.5px;color:#9A9A9A;line-height:1.3;}

.dash-card{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.dash-card__header{display:flex;align-items:center;justify-content:space-between;}
.dash-card__title{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:800;letter-spacing:0.03em;text-transform:uppercase;color:#9FC4B4;}
.dash-card__more{background:none;border:none;color:#5FCF9E;font-size:11px;font-weight:700;display:flex;align-items:center;gap:2px;cursor:pointer;padding:0;}
.dash-empty{font-size:12px;color:#6A6A6A;}

.match-row{padding:8px 0;border-top:1px solid #2A2A2A;}
.match-row:first-child{border-top:none;padding-top:0;}
.match-row__opponent{font-size:13px;font-weight:700;color:#E0E0E0;}
.match-row__meta{font-size:10.5px;color:#8A8A8A;display:flex;align-items:center;margin-top:2px;}

.office-card{display:flex;align-items:center;gap:12px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;padding:14px;text-decoration:none;color:#FFF;}
.office-card__title{font-size:13.5px;font-weight:700;}
.office-card__desc{font-size:10.5px;color:#9A9A9A;}
.office-list-item{display:flex;align-items:center;gap:10px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:12px;padding:13px 14px;text-decoration:none;color:#E0E0E0;font-size:12.5px;font-weight:600;}

.season-hub-intro{font-size:12.5px;line-height:1.55;color:#B0B0B0;margin:0 0 18px;}
.season-hub-section{display:flex;flex-direction:column;gap:9px;margin-bottom:20px;}
.season-hub-section__title{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#9FC4B4;}
.season-hub-card{display:flex;align-items:center;gap:12px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;padding:14px;text-decoration:none;color:#FFF;min-width:0;}
.season-hub-card:hover{border-color:#3E6B58;}
.season-hub-card__icon{width:40px;height:40px;flex:0 0 40px;display:flex;align-items:center;justify-content:center;border-radius:10px;background:#0F2D1F;color:#5FCF9E;}
.season-hub-card__body{flex:1;min-width:0;}
.season-hub-card__title{font-size:13px;font-weight:800;color:#F4F4F4;margin-bottom:5px;}
.season-hub-card__desc{font-size:11px;line-height:1.45;color:#9A9A9A;}
.season-hub-card__arrow{flex:0 0 auto;color:#6A6A6A;}

.team-selector-wrap{padding:0 0 8px;display:flex;flex-direction:column;gap:4px;}
.team-selector-label{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#8A8A8A;}
.team-selector{width:100%;background:#1C1C1C;color:#E0E0E0;border:1.5px solid #2E2E2E;border-radius:10px;padding:10px 12px;font-size:12px;font-weight:700;}
.link-btn{background:none;border:none;color:#5FCF9E;font-size:11px;font-weight:700;text-decoration:underline;cursor:pointer;padding:0;margin-left:6px;}
`;
