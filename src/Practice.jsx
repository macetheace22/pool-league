import { useState, useEffect } from "react";
import { Plus, Minus, Search, Check, ChevronRight, Trophy } from "lucide-react";
import { useAuth } from "./AuthContext";
import { PageHeader, TabBar, shellCss } from "./Shell";
import { css, Loader } from "./AdminApp";
import { dashboardCss } from "./Dashboard";
import * as db from "./db";

const GAME_TYPES = [
  { key: "8ball", label: "8-Ball" },
  { key: "9ball", label: "9-Ball" },
  { key: "10ball", label: "10-Ball" },
  { key: "ultimate", label: "Ultimate Pool" },
];
const FORMATS = [
  { key: "race", label: "Race to X", desc: "First to win X games" },
  { key: "bestof", label: "Best of X", desc: "First to win more than half (pick an odd X)" },
  { key: "match", label: "Match", desc: "Race to your own rating — no margin scoring, just first there wins" },
];

function gameTypeLabel(key) { return GAME_TYPES.find(g => g.key === key)?.label ?? key; }

export default function Practice() {
  const { profile } = useAuth();
  const [phase, setPhase] = useState("landing"); // landing | opponent | gametype | format | config | play | done
  const [session, setSession] = useState(null);
  const [history, setHistory] = useState(undefined);
  const [opponents, setOpponents] = useState([]);

  const refreshHistory = () => { if (profile) db.listMyPracticeGames(profile.id).then(setHistory); };
  const refreshOpponents = () => { if (profile) db.listMyPracticeOpponents(profile.id).then(setOpponents); };
  useEffect(() => { refreshHistory(); refreshOpponents(); }, [profile?.id]);

  const startSession = () => {
    setSession({
      opponentType: null, opponentPlayerNum: null, opponentId: null, opponentName: "", opponentRating: null,
      gameType: null, format: null, x: 5, myRating: null, myScore: 0, opponentScore: 0,
    });
    setPhase("opponent");
  };
  const cancelSession = () => { setSession(null); setPhase("landing"); };

  const wrap = (children) => (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style><style>{dashboardCss}</style><style>{practiceCss}</style>
      {children}
      <TabBar />
    </div>
  );

  if (phase === "opponent") {
    return wrap(<OpponentStep profile={profile} session={session} setSession={setSession}
      onNext={() => setPhase("gametype")} onCancel={cancelSession} />);
  }
  if (phase === "gametype") {
    return wrap(<GameTypeStep session={session} setSession={setSession}
      onNext={() => setPhase("format")} onBack={() => setPhase("opponent")} />);
  }
  if (phase === "format") {
    return wrap(<FormatStep session={session} setSession={setSession}
      onNext={() => setPhase("config")} onBack={() => setPhase("gametype")} />);
  }
  if (phase === "config") {
    return wrap(<ConfigStep profile={profile} session={session} setSession={setSession}
      onNext={() => setPhase("play")} onBack={() => setPhase("format")} />);
  }
  if (phase === "play") {
    return wrap(<PlayStep session={session} setSession={setSession}
      onDone={(finalSession) => { setSession(finalSession); setPhase("done"); }} onBack={() => setPhase("config")} />);
  }
  if (phase === "done") {
    return wrap(<DoneStep profile={profile} session={session}
      onSaved={() => { refreshHistory(); setPhase("landing"); setSession(null); }} />);
  }

  return wrap(<LandingStep profile={profile} history={history} rawOpponents={opponents} onStart={startSession} onLinked={refreshOpponents} />);
}

