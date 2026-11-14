import { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { Plus, Minus, Search, Check, ChevronRight, Trophy } from "lucide-react";
import { useAuth } from "./AuthContext";
import { PageHeader, TabBar, shellCss } from "./Shell";
import { css, Loader } from "./AdminApp";
import { dashboardCss } from "./Dashboard";
import * as db from "./db";
import { useActiveSession } from "./ActiveSessionContext";
import ShotTracker, { shotTrackerCss } from "./ShotTracker";

const PRACTICE_TYPES = [
  { key: "skills_drills", label: "Practice Skills & Drills", desc: "Work on your own game with Track a Rack and focused practice drills — no opponent or match result." },
  { key: "opponent", label: "Practice vs. Opponent", desc: "Play a practice set against another player and track the result using an IBA-style scoring method." },
];
const GAME_TYPES = [
  { key: "8ball", label: "8-Ball", desc: "Practice the game used in IBA league play." },
  { key: "9ball", label: "9-Ball", desc: "Practice 9-ball with its own rack and scoring style." },
  { key: "10ball", label: "10-Ball", desc: "Practice 10-ball with its own rack and scoring style." },
  { key: "ultimate", label: "Ultimate Pool", desc: "Practice Ultimate Pool without affecting league scoring." },
];
const SCORING_METHODS = [
  { key: "race_to_points", label: "Race to Points", desc: "Track points earned in each game toward the player's rating target." },
  { key: "race_to_games", label: "Race to Games", desc: "Track games won toward a selected number of game wins." },
  { key: "best_of_games", label: "Best of X Games", desc: "Choose an odd number of games; first to win more than half wins the session." },
];

function scoringMethodLabel(key) { return SCORING_METHODS.find(f => f.key === key)?.label ?? key; }

function gameTypeLabel(key) { return GAME_TYPES.find(g => g.key === key)?.label ?? key; }

function practiceGameRow(profile, session) {
  return {
    created_by: profile.id,
    practice_type: session.practiceType ?? "opponent",
    scoring_method: session.practiceType === "opponent" ? (session.scoringMethod ?? null) : null,
    completed_at: session.completedAt ?? null,
    opponent_player_num: session.opponentType === "player" ? session.opponentPlayerNum : null,
    opponent_id: session.opponentType === "manual" ? session.opponentId : null,
    opponent_name: session.practiceType === "skills_drills" ? null : session.opponentName,
    game_type: session.gameType ?? null,
    format: session.practiceType === "opponent" ? session.format : null,
    target_config: {
      ...(session.scoringMethod === "race_to_points"
        ? { myTarget: session.myRating, oppTarget: session.opponentRating }
        : { x: session.x }),
      tableSizeFeet: session.tableSizeFeet ?? null,
    },
    my_rating: session.scoringMethod === "race_to_points" ? session.myRating : null,
    opponent_rating: session.scoringMethod === "race_to_points" ? session.opponentRating : null,
    my_score: session.myScore ?? 0,
    opponent_score: session.opponentScore ?? 0,
    winner: session.winner ?? null,
    game_log: session.gameLog ?? [],
  };
}

export default function Practice() {
  const { profile } = useAuth();
  const location = useLocation();
  const { activeSession, setActiveSession, clearActiveSession } = useActiveSession();
  const restoredPractice = activeSession?.type === "practice" && activeSession.data?.phase !== "done" ? activeSession.data : null;
  useEffect(() => {
    if (activeSession?.type === "practice" && activeSession.data?.phase === "done") clearActiveSession();
  }, [activeSession?.type, activeSession?.data?.phase, clearActiveSession]);
  const [phase, setPhase] = useState(restoredPractice?.phase ?? "landing"); // landing | type | opponent | gametype | scoring | config | play | skillsplay | done
  const [session, setSessionState] = useState(restoredPractice?.session ?? null);
  const setSession = (next) => setSessionState((current) =>
    typeof next === "function" ? next(current) : next
  );
  const changePhase = (nextPhase) => setPhase(nextPhase);

  useEffect(() => {
    if (session && activeSession?.type === "practice" && phase !== "landing" && phase !== "done") {
      const gameType = session.gameType ? gameTypeLabel(session.gameType) : "Practice setup";
      const score = session.gameType ? `${session.myScore ?? 0}–${session.opponentScore ?? 0}` : "";
      setActiveSession((current) => current?.type === "practice"
        ? { ...current, title: session.opponentName ? `vs ${session.opponentName}` : "Practice session", subtitle: [gameType, score].filter(Boolean).join(" · "), data: { phase, session } }
        : current);
    }
  }, [phase, session]);
  const [history, setHistory] = useState(undefined);
  const [opponents, setOpponents] = useState(undefined);

  const refreshHistory = () => {
    if (!profile) { setHistory([]); return; }
    setHistory(undefined);
    db.listMyPracticeGames(profile.id).then(setHistory).catch(() => setHistory([]));
  };
  const refreshOpponents = () => {
    if (!profile) { setOpponents([]); return; }
    setOpponents(undefined);
    db.listMyPracticeOpponents(profile.id).then(setOpponents).catch(() => setOpponents([]));
  };
  useEffect(() => { refreshHistory(); refreshOpponents(); }, [profile?.id]);

  const startSession = () => {
    const initial = {
      practiceType: null, scoringMethod: null,
      opponentType: null, opponentPlayerNum: null, opponentId: null, opponentName: "", opponentRating: null,
      gameType: null, format: null, x: 5, myRating: null, myScore: 0, opponentScore: 0, gameLog: [], myPts: "", oppPts: "",
    };
    setSessionState(initial);
    setPhase("type");
    setActiveSession({ type: "practice", ownerId: profile?.id, route: "/practice", title: "Choose a practice type", subtitle: "Practice setup", data: { phase: "type", session: initial } });
  };
  useEffect(() => {
    if (new URLSearchParams(location.search).get("start") === "1" && phase === "landing") startSession();
  }, [location.search]);
  const cancelSession = () => { clearActiveSession(); setSessionState(null); setPhase("landing"); };

  const wrap = (children) => (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style><style>{dashboardCss}</style><style>{practiceCss}</style><style>{shotTrackerCss}</style>
      {children}
      <TabBar />
    </div>
  );

  if (phase === "landing" && profile && (history === undefined || opponents === undefined)) {
    return wrap(<><PageHeader title="Practice" /><div className="tab-content"><Loader /></div></>);
  }

  if (phase === "type") {
    return wrap(<PracticeTypeStep session={session} setSession={setSession}
      onNext={(type) => changePhase(type === "skills_drills" ? "gametype" : "opponent")} onCancel={cancelSession} />);
  }
  if (phase === "opponent") {
    return wrap(<OpponentStep profile={profile} session={session} setSession={setSession}
      onNext={() => changePhase("gametype")} onCancel={cancelSession} />);
  }
  if (phase === "gametype") {
    return wrap(<GameTypeStep session={session} setSession={setSession}
      onNext={() => changePhase("tablesize")}
      onBack={() => changePhase(session.practiceType === "skills_drills" ? "type" : "opponent")} />);
  }
  if (phase === "tablesize") {
    return wrap(<TableSizeStep session={session} setSession={setSession}
      onNext={() => changePhase(session.practiceType === "skills_drills" ? "skillsplay" : "scoring")}
      onBack={() => changePhase("gametype")} />);
  }
  if (phase === "scoring") {
    return wrap(<ScoringMethodStep session={session} setSession={setSession}
      onNext={() => changePhase("config")} onBack={() => changePhase("gametype")} />);
  }
  if (phase === "config") {
    return wrap(<ConfigStep profile={profile} session={session} setSession={setSession}
      onNext={() => changePhase("play")} onBack={() => changePhase("scoring")} />);
  }
  if (phase === "play") {
    return wrap(<PlayStep profile={profile} session={session} setSession={setSession}
      onDone={(finalSession) => { setSessionState(finalSession); setPhase("done"); setActiveSession({ type: "practice", route: "/practice", title: "Saving practice result", subtitle: finalSession.opponentName, data: { phase: "done", session: finalSession } }); }} onBack={() => changePhase("config")} />);
  }
  if (phase === "done") {
    return wrap(<DoneStep profile={profile} session={session}
      onSaved={() => { refreshHistory(); clearActiveSession(); setPhase("landing"); setSessionState(null); }} />);
  }

  return wrap(<LandingStep profile={profile} history={history} rawOpponents={opponents} onStart={startSession} onLinked={refreshOpponents} />);
}

// ─── Landing ────────────────────────────────────────────────────────────────
function LandingStep({ profile, history, rawOpponents, onStart, onLinked }) {
  const sessionsRef = useRef(null);
  const [filterOpponent, setFilterOpponent] = useState(null);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [linkingKey, setLinkingKey] = useState(null);

  const opponentKey = (g) => g.opponent_player_num ? `p:${g.opponent_player_num}` : `o:${g.opponent_id}`;
  const byOpponent = {};
  (history ?? []).filter(g => g.practice_type !== "skills_drills").forEach(g => {
    const key = opponentKey(g);
    if (!byOpponent[key]) byOpponent[key] = { key, name: g.opponent_name, wins: 0, losses: 0, opponentId: g.opponent_id ?? null };
    if (g.winner === "me") byOpponent[key].wins++; else if (g.winner === "opponent") byOpponent[key].losses++;
  });
  const opponents = Object.values(byOpponent).sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses));
  const visibleGames = filterOpponent ? (history ?? []).filter(g => opponentKey(g) === filterOpponent) : showAllSessions ? (history ?? []) : (history ?? []).slice(0, 10);
  const rawById = Object.fromEntries((rawOpponents ?? []).map(o => [o.id, o]));

  return (
    <>
      <PageHeader title="Practice" />
      <div className="tab-content">
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:18}}>
          <button type="button" onClick={onStart} className="office-list-item">
            <Plus size={16} /><span>New Practice Session</span>
            <ChevronRight size={14} style={{marginLeft:"auto"}} color="#6A6A6A" />
          </button>
          <button type="button" onClick={() => { setShowAllSessions(true); sessionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className="office-list-item" aria-controls="practice-sessions">
            <Trophy size={16} /><span>My Practice Sessions</span>
            <ChevronRight size={14} style={{marginLeft:"auto"}} color="#6A6A6A" />
          </button>
        </div>

        {opponents.length > 0 && (
          <div className="card">
            <div className="card__title">Your Opponents</div>
            <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:6}}>
              {opponents.map(o => {
                const isManual = o.key.startsWith("o:");
                const linked = isManual ? rawById[o.opponentId]?.linked_profile_id : null;
                return (
                  <div key={o.key}>
                    <div className="list-row" style={{cursor:"pointer"}}
                      onClick={() => setFilterOpponent(filterOpponent === o.key ? null : o.key)}>
                      <div className="list-row__body">
                        <div style={{flex:1}}>
                          <div className="list-row__name">{o.name}</div>
                          <div className="list-row__sub">
                            {o.wins}W – {o.losses}L
                            {isManual && linked && <span style={{color:"#5FCF9E"}}> · Linked</span>}
                          </div>
                        </div>
                        {isManual && !linked && (
                          <button className="btn-icon" onClick={(e)=>{e.stopPropagation(); setLinkingKey(linkingKey===o.key?null:o.key);}}>Link</button>
                        )}
                        <ChevronRight size={14} color="#6A6A6A" />
                      </div>
                    </div>
                    {linkingKey === o.key && (
                      <LinkOpponentPanel opponentId={o.opponentId} onDone={() => { setLinkingKey(null); onLinked(); }} onCancel={() => setLinkingKey(null)} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="card" id="practice-sessions" ref={sessionsRef} style={{ scrollMarginTop: 16 }}>
          <div className="card__title">{filterOpponent ? "Games vs This Opponent" : "My Practice Sessions"}</div>
          {history === undefined && <Loader />}
          {history && visibleGames.length === 0 && <div className="dash-empty">No practice games yet.</div>}
          {history && visibleGames.map(g => (
            <div key={g.id} className="match-row">
              <div className="match-row__opponent">
                {g.practice_type === "skills_drills" ? "Skills & Drills" : `vs ${g.opponent_name}`}
                {g.practice_type !== "skills_drills" && <span style={{color: g.winner === "me" ? "#5FCF9E" : "#F87171", fontWeight:700, marginLeft:6}}>
                  {g.winner === "me" ? "Won" : g.winner === "opponent" ? "Lost" : "—"}
                </span>}
              </div>
              <div className="match-row__meta">
                {gameTypeLabel(g.game_type)}
                {g.scoring_method ? ` · ${scoringMethodLabel(g.scoring_method)}` : ""}
                {g.practice_type !== "skills_drills" ? ` · ${g.my_score}–${g.opponent_score}` : ""}
                {` · ${new Date(g.completed_at || g.played_at).toLocaleDateString()}`}
              </div>
            </div>
          ))}
          {filterOpponent && <button className="btn-secondary" style={{marginTop:8}} onClick={() => setFilterOpponent(null)}>Show All</button>}
        </div>
      </div>
    </>
  );
}

// ─── Step 1: practice type ─────────────────────────────────────────────────
function PracticeTypeStep({ session, setSession, onNext, onCancel }) {
  return (
    <>
      <PageHeader title="Practice" onBack={onCancel} />
      <div className="tab-content">
        <div className="card">
          <div className="card__title">Practice Type</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:6}}>
            {PRACTICE_TYPES.map(type => (
              <button key={type.key} className="seg-btn" style={{padding:14,textAlign:"left"}}
                onClick={() => {
                  setSession(s => ({ ...s, practiceType: type.key, scoringMethod: type.key === "skills_drills" ? null : s.scoringMethod }));
                  onNext(type.key);
                }}>
                <div style={{fontWeight:700}}>{type.label}</div>
                <div style={{fontSize:10.5,color:"#9A9A9A",fontWeight:500,marginTop:3,lineHeight:1.35}}>{type.desc}</div>
              </button>
            ))}
          </div>
        </div>
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

// ─── Step 1: opponent ───────────────────────────────────────────────────────
// Inline search to link a manually-typed practice opponent to a real
// account, once that person actually signs up. Narrow search (id +
// username only, via a security-definer RPC) since a regular player can't
// read the full profiles table.
function LinkOpponentPanel({ opponentId, onDone, onCancel }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { if (query.trim().length >= 2) db.searchProfilesByUsername(query).then(setResults); else setResults([]); }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const link = async (p) => {
    setLinking(true);
    const ok = await db.linkPracticeOpponent(opponentId, p.id);
    setLinking(false);
    if (ok) onDone();
  };

  return (
    <div className="card" style={{marginTop:6,marginBottom:6}}>
      <div className="form-label" style={{marginBottom:6}}>Link to an account</div>
      <input className="input" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search by username…" autoFocus />
      {results.length > 0 && (
        <div className="list" style={{marginTop:8}}>
          {results.map(p => (
            <div key={p.id} className="list-row" style={{cursor:"pointer"}} onClick={() => link(p)}>
              <div className="list-row__body"><div className="list-row__name">@{p.username}</div></div>
            </div>
          ))}
        </div>
      )}
      <button className="btn-secondary" style={{marginTop:8}} onClick={onCancel} disabled={linking}>Cancel</button>
    </div>
  );
}

function OpponentStep({ profile, session, setSession, onNext, onCancel }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [manualFirstName, setManualFirstName] = useState("");
  const [manualLastName, setManualLastName] = useState("");
  const [myOpponents, setMyOpponents] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (profile) db.listMyPracticeOpponents(profile.id).then(setMyOpponents); }, [profile?.id]);
  useEffect(() => {
    const t = setTimeout(() => { if (query.trim().length >= 2) db.searchPlayers(query).then(setResults); else setResults([]); }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const pickPlayer = (p) => {
    setSession(s => ({ ...s, opponentType: "player", opponentPlayerNum: p.num, opponentId: null, opponentName: p.nickname || p.name, opponentRating: p.rating }));
    onNext();
  };
  const pickManualExisting = (o) => {
    setSession(s => ({ ...s, opponentType: "manual", opponentPlayerNum: null, opponentId: o.id, opponentName: o.name, opponentRating: null }));
    onNext();
  };
  const createManual = async () => {
    if (!manualFirstName.trim()) return;
    setSaving(true);
    const o = await db.findOrCreatePracticeOpponent(profile.id, manualFirstName, manualLastName);
    setSaving(false);
    if (!o) return;
    setSession(s => ({ ...s, opponentType: "manual", opponentPlayerNum: null, opponentId: o.id, opponentName: o.name, opponentRating: null }));
    onNext();
  };

  return (
    <>
      <PageHeader title="Practice" onBack={onCancel} />
      <div className="tab-content">
        <div className="field">
          <div className="form-label" style={{display:"flex",alignItems:"center",gap:5}}><Search size={11}/> Search league players</div>
          <input className="input" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Start typing a name…" />
        </div>
        {results.length > 0 && (
          <div className="list">
            {results.map(p => (
              <div key={p.num} className="list-row" style={{cursor:"pointer"}} onClick={() => pickPlayer(p)}>
                <div className="list-row__body">
                  <div style={{flex:1}}>
                    <div className="list-row__name">{p.nickname || db.shortPlayerName(p)}</div>
                    <div className="list-row__sub">{p.rating != null ? `Rating: ${p.rating}` : "No current rating"}</div>
                  </div>
                  <ChevronRight size={14} color="#6A6A6A" />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="field">
          <div className="form-label">Or enter a name</div>
          <div style={{display:"flex",gap:6}}>
            <input className="input" style={{flex:1}} value={manualFirstName} onChange={e=>setManualFirstName(e.target.value)} placeholder="First name" />
            <input className="input" style={{flex:1}} value={manualLastName} onChange={e=>setManualLastName(e.target.value)} placeholder="Last name" />
            <button className="btn-icon btn-icon--confirm" onClick={createManual} disabled={!manualFirstName.trim()||saving}><Check size={14}/></button>
          </div>
        </div>

        {myOpponents.length > 0 && (
          <div className="field">
            <div className="form-label">People you've played before</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {myOpponents.map(o => (
                <button key={o.id} className="chip" onClick={() => pickManualExisting(o)}>{o.name}</button>
              ))}
            </div>
          </div>
        )}

        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

// ─── Step 2: game type ──────────────────────────────────────────────────────
function GameTypeStep({ session, setSession, onNext, onBack }) {
  const isSkills = session.practiceType === "skills_drills";
  return (
    <>
      <PageHeader title="Practice" subtitle={isSkills ? "Skills & Drills" : `vs ${session.opponentName}`} onBack={onBack} />
      <div className="tab-content">
        <div className="card">
          <div className="card__title">Game Type</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:6}}>
            {GAME_TYPES.map(g => (
              <button key={g.key} className={`seg-btn ${session.gameType===g.key?"seg-btn--active":""}`} style={{padding:14,textAlign:"left"}}
                onClick={() => { setSession(s => ({ ...s, gameType: g.key })); onNext(); }}>
                <div style={{fontWeight:700}}>{g.label}</div>
                <div style={{fontSize:10.5,color:"#9A9A9A",fontWeight:500,marginTop:3,lineHeight:1.35}}>{g.desc}</div>
              </button>
            ))}
          </div>
        </div>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
      </div>
    </>
  );
}

// ─── Step 3: table size ───────────────────────────────────────────────────
function TableSizeStep({ session, setSession, onNext, onBack }) {
  const [value, setValue] = useState(session.tableSizeFeet ?? "");
  const [err, setErr] = useState("");

  const next = () => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      setErr("Enter the table size in feet (for example, 7, 8, or 9).");
      return;
    }
    setSession(s => ({ ...s, tableSizeFeet: n }));
    onNext();
  };

  return (
    <>
      <PageHeader title="Practice" subtitle={session.practiceType === "skills_drills" ? "Skills & Drills" : "vs " + session.opponentName} onBack={onBack} />
      <div className="tab-content">
        <div className="card">
          <div className="card__title">Table Size</div>
          <div style={{fontSize:11.5,color:"#9A9A9A",marginBottom:8}}>
            Enter the table size in feet used for this practice session.
          </div>
          <div className="field">
            <div className="form-label">Size (feet)</div>
            <input className="input" type="number" min="1" step="0.1" value={value}
              onChange={e => { setValue(e.target.value); setErr(""); }} placeholder="7, 8, or 9" />
          </div>
          {err && <div className="error-msg" style={{marginTop:8}}>{err}</div>}
          <button className="btn-primary" style={{marginTop:10}} onClick={next}>Continue</button>
        </div>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
      </div>
    </>
  );
}

// ─── Step 3: scoring method ────────────────────────────────────────────────
function ScoringMethodStep({ session, setSession, onNext, onBack }) {
  return (
    <>
      <PageHeader title="Practice" subtitle={`vs ${session.opponentName}`} onBack={onBack} />
      <div className="tab-content">
        <div className="card">
          <div className="card__title">Scoring Method</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:6}}>
            {SCORING_METHODS.map(method => (
              <button key={method.key} className={`seg-btn ${session.scoringMethod===method.key?"seg-btn--active":""}`} style={{padding:14,textAlign:"left"}}
                onClick={() => {
                  const format = method.key === "race_to_points" ? "match"
                    : method.key === "best_of_games" ? "bestof"
                    : "race";
                  setSession(s => ({ ...s, scoringMethod: method.key, format }));
                  onNext();
                }}>
                <div style={{fontWeight:700}}>{method.label}</div>
                <div style={{fontSize:10.5,color:"#9A9A9A",fontWeight:500,marginTop:3,lineHeight:1.35}}>{method.desc}</div>
              </button>
            ))}
          </div>
        </div>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
      </div>
    </>
  );
}

// ─── Step 4: config (target X, or ratings for Match) ───────────────────────
function ConfigStep({ profile, session, setSession, onNext, onBack }) {
  const [x, setX] = useState(session.x ?? 5);
  const [myRating, setMyRating] = useState(session.myRating ?? "");
  const [oppRating, setOppRating] = useState(session.opponentRating ?? "");
  const [loadingMyRating, setLoadingMyRating] = useState(session.format === "match");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (session.format !== "match") return;
    if (!profile?.player_num) { setLoadingMyRating(false); return; }
    db.getPlayerRating(profile.player_num).then(r => { setMyRating(r ?? ""); setLoadingMyRating(false); });
  }, [session.format, profile?.player_num]);

  const isRaceToPoints = session.scoringMethod === "race_to_points";
  const isRaceToGames = session.scoringMethod === "race_to_games";
  const isBestOfGames = session.scoringMethod === "best_of_games";

  const next = () => {
    setErr("");
    if (isRaceToGames || isBestOfGames) {
      const n = Number(x);
      if (!n || n < 1) { setErr("Enter a valid number of games."); return; }
      if (isBestOfGames && n % 2 === 0) { setErr("Best of needs an odd number (e.g. 3, 5, 7)."); return; }
      setSession(s => ({ ...s, x: n }));
    } else if (isRaceToPoints) {
      const my = Number(myRating), opp = Number(oppRating);
      if (!my || !opp) { setErr("Enter a rating for both players."); return; }
      setSession(s => ({ ...s, myRating: my, opponentRating: opp }));
    } else {
      setErr("Choose a scoring method.");
      return;
    }
    onNext();
  };

  return (
    <>
      <PageHeader title="Practice" subtitle={`${gameTypeLabel(session.gameType)} vs ${session.opponentName}`} onBack={onBack} />
      <div className="tab-content">
        <div className="card">
          {(isRaceToGames || isBestOfGames) ? (
            <>
              <div className="card__title">{isBestOfGames ? "Best of How Many Games?" : "Race to How Many Games?"}</div>
              <div style={{fontSize:11.5,color:"#9A9A9A",marginBottom:8}}>
                {isBestOfGames
                  ? "Pick an odd number — first to win more than half takes it."
                  : "Set the number of games needed to win the practice set."}
              </div>
              <input className="input" type="number" value={x} onChange={e=>setX(e.target.value)} />
            </>
          ) : (
            <>
              <div className="card__title">Ratings</div>
              <div style={{fontSize:11.5,color:"#9A9A9A",marginBottom:8}}>
                Each player races to their own rating — you can edit either number.
              </div>
              {loadingMyRating ? <Loader/> : (
                <>
                  <div className="field"><div className="form-label">Your Rating</div>
                    <input className="input" type="number" value={myRating} onChange={e=>setMyRating(e.target.value)} placeholder="Enter your rating"/>
                  </div>
                  <div className="field"><div className="form-label">{session.opponentName}'s Rating</div>
                    <input className="input" type="number" value={oppRating} onChange={e=>setOppRating(e.target.value)} placeholder="Enter their rating"/>
                  </div>
                </>
              )}
            </>
          )}
          {err && <div className="error-msg" style={{marginTop:8}}>{err}</div>}
          <button className="btn-primary" style={{marginTop:10}} onClick={next}>Start Playing</button>
        </div>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
      </div>
    </>
  );
}

// ─── Skills & Drills play ─────────────────────────────────────────────────
function SkillsDrillsStep({ profile, session, setSession, onDone, onBack }) {
  const [recordStatus, setRecordStatus] = useState("checking");
  const [recordError, setRecordError] = useState("");
  const [recordAttempt, setRecordAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const ensureRecord = async () => {
      if (!profile?.id) { setRecordError("Your account could not be identified. Sign in again before logging practice."); setRecordStatus("error"); return; }
      if (!session.gameId) { setSession(current => current?.gameId ? current : { ...current, gameId: crypto.randomUUID() }); return; }
      try {
        let existing = await db.getPracticeGame(session.gameId, profile.id);
        if (!existing) {
          existing = await db.createPracticeGame({ id: session.gameId, ...practiceGameRow(profile, session) });
          if (!existing) existing = await db.getPracticeGame(session.gameId, profile.id);
        }
        if (!existing) throw new Error("The practice session could not be created or recovered.");
        if (!cancelled) setRecordStatus("ready");
      } catch (error) {
        if (!cancelled) { setRecordError(error?.message || "Unable to prepare this practice session."); setRecordStatus("error"); }
      }
    };
    ensureRecord();
    return () => { cancelled = true; };
  }, [session.gameId, profile?.id, recordAttempt]);

  const finish = () => onDone({ ...session, completedAt: new Date().toISOString(), winner: null, myScore: 0, opponentScore: 0 });
  return (
    <>
      <PageHeader title="Practice" subtitle="Skills & Drills" backFallback="/practice" />
      <div className="tab-content">
        <div style={{fontSize:12,color:"#9FC4B4",marginBottom:10}}>Practice on your own — use Track a Rack for shot-by-shot detail, or work through drills without an opponent.</div>
        {recordStatus === "checking" && <div className="card"><Loader /><div className="card__title">Preparing your practice session…</div></div>}
        {recordStatus === "error" && <div className="card"><div className="error-msg">{recordError}</div><button className="btn-secondary" style={{marginTop:10}} onClick={() => { setRecordStatus("checking"); setRecordAttempt(n => n + 1); }}>Retry</button></div>}
        {recordStatus === "ready" && <div className="card">
          <div className="card__title">Track a Rack</div>
          {profile?.player_num ? <ShotTracker contextType="practice_game" contextId={session.gameId} player={{ num: profile.player_num, name: profile.username || "You" }} opponentNum={null} gameType={session.gameType} /> :
            <div className="dash-empty">Your league player profile is not linked, so shot tracking is unavailable for your account.</div>}
          <button className="btn-primary" style={{marginTop:12}} onClick={finish}>Finish Practice</button>
        </div>}
        <button className="btn-secondary" onClick={onBack}>← Back to Game Type</button>
      </div>
    </>
  );
}

// ─── Step 5: play (running tally) ───────────────────────────────────────────
function PlayStep({ profile, session, setSession, onDone, onBack }) {
  const [recordStatus, setRecordStatus] = useState("checking");
  const [recordError, setRecordError] = useState("");
  const [recordAttempt, setRecordAttempt] = useState(0);

  // The parent row must exist before shot logging is enabled. Persist the UUID
  // into the active session first so a resumed session reuses the same row.
  useEffect(() => {
    let cancelled = false;
    const ensureRecord = async () => {
      if (!profile?.id) {
        setRecordError("Your account could not be identified. Sign in again before logging shots.");
        setRecordStatus("error");
        return;
      }
      if (!session.gameId) {
        setSession(current => current?.gameId ? current : { ...current, gameId: crypto.randomUUID() });
        return;
      }
      setRecordStatus("checking");
      setRecordError("");
      try {
        let existing = await db.getPracticeGame(session.gameId, profile.id);
        if (!existing) {
          // A second mount (for example React StrictMode) may race the first
          // insert on the same UUID. Re-read after an insert conflict rather
          // than creating a second parent row or failing a valid resume.
          existing = await db.createPracticeGame({ id: session.gameId, ...practiceGameRow(profile, session) });
          if (!existing) existing = await db.getPracticeGame(session.gameId, profile.id);
        }
        if (!existing) throw new Error("The practice game could not be created or recovered.");
        if (!cancelled) setRecordStatus("ready");
      } catch (error) {
        if (!cancelled) {
          setRecordError(error?.message || "Unable to prepare this practice game.");
          setRecordStatus("error");
        }
      }
    };
    ensureRecord();
    return () => { cancelled = true; };
  }, [session.gameId, profile?.id, recordAttempt]);

  const myScore = session.myScore ?? 0;
  const oppScore = session.opponentScore ?? 0;
  const gameLog = session.gameLog ?? [];
  const myPts = session.myPts ?? "";
  const oppPts = session.oppPts ?? "";
  const [err, setErr] = useState("");

  const isEightBall = session.gameType === "8ball";
  const myPlayer = profile?.player_num ? { num: profile.player_num, name: profile.username || "You" } : null;
  const opponentPlayer = session.opponentType === "player" && session.opponentPlayerNum
    ? { num: session.opponentPlayerNum, name: session.opponentName }
    : null;

  const gameWinTarget = session.scoringMethod === "best_of_games" ? Math.floor(session.x / 2) + 1 : session.x;
  const oppTarget = session.scoringMethod === "race_to_points" ? session.opponentRating : gameWinTarget;
  const myTargetDisplay = session.scoringMethod === "race_to_points" ? session.myRating : gameWinTarget;

  const winner = myScore >= myTargetDisplay ? "me" : oppScore >= oppTarget ? "opponent" : null;

  const bump = (who, delta) => {
    setSession(s => who === "me"
      ? { ...s, myScore: Math.max(0, (s.myScore ?? 0) + delta) }
      : { ...s, opponentScore: Math.max(0, (s.opponentScore ?? 0) + delta) });
  };

  const recordGame = () => {
    setErr("");
    const my = Number(myPts), opp = Number(oppPts);
    if (myPts === "" || oppPts === "" || Number.isNaN(my) || Number.isNaN(opp)) { setErr("Enter both scores."); return; }
    if (my === opp) { setErr("Scores can't be tied — one side has to win the game."); return; }
    const gameWinner = my > opp ? "me" : "opponent";
    setSession(s => ({
      ...s,
      gameLog: [...(s.gameLog ?? []), { myPoints: my, oppPoints: opp, winner: gameWinner }],
      myScore: (s.myScore ?? 0) + (session.scoringMethod === "race_to_points" ? my : gameWinner === "me" ? 1 : 0),
      opponentScore: (s.opponentScore ?? 0) + (session.scoringMethod === "race_to_points" ? opp : gameWinner === "opponent" ? 1 : 0),
      myPts: "", oppPts: "",
    }));
  };
  const undoLastGame = () => {
    if (gameLog.length === 0) return;
    const last = gameLog[gameLog.length - 1];
    setSession(s => ({
      ...s,
      gameLog: (s.gameLog ?? []).slice(0, -1),
      myScore: Math.max(0, (s.myScore ?? 0) - (session.scoringMethod === "race_to_points" ? last.myPoints : last.winner === "me" ? 1 : 0)),
      opponentScore: Math.max(0, (s.opponentScore ?? 0) - (session.scoringMethod === "race_to_points" ? last.oppPoints : last.winner === "opponent" ? 1 : 0)),
    }));
  };

  const finish = () => {
    onDone({ ...session, myScore, opponentScore: oppScore, winner, gameLog, completedAt: new Date().toISOString() });
  };

  return (
    <>
      <PageHeader title="Practice" subtitle={`${gameTypeLabel(session.gameType)} · ${scoringMethodLabel(session.scoringMethod)}`} backFallback="/" />
      <div className="tab-content">
        <div style={{fontSize:12,color:"#9FC4B4",marginBottom:10}}>Your session is saved as you go. You can leave this screen and resume from the active-session bar.</div>
        {recordStatus === "checking" && <div className="card"><Loader /><div className="card__title">Preparing your practice game…</div></div>}
        {recordStatus === "error" && (
          <div className="card">
            <div className="error-msg">{recordError}</div>
            <button className="btn-secondary" style={{marginTop:10}} onClick={() => { setRecordStatus("checking"); setRecordAttempt(n => n + 1); }}>Retry</button>
          </div>
        )}
        {recordStatus === "ready" && (
          <div className="card">
            <div className="card__title">Track a Rack</div>
            {myPlayer ? (
              <ShotTracker contextType="practice_game" contextId={session.gameId} player={myPlayer}
                opponentNum={session.opponentType === "player" ? session.opponentPlayerNum : null}
                gameType={session.gameType} />
            ) : (
              <div className="dash-empty">Your league player profile is not linked, so shot tracking is unavailable for your account.</div>
            )}
            {opponentPlayer && myPlayer && (
              <ShotTracker contextType="practice_game" contextId={session.gameId} player={opponentPlayer}
                opponentNum={myPlayer?.num ?? null} gameType={session.gameType} />
            )}
            {session.opponentType === "manual" && (
              <div className="dash-empty" style={{marginTop:6}}>Your shots are tracked normally. Opponent shot tracking is available when you select a league player.</div>
            )}
          </div>
        )}
        <div className="play-tally">
          <div className="play-tally__side">
            <div className="play-tally__name">You</div>
            <div className="play-tally__score">{myScore}</div>
            <div className="play-tally__target">of {myTargetDisplay}</div>
            {!isEightBall && (
              <div className="play-tally__btns">
                <button className="btn-icon" onClick={()=>bump("me",-1)}><Minus size={14}/></button>
                <button className="btn-icon btn-icon--confirm" onClick={()=>bump("me",1)}><Plus size={14}/></button>
              </div>
            )}
          </div>
          <div className="play-tally__vs">vs</div>
          <div className="play-tally__side">
            <div className="play-tally__name">{session.opponentName}</div>
            <div className="play-tally__score">{oppScore}</div>
            <div className="play-tally__target">of {oppTarget}</div>
            {!isEightBall && (
              <div className="play-tally__btns">
                <button className="btn-icon" onClick={()=>bump("opponent",-1)}><Minus size={14}/></button>
                <button className="btn-icon btn-icon--confirm" onClick={()=>bump("opponent",1)}><Plus size={14}/></button>
              </div>
            )}
          </div>
        </div>

        {isEightBall && !winner && (
          <div className="card">
            <div className="card__title">Record This Game's Score</div>
            <div style={{display:"flex",gap:10,alignItems:"flex-end",marginTop:6}}>
              <div className="field" style={{flex:1}}><div className="form-label">You</div>
                <input className="input" type="number" value={myPts} onChange={e=>setSession(s=>({...s,myPts:e.target.value}))} placeholder="0" /></div>
              <div style={{fontSize:13,color:"#6A6A6A",paddingBottom:12}}>–</div>
              <div className="field" style={{flex:1}}><div className="form-label">{session.opponentName}</div>
                <input className="input" type="number" value={oppPts} onChange={e=>setSession(s=>({...s,oppPts:e.target.value}))} placeholder="0" /></div>
            </div>
            {err && <div className="error-msg" style={{marginTop:8}}>{err}</div>}
            <button className="btn-primary" style={{marginTop:10}} onClick={recordGame}>Submit Game Score</button>
            {gameLog.length > 0 && <button className="btn-secondary" style={{marginTop:8}} onClick={undoLastGame}>Undo Last Game</button>}
          </div>
        )}

        {winner && (
          <div className="card" style={{textAlign:"center",borderColor:"#1F6B4A",background:"#0F2D1F"}}>
            <Trophy size={22} color="#5FCF9E" style={{margin:"0 auto 8px"}}/>
            <div className="card__title" style={{color:"#5FCF9E"}}>{winner === "me" ? "You win!" : `${session.opponentName} wins!`}</div>
            <button className="btn-primary" style={{marginTop:10}} onClick={finish} disabled={recordStatus !== "ready"}>Save Game</button>
          </div>
        )}

        <button className="btn-secondary" onClick={onBack}>← Back to Setup</button>
      </div>
    </>
  );
}

// ─── Step 6: done (save) ────────────────────────────────────────────────────
function DoneStep({ profile, session, onSaved }) {
  const [saving, setSaving] = useState(true);
  const [error, setError] = useState("");
  const saveResult = async () => {
    setSaving(true);
    setError("");
    try {
      const saved = session.gameId
        ? await db.updatePracticeGame(session.gameId, profile.id, practiceGameRow(profile, session))
        : null;
      if (saved) {
        onSaved();
        return;
      }
      setError("The practice result could not be saved. Your shot log is still attached to this practice game; retry the result save.");
    } catch (saveError) {
      setError(saveError?.message || "The practice result could not be saved. Please retry.");
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => { saveResult(); }, []);
  return (
    <>
      <PageHeader title="Practice" hideBack />
      <div className="tab-content">
        {saving ? <Loader /> : (
          <div className="card">
            <div className="error-msg">{error}</div>
            <button className="btn-primary" style={{marginTop:10}} onClick={saveResult}>Retry Save</button>
          </div>
        )}
      </div>
    </>
  );
}

export const practiceCss = `
.chip{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:20px;padding:8px 14px;color:#E0E0E0;font-size:12px;font-weight:600;cursor:pointer;}
.play-tally{display:flex;align-items:center;gap:10px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:16px;padding:20px 10px;}
.play-tally__side{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;}
.play-tally__vs{font-size:11px;color:#6A6A6A;font-weight:700;}
.play-tally__name{font-size:12px;font-weight:700;color:#9FC4B4;text-align:center;}
.play-tally__score{font-family:'JetBrains Mono',monospace;font-size:40px;font-weight:700;color:#FFF;line-height:1;}
.play-tally__target{font-size:10.5px;color:#6A6A6A;}
.play-tally__btns{display:flex;gap:8px;margin-top:4px;}
`;
