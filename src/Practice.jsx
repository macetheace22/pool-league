import { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { Search, Check, ChevronRight, Trophy, Plus } from "lucide-react";
import { useAuth } from "./AuthContext";
import { PageHeader, TabBar, shellCss } from "./Shell";
import { css, Loader } from "./AdminApp";
import { dashboardCss } from "./Dashboard";
import * as db from "./db";
import { useActiveSession } from "./ActiveSessionContext";
import { isResumablePracticeSession } from "./activeSessionUtils";
import ShotTracker, { shotTrackerCss } from "./ShotTracker";
import Scoresheet from "./Scoresheet";

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

function practiceSessionSnapshot(session) {
  const {
    gameLog, myScore, opponentScore, myPts, oppPts, winner, completedAt,
    ...setupAndIdentity
  } = session ?? {};
  return setupAndIdentity;
}

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
    my_target: session.scoringMethod === "race_to_points" ? session.myRating : null,
    opponent_target: session.scoringMethod === "race_to_points" ? session.opponentRating : null,
    target_games: session.scoringMethod && session.scoringMethod !== "race_to_points" ? session.x : null,
    table_size_feet: session.tableSizeFeet ?? null,
    my_rating: session.scoringMethod === "race_to_points" ? session.myRating : null,
    opponent_rating: session.scoringMethod === "race_to_points" ? session.opponentRating : null,
    my_score: session.myScore ?? 0,
    opponent_score: session.opponentScore ?? 0,
    winner: session.winner ?? null,
  };
}