// ─── Landing ────────────────────────────────────────────────────────────────
function LandingStep({ profile, history, rawOpponents, onStart, onLinked }) {
  const [filterOpponent, setFilterOpponent] = useState(null);
  const [linkingKey, setLinkingKey] = useState(null);

  const opponentKey = (g) => g.opponent_player_num ? `p:${g.opponent_player_num}` : `o:${g.opponent_id}`;
  const byOpponent = {};
  (history ?? []).forEach(g => {
    const key = opponentKey(g);
    if (!byOpponent[key]) byOpponent[key] = { key, name: g.opponent_name, wins: 0, losses: 0, opponentId: g.opponent_id ?? null };
    if (g.winner === "me") byOpponent[key].wins++; else if (g.winner === "opponent") byOpponent[key].losses++;
  });
  const opponents = Object.values(byOpponent).sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses));
  const visibleGames = filterOpponent ? (history ?? []).filter(g => opponentKey(g) === filterOpponent) : (history ?? []).slice(0, 10);
  const rawById = Object.fromEntries((rawOpponents ?? []).map(o => [o.id, o]));

  return (
    <>
      <PageHeader title="Practice" hideBack />
      <div className="tab-content">
        <button className="btn-primary" onClick={onStart}>+ New Practice Session</button>

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

        <div className="card">
          <div className="card__title">{filterOpponent ? "Games vs This Opponent" : "Recent Games"}</div>
          {history === undefined && <Loader />}
          {history && visibleGames.length === 0 && <div className="dash-empty">No practice games yet.</div>}
          {history && visibleGames.map(g => (
            <div key={g.id} className="match-row">
              <div className="match-row__opponent">
                vs {g.opponent_name} <span style={{color: g.winner === "me" ? "#5FCF9E" : "#F87171", fontWeight:700}}>
                  {g.winner === "me" ? "Won" : g.winner === "opponent" ? "Lost" : "—"}
                </span>
              </div>
              <div className="match-row__meta">{gameTypeLabel(g.game_type)} · {g.my_score}–{g.opponent_score} · {new Date(g.played_at).toLocaleDateString()}</div>
            </div>
          ))}
          {filterOpponent && <button className="btn-secondary" style={{marginTop:8}} onClick={() => setFilterOpponent(null)}>Show All</button>}
        </div>
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
      <PageHeader title="Practice" subtitle="Who are you playing?" />
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
  return (
    <>
      <PageHeader title="Practice" subtitle={`vs ${session.opponentName}`} />
      <div className="tab-content">
        <div className="card">
          <div className="card__title">Game Type</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:6}}>
            {GAME_TYPES.map(g => (
              <button key={g.key} className={`seg-btn ${session.gameType===g.key?"seg-btn--active":""}`} style={{padding:14}}
                onClick={() => { setSession(s => ({ ...s, gameType: g.key })); onNext(); }}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
      </div>
    </>
  );
}

// ─── Step 3: format ─────────────────────────────────────────────────────────
function FormatStep({ session, setSession, onNext, onBack }) {
  const matchAvailable = session.gameType === "8ball";
  const matchPending = session.gameType === "ultimate"; // rules TBD, not simply "no rating concept"
  const matchUnavailableReason = matchPending
    ? "Ultimate Pool's timed rating format is being defined — coming soon."
    : "9-Ball and 10-Ball don't use a rating/handicap — this format doesn't apply to this game.";
  return (
    <>
      <PageHeader title="Practice" subtitle={`${gameTypeLabel(session.gameType)} vs ${session.opponentName}`} />
      <div className="tab-content">
        <div className="card">
          <div className="card__title">Format</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:6}}>
            {FORMATS.map(f => {
              const disabled = f.key === "match" && !matchAvailable;
              return (
                <button key={f.key} className="seg-btn" style={{padding:14,textAlign:"left",opacity:disabled?0.4:1,cursor:disabled?"not-allowed":"pointer"}}
                  disabled={disabled}
                  onClick={() => { setSession(s => ({ ...s, format: f.key })); onNext(); }}>
                  <div style={{fontWeight:700}}>{f.label}</div>
                  <div style={{fontSize:10.5,color:"#9A9A9A",fontWeight:500,marginTop:2}}>
                    {disabled ? matchUnavailableReason : f.desc}
                  </div>
                </button>
              );
            })}
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

  const isMatch = session.format === "match";
  const isBestOf = session.format === "bestof";

  const next = () => {
    setErr("");
    if (!isMatch) {
      const n = Number(x);
      if (!n || n < 1) { setErr("Enter a valid number."); return; }
      if (isBestOf && n % 2 === 0) { setErr("Best of needs an odd number (e.g. 3, 5, 7)."); return; }
      setSession(s => ({ ...s, x: n }));
    } else {
      const my = Number(myRating), opp = Number(oppRating);
      if (!my || !opp) { setErr("Enter a rating for both players."); return; }
      setSession(s => ({ ...s, myRating: my, opponentRating: opp }));
    }
    onNext();
  };

  return (
    <>
      <PageHeader title="Practice" subtitle={`${gameTypeLabel(session.gameType)} vs ${session.opponentName}`} />
      <div className="tab-content">
        <div className="card">
          {!isMatch ? (
            <>
              <div className="card__title">{isBestOf ? "Best of How Many?" : "Race to How Many?"}</div>
              <div style={{fontSize:11.5,color:"#9A9A9A",marginBottom:8}}>
                {isBestOf ? "Pick an odd number — first to win more than half takes it." : "First to win this many games takes it."}
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

// ─── Step 5: play (running tally) ───────────────────────────────────────────
function PlayStep({ session, setSession, onDone, onBack }) {
  const [myScore, setMyScore] = useState(0);
  const [oppScore, setOppScore] = useState(0);
  const [gameLog, setGameLog] = useState([]); // 8-ball only: [{myPoints, oppPoints, winner}, ...]
  const [myPts, setMyPts] = useState("");
  const [oppPts, setOppPts] = useState("");
  const [err, setErr] = useState("");

  const isEightBall = session.gameType === "8ball";

  const oppTarget = session.format === "match" ? session.opponentRating
    : session.format === "bestof" ? Math.floor(session.x / 2) + 1 : session.x;
  const myTargetDisplay = session.format === "match" ? session.myRating
    : session.format === "bestof" ? Math.floor(session.x / 2) + 1 : session.x;

  const winner = myScore >= myTargetDisplay ? "me" : oppScore >= oppTarget ? "opponent" : null;

  const bump = (who, delta) => {
    if (who === "me") setMyScore(s => Math.max(0, s + delta));
    else setOppScore(s => Math.max(0, s + delta));
  };

  const recordGame = () => {
    setErr("");
    const my = Number(myPts), opp = Number(oppPts);
    if (myPts === "" || oppPts === "" || Number.isNaN(my) || Number.isNaN(opp)) { setErr("Enter both scores."); return; }
    if (my === opp) { setErr("Scores can't be tied — one side has to win the game."); return; }
    const gameWinner = my > opp ? "me" : "opponent";
    setGameLog(log => [...log, { myPoints: my, oppPoints: opp, winner: gameWinner }]);
    bump(gameWinner, 1);
    setMyPts(""); setOppPts("");
  };
  const undoLastGame = () => {
    setGameLog(log => {
      if (log.length === 0) return log;
      const last = log[log.length - 1];
      bump(last.winner, -1);
      return log.slice(0, -1);
    });
  };

  const finish = () => {
    onDone({ ...session, myScore, opponentScore: oppScore, winner, gameLog });
  };

  return (
    <>
      <PageHeader title="Practice" subtitle={`${gameTypeLabel(session.gameType)} · ${FORMATS.find(f=>f.key===session.format)?.label}`} hideBack />
      <div className="tab-content">
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
                <input className="input" type="number" value={myPts} onChange={e=>setMyPts(e.target.value)} placeholder="0" /></div>
              <div style={{fontSize:13,color:"#6A6A6A",paddingBottom:12}}>–</div>
              <div className="field" style={{flex:1}}><div className="form-label">{session.opponentName}</div>
                <input className="input" type="number" value={oppPts} onChange={e=>setOppPts(e.target.value)} placeholder="0" /></div>
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
            <button className="btn-primary" style={{marginTop:10}} onClick={finish}>Save Game</button>
          </div>
        )}

        <button className="btn-secondary" onClick={onBack}>← Back to Setup</button>
      </div>
    </>
  );
}

// ─── Step 6: done (save) ────────────────────────────────────────────────────
function DoneStep({ profile, session, onSaved }) {
  useEffect(() => {
    const row = {
      created_by: profile.id,
      opponent_player_num: session.opponentType === "player" ? session.opponentPlayerNum : null,
      opponent_id: session.opponentType === "manual" ? session.opponentId : null,
      opponent_name: session.opponentName,
      game_type: session.gameType,
      format: session.format,
      target_config: session.format === "match"
        ? { myTarget: session.myRating, oppTarget: session.opponentRating }
        : { x: session.x },
      my_rating: session.format === "match" ? session.myRating : null,
      opponent_rating: session.format === "match" ? session.opponentRating : null,
      my_score: session.myScore,
      opponent_score: session.opponentScore,
      winner: session.winner,
      game_log: session.gameLog ?? [],
    };
    db.savePracticeGame(row).then(() => onSaved());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <PageHeader title="Practice" hideBack />
      <div className="tab-content"><Loader /></div>
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