export default function Practice() {
  const { profile } = useAuth();
  const location = useLocation();
  const { activeSession, setActiveSession, clearActiveSession } = useActiveSession();
  const restoredPractice = isResumablePracticeSession(activeSession) ? activeSession.data : null;
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
        ? { ...current, title: session.opponentName ? `vs ${session.opponentName}` : "Practice session", subtitle: [gameType, score].filter(Boolean).join(" · "), data: { phase, startedByUser: true, session: practiceSessionSnapshot(session) } }
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
      gameType: null, format: null, tableSizeFeet: null, x: 5, myRating: null,
    };
    setSessionState(initial);
    setPhase("type");

  };
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("home") === "1") {
      setPhase("landing");
      return;
    }
    if (params.get("start") === "1" && phase === "landing") startSession();
  }, [location.search, phase]);
  const activatePracticeSession = (nextPhase) => {
    setActiveSession({
      type: "practice", ownerId: profile?.id, route: "/practice",
      title: session?.opponentName ? `vs ${session.opponentName}` : "Practice session",
      subtitle: session?.gameType ? gameTypeLabel(session.gameType) : "Practice in progress",
      data: { phase: nextPhase, startedByUser: true, session: practiceSessionSnapshot(session) },
    });
  };
  const cancelSession = () => { clearActiveSession(); setSessionState(null); setPhase("landing"); };
  const discardSession = async () => {
    if (!session?.gameId || !profile?.id) return;
    const confirmed = window.confirm("Discard this practice session? All saved game results and Track a Rack shot details for this unfinished session will be permanently deleted.");
    if (!confirmed) return;
    try {
      await db.discardPracticeGame(session.gameId);
      clearActiveSession();
      setSessionState(null);
      setPhase("landing");
      refreshHistory();
    } catch (error) {
      window.alert(error?.message || "The practice session could not be discarded. Please try again.");
    }
  };

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
      onNext={() => changePhase("gametype")} onBack={() => changePhase("type")} onCancel={cancelSession} />);
  }
  if (phase === "gametype") {
    return wrap(<GameTypeStep session={session} setSession={setSession}
      onNext={() => changePhase("tablesize")}
      onBack={() => changePhase(session.practiceType === "skills_drills" ? "type" : "opponent")} onCancel={cancelSession} />);
  }
  if (phase === "tablesize") {
    return wrap(<TableSizeStep session={session} setSession={setSession}
      onNext={() => {
        const nextPhase = session.practiceType === "skills_drills" ? "skillsplay" : "scoring";
        if (nextPhase === "skillsplay") activatePracticeSession(nextPhase);
        changePhase(nextPhase);
      }}
      onBack={() => changePhase("gametype")} onCancel={cancelSession} />);
  }
  if (phase === "scoring") {
    return wrap(<ScoringMethodStep session={session} setSession={setSession}
      onNext={() => changePhase("config")} onBack={() => changePhase("tablesize")} onCancel={cancelSession} />);
  }
  if (phase === "config") {
    return wrap(<ConfigStep profile={profile} session={session} setSession={setSession}
      onNext={() => { activatePracticeSession("play"); changePhase("play"); }} onBack={() => changePhase("scoring")} onCancel={cancelSession} />);
  }
  if (phase === "skillsplay") {
    return wrap(<SkillsDrillsStep profile={profile} session={session} setSession={setSession}
      onDone={(finalSession) => { setSessionState(finalSession); setPhase("done"); setActiveSession({ type: "practice", route: "/practice", title: "Saving practice result", subtitle: "Skills & Drills", data: { phase: "done", startedByUser: true, session: practiceSessionSnapshot(finalSession) } }); }}
      onBack={() => changePhase("gametype")} onDiscard={discardSession} />);
  }
  if (phase === "play") {
    return wrap(<PlayStep profile={profile} session={session} setSession={setSession}
      onDone={(finalSession) => { setSessionState(finalSession); setPhase("done"); setActiveSession({ type: "practice", route: "/practice", title: "Saving practice result", subtitle: finalSession.opponentName, data: { phase: "done", session: practiceSessionSnapshot(finalSession) } }); }} onBack={() => changePhase("config")} onDiscard={discardSession} />);
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
  const [selectedGameId, setSelectedGameId] = useState(null);
  const [linkRequests, setLinkRequests] = useState([]);
  const [claimCodeInput, setClaimCodeInput] = useState("");
  const [claimCodeMessage, setClaimCodeMessage] = useState("");
  const [claimCodeBusy, setClaimCodeBusy] = useState(false);
  const [generatedClaimCodes, setGeneratedClaimCodes] = useState({});
  const [generatingClaimCodeFor, setGeneratingClaimCodeFor] = useState(null);
  const refreshLinkRequests = () => db.listPracticeOpponentLinkRequests().then(setLinkRequests);
  useEffect(() => { refreshLinkRequests(); }, [profile?.id]);

  const redeemClaimCode = async () => {
    if (!claimCodeInput.trim()) return;
    setClaimCodeBusy(true);
    setClaimCodeMessage("");
    const result = await db.redeemPracticeOpponentClaimCode(claimCodeInput);
    setClaimCodeBusy(false);
    if (result.ok) {
      setClaimCodeInput("");
      setClaimCodeMessage("Claim request sent. The owner must approve before the practice history is linked.");
      refreshLinkRequests();
    } else {
      const messages = {
        INVALID_CODE: "That claim code wasn't recognized.",
        CODE_USED: "That claim code has already been used or revoked.",
        CODE_EXPIRED: "That claim code has expired.",
        OWN_CODE: "You can't redeem a claim code you created.",
        PENDING_EXISTS: "There is already a pending identity request for this opponent.",
        OPPONENT_UNAVAILABLE: "That practice opponent is no longer available to claim.",
      };
      setClaimCodeMessage(messages[result.status] || "Couldn't redeem the code. Please try again.");
    }
  };

  const generateClaimCode = async (opponentId) => {
    setGeneratingClaimCodeFor(opponentId);
    const code = await db.createPracticeOpponentClaimCode(opponentId);
    setGeneratingClaimCodeFor(null);
    if (code) setGeneratedClaimCodes(prev => ({ ...prev, [opponentId]: code }));
  };

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
        <div className="card">
          <div className="card__title">Claim a Practice Identity</div>
          <div style={{fontSize:11,color:"#999",lineHeight:1.5,marginBottom:8}}>
            If someone shared a claim code for a practice opponent that represents you, enter it here. The person who created that opponent entry must approve your request.
          </div>
          <div style={{display:"flex",gap:8}}>
            <input className="input input--code" value={claimCodeInput} onChange={e=>setClaimCodeInput(e.target.value)} placeholder="Paste claim code" autoCapitalize="none" />
            <button className="btn-primary" onClick={redeemClaimCode} disabled={!claimCodeInput.trim()||claimCodeBusy}>{claimCodeBusy?"Checking…":"Submit"}</button>
          </div>
          {claimCodeMessage && <div className="success-msg" style={{marginTop:8}}>{claimCodeMessage}</div>}
        </div>
        {linkRequests.length > 0 && (
          <div className="card">
            <div className="card__title">Practice Identity Requests</div>
            {linkRequests.map(request => {
              const incoming = request.direction === "incoming";
              const pending = request.status === "pending";
              const expired = pending && new Date(request.expires_at).getTime() <= Date.now();
              return (
                <div key={request.request_id} className="list-row" style={{alignItems:"center",gap:8}}>
                  <div className="list-row__body">
                    <div className="list-row__name">
                      {incoming
                        ? (request.link_type === "claim"
                          ? `@${request.requester_username || "player"} wants to claim your ${request.opponent_name} entry`
                          : `You were asked to link ${request.opponent_name} to @${request.requester_username || "player"}`)
                        : (request.link_type === "claim"
                          ? `Your claim for ${request.opponent_name} is awaiting owner approval`
                          : `Request to @${request.target_username || "player"} for ${request.opponent_name}`)}
                    </div>
                    <div className="list-row__sub">
                      {pending ? (expired ? "Expired — awaiting cleanup" : incoming ? "Confirm this is you to connect their practice history" : "Waiting for their confirmation")
                        : request.status[0].toUpperCase() + request.status.slice(1)}
                    </div>
                  </div>
                  {pending && incoming && !expired && (
                    <div style={{display:"flex",gap:5}}>
                      <button className="btn-icon btn-icon--confirm" onClick={async () => { await db.respondPracticeOpponentLink(request.request_id, true); refreshLinkRequests(); onLinked(); }}><Check size={14}/></button>
                      <button className="btn-icon" onClick={async () => { await db.respondPracticeOpponentLink(request.request_id, false); refreshLinkRequests(); }}>Decline</button>
                    </div>
                  )}
                  {pending && !incoming && (
                    <button className="btn-icon" onClick={async () => { await db.cancelPracticeOpponentLinkRequest(request.request_id); refreshLinkRequests(); }}>Cancel</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
                          <div style={{display:"flex",gap:5}}>
                            <button className="btn-icon" onClick={(e)=>{e.stopPropagation(); setLinkingKey(linkingKey===o.key?null:o.key);}}>Link Account</button>
                            <button className="btn-icon" onClick={async (e)=>{e.stopPropagation(); await generateClaimCode(o.opponentId);}} disabled={generatingClaimCodeFor===o.opponentId}>
                              {generatingClaimCodeFor===o.opponentId?"…":"Claim Code"}
                            </button>
                          </div>
                        )}
                        <ChevronRight size={14} color="#6A6A6A" />
                      </div>
                    </div>
                    {linkingKey === o.key && (
                      <LinkOpponentPanel opponentId={o.opponentId} onDone={() => { setLinkingKey(null); onLinked(); refreshLinkRequests(); }} onCancel={() => setLinkingKey(null)} />
                    )}
                    {!linked && generatedClaimCodes[o.opponentId] && (
                      <div className="readonly-bar" style={{marginTop:5,display:"flex",flexDirection:"column",gap:6}}>
                        <span>Share this code with the player. Expires in 7 days.</span>
                        <strong style={{fontSize:13,letterSpacing:1.2,wordBreak:"break-all"}}>{generatedClaimCodes[o.opponentId]}</strong>
                        <button className="btn-secondary" onClick={() => navigator.clipboard?.writeText(generatedClaimCodes[o.opponentId])}>Copy Code</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="card" id="practice-sessions" ref={sessionsRef} style={{ scrollMarginTop: 16 }}>
          <div className="card__title">{filterOpponent ? "Games vs This Opponent" : "My Practice Sessions"}</div>
          <div style={{fontSize:10.5,color:"#777",marginBottom:8}}>Select any session to view its saved game results and Track a Rack history.</div>
          {history === undefined && <Loader />}
          {history && visibleGames.length === 0 && <div className="dash-empty">No practice games yet.</div>}
          {history && visibleGames.map(g => (
            <div key={g.id}>
              <button type="button" className="match-row practice-history-button"
                aria-expanded={selectedGameId === g.id}
                onClick={() => setSelectedGameId(current => current === g.id ? null : g.id)}>
                <span style={{flex:1,minWidth:0,textAlign:"left"}}>
                  <span className="match-row__opponent" style={{display:"block"}}>
                    {g.practice_type === "skills_drills" ? "Skills & Drills" : `vs ${g.opponent_name}`}
                    {g.practice_type !== "skills_drills" && <span style={{color: g.winner === "me" ? "#5FCF9E" : "#F87171", fontWeight:700, marginLeft:6}}>
                      {g.winner === "me" ? "Won" : g.winner === "opponent" ? "Lost" : "—"}
                    </span>}
                  </span>
                  <span className="match-row__meta" style={{display:"block"}}>
                    {gameTypeLabel(g.game_type)}
                    {g.scoring_method ? ` · ${scoringMethodLabel(g.scoring_method)}` : ""}
                    {g.practice_type !== "skills_drills" ? ` · ${g.my_score}–${g.opponent_score}` : ""}
                    {` · ${new Date(g.completed_at || g.played_at).toLocaleDateString()}`}
                  </span>
                </span>
                <ChevronRight size={16} style={{transform:selectedGameId === g.id ? "rotate(90deg)" : "none",flexShrink:0}} color="#6A6A6A" />
              </button>
              {selectedGameId === g.id && <Scoresheet key={g.id} practiceGame={g} profile={profile} closeLabel="Close" onClose={() => setSelectedGameId(null)} />}
            </div>
          ))}
          {filterOpponent && <button className="btn-secondary" style={{marginTop:8}} onClick={() => { setFilterOpponent(null); setSelectedGameId(null); }}>Show All</button>}
        </div>
      </div>
    </>
  );
}

// ─── Step 1: practice type ─────────────────────────────────────────────────
function PracticeTypeStep({ session, setSession, onNext, onCancel }) {
  return (
    <>
      <PageHeader title="Practice" hideBack />
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
  const [selected, setSelected] = useState(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      if (query.trim().length >= 2) db.searchProfilesByUsername(query).then(setResults);
      else setResults([]);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const sendRequest = async () => {
    if (!selected) return;
    setSending(true);
    const result = await db.requestPracticeOpponentLink(opponentId, selected.id);
    setSending(false);
    if (result.ok) onDone();
    else setMessage(result.status === "PENDING_EXISTS"
      ? "A request is already waiting for another account. Cancel it before sending a new one."
      : result.status === "ALREADY_LINKED" ? "This opponent is already linked."
      : "Could not send the request. Please try again.");
  };

  return (
    <div className="card" style={{marginTop:6,marginBottom:6}}>
      <div className="form-label" style={{marginBottom:6}}>Request an identity link</div>
      <div style={{fontSize:11,color:"#999",marginBottom:8}}>Search their username. They must confirm before your practice history is linked.</div>
      <input className="input" value={query} onChange={e=>{setQuery(e.target.value);setSelected(null);}} placeholder="Search by username…" autoFocus />
      {results.length > 0 && (
        <div className="list" style={{marginTop:8}}>
          {results.map(p => (
            <button type="button" key={p.id} className="list-row" style={{width:"100%",textAlign:"left",background:selected?.id===p.id?"#202A25":undefined}} onClick={() => {setSelected(p);setMessage("");}}>
              <div className="list-row__body"><div className="list-row__name">@{p.username}</div></div>
              {selected?.id===p.id && <Check size={15}/>}
            </button>
          ))}
        </div>
      )}
      {message && <div className="error-msg" style={{marginTop:8}}>{message}</div>}
      <div style={{display:"flex",gap:8,marginTop:8}}>
        <button className="btn-primary" onClick={sendRequest} disabled={!selected||sending}>{sending?"Sending…":"Send Request"}</button>
        <button className="btn-secondary" onClick={onCancel} disabled={sending}>Cancel</button>
      </div>
    </div>
  );
}

function OpponentStep({ profile, session, setSession, onNext, onBack, onCancel }) {
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
    setSession(s => ({ ...s, opponentType: "player", opponentPlayerNum: p.num, opponentId: null, opponentName: p.name, opponentRating: p.rating }));
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
      <PageHeader title="Practice" onBack={onBack} />
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
                    <div className="list-row__name">{p.name}</div>
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
function GameTypeStep({ session, setSession, onNext, onBack, onCancel }) {
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
        <div style={{display:"flex",gap:8}}><button className="btn-secondary" style={{flex:1}} onClick={onBack}>← Back</button><button className="btn-secondary" style={{flex:1}} onClick={onCancel}>Cancel</button></div>
      </div>
    </>
  );
}

// ─── Step 3: table size ───────────────────────────────────────────────────
function TableSizeStep({ session, setSession, onNext, onBack, onCancel }) {
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
            Select the table size in feet used for this practice session.
          </div>
          <div className="field">
            <div className="form-label">Size (feet)</div>
            <select className="input" value={value} onChange={e => { setValue(e.target.value); setErr(""); }}>
              <option value="">Select table size</option>
              <option value="7">7 feet</option>
              <option value="8">8 feet</option>
              <option value="9">9 feet</option>
            </select>
          </div>
          {err && <div className="error-msg" style={{marginTop:8}}>{err}</div>}
          <button className="btn-primary" style={{marginTop:10}} onClick={next}>{session.practiceType === "skills_drills" ? "Start Playing" : "Continue"}</button>
        </div>
        <div style={{display:"flex",gap:8}}><button className="btn-secondary" style={{flex:1}} onClick={onBack}>← Back</button><button className="btn-secondary" style={{flex:1}} onClick={onCancel}>Cancel</button></div>
      </div>
    </>
  );
}

// ─── Step 3: scoring method ────────────────────────────────────────────────
function ScoringMethodStep({ session, setSession, onNext, onBack, onCancel }) {
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
        <div style={{display:"flex",gap:8}}><button className="btn-secondary" style={{flex:1}} onClick={onBack}>← Back</button><button className="btn-secondary" style={{flex:1}} onClick={onCancel}>Cancel</button></div>
      </div>
    </>
  );
}

// ─── Step 4: config (target X, or ratings for Match) ───────────────────────
function ConfigStep({ profile, session, setSession, onNext, onBack, onCancel }) {
  const [x, setX] = useState(session.x ?? 5);
  const [myRating, setMyRating] = useState(session.myRating ?? "");
  const [oppRating, setOppRating] = useState(session.opponentRating ?? "");
  const [loadingMyRating, setLoadingMyRating] = useState(session.format === "match");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (session.format !== "match") { setLoadingMyRating(false); return; }
    // A rating entered in an earlier setup pass is authoritative for this
    // session. Only fetch the league default when no session value exists.
    if (session.myRating != null && session.myRating !== "") {
      setMyRating(session.myRating);
      setLoadingMyRating(false);
      return;
    }
    if (!profile?.player_num) { setLoadingMyRating(false); return; }
    let cancelled = false;
    db.getPlayerRating(profile.player_num).then(r => {
      if (cancelled) return;
      const rating = r ?? "";
      setMyRating(rating);
      if (rating !== "") setSession(current => current?.myRating != null && current.myRating !== ""
        ? current : { ...current, myRating: rating });
      setLoadingMyRating(false);
    });
    return () => { cancelled = true; };
  }, [session.format, session.myRating, profile?.player_num]);

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
                    <input className="input" type="text" inputMode="numeric" pattern="[0-9]*" value={myRating} onChange={e=>setMyRating(e.target.value)} placeholder="Enter your rating"/>
                  </div>
                  <div className="field"><div className="form-label">{session.opponentName}'s Rating</div>
                    <input className="input" type="text" inputMode="numeric" pattern="[0-9]*" value={oppRating} onChange={e=>setOppRating(e.target.value)} placeholder="Enter their rating"/>
                  </div>
                </>
              )}
            </>
          )}
          {err && <div className="error-msg" style={{marginTop:8}}>{err}</div>}
          <button className="btn-primary" style={{marginTop:10}} onClick={next}>Start Playing</button>
        </div>
        <div style={{display:"flex",gap:8}}><button className="btn-secondary" style={{flex:1}} onClick={onBack}>← Back</button><button className="btn-secondary" style={{flex:1}} onClick={onCancel}>Cancel</button></div>
      </div>
    </>
  );
}

// ─── Skills & Drills play ─────────────────────────────────────────────────
function SkillsDrillsStep({ profile, session, setSession, onDone, onBack, onDiscard }) {
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
          <button className="btn-secondary" style={{marginTop:8,color:"#F87171",borderColor:"#7F3030"}} onClick={onDiscard} disabled={recordStatus !== "ready"}>Discard Practice</button>
        </div>}
        <button className="btn-secondary" onClick={onBack}>← Back to Game Type</button>
      </div>
    </>
  );
}

// ─── Step 5: play (running tally) ───────────────────────────────────────────
function PlayStep({ profile, session, setSession, onDone, onBack, onDiscard }) {
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
        const results = await db.listPracticeGameResults(session.gameId);
        if (!cancelled) {
          setSession(current => ({
            ...current,
            myScore: existing.my_score ?? 0,
            opponentScore: existing.opponent_score ?? 0,
            gameLog: results.map(result => ({
              id: result.id, gameNumber: result.game_number,
              myPoints: result.my_points, oppPoints: result.opponent_points, winner: result.winner,
            })),
          }));
          setRecordStatus("ready");
        }
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
  const [showScoresheet, setShowScoresheet] = useState(false);

  const isEightBall = session.gameType === "8ball";
  const myPlayer = profile?.player_num ? { num: profile.player_num, name: profile.username || "You" } : null;
  const opponentPlayer = session.opponentType === "player" && session.opponentPlayerNum
    ? { num: session.opponentPlayerNum, name: session.opponentName }
    : null;

  const gameWinTarget = session.scoringMethod === "best_of_games" ? Math.floor(session.x / 2) + 1 : session.x;
  const oppTarget = session.scoringMethod === "race_to_points" ? session.opponentRating : gameWinTarget;
  const myTargetDisplay = session.scoringMethod === "race_to_points" ? session.myRating : gameWinTarget;

  const winner = myScore >= myTargetDisplay ? "me" : oppScore >= oppTarget ? "opponent" : null;

  const [savingResult, setSavingResult] = useState(false);
  const savingResultRef = useRef(false);

  if (showScoresheet) {
    return <Scoresheet
      practiceGame={{
        id: session.gameId,
        practice_type: session.practiceType ?? "opponent",
        scoring_method: session.scoringMethod,
        game_type: session.gameType,
        opponent_player_num: session.opponentPlayerNum ?? null,
        opponent_name: session.opponentName,
        my_score: myScore,
        opponent_score: oppScore,
        played_at: new Date().toISOString(),
      }}
      profile={profile}
      closeLabel="Back to Practice"
      onClose={() => setShowScoresheet(false)}
    />;
  }

  const saveGameResult = async ({ myPoints = null, oppPoints = null, gameWinner }) => {
    if (savingResultRef.current) return;
    savingResultRef.current = true;
    setErr("");
    setSavingResult(true);
    try {
      const saved = await db.recordPracticeGameResult({
        practiceGameId: session.gameId, myPoints, opponentPoints: oppPoints, winner: gameWinner,
      });
      if (!saved) throw new Error("The game result could not be saved. Please retry.");
      setSession(s => ({
        ...s, myScore: saved.my_score, opponentScore: saved.opponent_score,
        gameLog: [...(s.gameLog ?? []), {
          id: saved.result.id, gameNumber: saved.result.game_number,
          myPoints: saved.result.my_points, oppPoints: saved.result.opponent_points,
          winner: saved.result.winner,
        }],
        myPts: "", oppPts: "",
      }));
    } catch (error) {
      setErr(error?.message || "The game result could not be saved. Please retry.");
    } finally {
      savingResultRef.current = false;
      setSavingResult(false);
    }
  };

  const recordGame = () => {
    setErr("");
    const myText = myPts.trim(), oppText = oppPts.trim();
    if (!/^\d+$/.test(myText) || !/^\d+$/.test(oppText)) {
      setErr("Enter a nonnegative whole-number score for both players."); return;
    }
    const my = Number(myText), opp = Number(oppText);
    if (!Number.isInteger(my) || !Number.isInteger(opp) || my < 0 || opp < 0) {
      setErr("Enter nonnegative whole-number scores for both players."); return;
    }
    if (my === opp) { setErr("Scores can't be tied — one side has to win the game."); return; }
    void saveGameResult({ myPoints: my, oppPoints: opp, gameWinner: my > opp ? "me" : "opponent" });
  };

  const recordRackWin = (who) => { void saveGameResult({ gameWinner: who }); };

  const undoLastGame = async () => {
    if (gameLog.length === 0 || savingResultRef.current) return;
    savingResultRef.current = true;
    setErr(""); setSavingResult(true);
    try {
      const undone = await db.undoLastPracticeGameResult(session.gameId);
      if (!undone) throw new Error("The last game could not be undone. Please retry.");
      setSession(s => ({
        ...s, myScore: undone.my_score, opponentScore: undone.opponent_score,
        gameLog: (s.gameLog ?? []).slice(0, -1),
      }));
    } catch (error) {
      setErr(error?.message || "The last game could not be undone. Please retry.");
    } finally {
      savingResultRef.current = false;
      setSavingResult(false);
    }
  };

  const finish = () => {
    onDone({ ...session, myScore, opponentScore: oppScore, winner, gameLog, completedAt: new Date().toISOString() });
  };

  return (
    <>
      <PageHeader title="Practice" subtitle={`${gameTypeLabel(session.gameType)} · ${scoringMethodLabel(session.scoringMethod)}`} onBack={() => changePhase("landing")} />
      <div className="tab-content">
        <div style={{fontSize:12,color:"#9FC4B4",marginBottom:10}}>Game results and scores are saved to your account as you go. You can leave this screen and resume from the active-session bar.</div>
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
            <button type="button" className="play-tally__score play-tally__score-button" aria-label="View practice scoresheet" disabled={recordStatus !== "ready"} onClick={() => setShowScoresheet(true)}>{myScore}</button>
            <div className="play-tally__target">of {myTargetDisplay}</div>
            {!isEightBall && <button className="btn-primary" style={{marginTop:8,padding:"8px 10px",fontSize:11}} disabled={savingResult || !!winner || recordStatus !== "ready"} onClick={() => recordRackWin("me")}>Record Rack Win</button>}
          </div>
          <div className="play-tally__vs">vs</div>
          <div className="play-tally__side">
            <div className="play-tally__name">{session.opponentName}</div>
            <button type="button" className="play-tally__score play-tally__score-button" aria-label="View practice scoresheet" onClick={() => setShowScoresheet(true)}>{oppScore}</button>
            <div className="play-tally__target">of {oppTarget}</div>
            {!isEightBall && <button className="btn-primary" style={{marginTop:8,padding:"8px 10px",fontSize:11}} disabled={savingResult || !!winner || recordStatus !== "ready"} onClick={() => recordRackWin("opponent")}>Record Rack Win</button>}
          </div>
        </div>

        {isEightBall && !winner && (
          <div className="card">
            <div className="card__title">Record This Game's Score</div>
            <div className="practice-score-entry">
              <div className="field practice-score-entry__field"><div className="form-label">You</div>
                <input className="input practice-score-entry__input" type="text" inputMode="numeric" pattern="[0-9]*" value={myPts} onChange={e=>setSession(s=>({...s,myPts:e.target.value}))} placeholder="Enter score" /></div>
              <div className="practice-score-entry__separator">–</div>
              <div className="field practice-score-entry__field"><div className="form-label">{session.opponentName}</div>
                <input className="input practice-score-entry__input" type="text" inputMode="numeric" pattern="[0-9]*" value={oppPts} onChange={e=>setSession(s=>({...s,oppPts:e.target.value}))} placeholder="Enter score" /></div>
            </div>
            {err && <div className="error-msg" style={{marginTop:8}}>{err}</div>}
            <button className="btn-primary" style={{marginTop:10}} onClick={recordGame} disabled={savingResult || recordStatus !== "ready"}>{savingResult ? "Saving…" : "Submit Game Score"}</button>
            {gameLog.length > 0 && <button className="btn-secondary" style={{marginTop:8}} onClick={undoLastGame} disabled={savingResult}>{savingResult ? "Saving…" : "Undo Last Game"}</button>}
          </div>
        )}

        {winner && (
          <div className="card" style={{textAlign:"center",borderColor:"#1F6B4A",background:"#0F2D1F"}}>
            <Trophy size={22} color="#5FCF9E" style={{margin:"0 auto 8px"}}/>
            <div className="card__title" style={{color:"#5FCF9E"}}>{winner === "me" ? "You win!" : `${session.opponentName} wins!`}</div>
            <button className="btn-primary" style={{marginTop:10}} onClick={finish} disabled={recordStatus !== "ready" || savingResult}>Save Game</button>
            {gameLog.length > 0 && <button className="btn-secondary" style={{marginTop:8}} onClick={undoLastGame} disabled={savingResult}>Undo Last Game</button>}
          </div>
        )}

        <button className="btn-secondary" onClick={onBack}>← Back to Setup</button>
        <button className="btn-secondary" style={{marginTop:8,color:"#F87171",borderColor:"#7F3030"}} onClick={onDiscard} disabled={savingResult || recordStatus !== "ready"}>Discard Practice</button>
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
.practice-score-entry{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:end;margin-top:6px;}
.practice-score-entry__field{min-width:0;}
.practice-score-entry__input{min-height:44px;font-size:16px;}
.practice-score-entry__separator{font-size:13px;color:#6A6A6A;padding-bottom:12px;}
@media (max-width:360px){.practice-score-entry{gap:6px;}.practice-score-entry__input{padding-left:9px;padding-right:9px;}}
.practice-history-button{width:100%;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;display:flex;align-items:center;gap:10px;padding:10px 0;text-align:left;}
.practice-scoresheet{margin:8px 0 12px;padding:12px;background:#141414;border:1px solid #333;border-radius:10px;display:flex;flex-direction:column;gap:12px;}
.practice-scoresheet__header{background:#0B3D2E;border-radius:8px;padding:12px;}
.practice-scoresheet__eyebrow,.practice-scoresheet__section-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#9FC4B4;}
.practice-scoresheet__players{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:10px 0;}
.practice-scoresheet__players div{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0;}
.practice-scoresheet__players div:last-child{text-align:right;}
.practice-scoresheet__players strong{font-size:11px;overflow-wrap:anywhere;color:#fff;}
.practice-scoresheet__players b{font-family:'JetBrains Mono',monospace;font-size:25px;color:#fff;}
.practice-scoresheet__players>span{font-size:10px;color:#9FC4B4;}
.practice-scoresheet__meta{font-size:10px;color:#B7D2C6;}
.practice-scoresheet__section{display:flex;flex-direction:column;gap:7px;}
.practice-scoresheet__section-title{color:#9A9A9A;}
.practice-scoresheet__empty{font-size:11px;color:#777;padding:10px;background:#1C1C1C;border-radius:7px;}
.practice-scoresheet__table-wrap{overflow-x:auto;border:1px solid #333;border-radius:7px;}
.practice-scoresheet__table{width:100%;border-collapse:collapse;font-size:10.5px;white-space:nowrap;}
.practice-scoresheet__table th{background:#252525;color:#B7D2C6;text-align:left;font-size:9px;text-transform:uppercase;padding:8px 6px;}
.practice-scoresheet__table td{padding:8px 6px;border-top:1px solid #303030;color:#E0E0E0;}
.practice-scoresheet__events{display:flex;flex-direction:column;gap:5px;}
.practice-scoresheet__event{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;padding:8px;background:#1C1C1C;border-radius:6px;font-size:10.5px;color:#E0E0E0;}
.practice-scoresheet__event>span:nth-child(2){color:#9FC4B4;text-align:right;}
.practice-scoresheet__event time{grid-column:1/-1;font-size:9px;color:#777;}

.chip{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:20px;padding:8px 14px;color:#E0E0E0;font-size:12px;font-weight:600;cursor:pointer;}
.play-tally{display:flex;align-items:center;gap:10px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:16px;padding:20px 10px;}
.play-tally__side{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;}
.play-tally__vs{font-size:11px;color:#6A6A6A;font-weight:700;}
.play-tally__name{font-size:12px;font-weight:700;color:#9FC4B4;text-align:center;}
.play-tally__score{font-family:'JetBrains Mono',monospace;font-size:40px;font-weight:700;color:#FFF;line-height:1;}
.play-tally__score-button{border:0;background:transparent;padding:0;cursor:pointer;line-height:1;}.play-tally__score-button:focus-visible{outline:2px solid #5FCF9E;outline-offset:5px;border-radius:4px;}.play-tally__target{font-size:10.5px;color:#6A6A6A;}
.play-tally__btns{display:flex;gap:8px;margin-top:4px;}
`;
