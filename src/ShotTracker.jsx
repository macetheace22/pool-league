import { useState, useEffect } from "react";
import { Plus, X, Target } from "lucide-react";
import { useAuth } from "./AuthContext";
import * as db from "./db";

// ─── Track a Rack ────────────────────────────────────────────────────────────
// One collapsible, fully optional shot-logger for a single player, reused
// wherever a rack/game is being scored: Live Entry's SetEntry (league night),
// AdminApp's manual match entry (same SetEntry, backfilling), and Practice's
// PlayStep. Never required, never blocks anything, never part of the actual
// confirmed score or dual-confirm -- purely supplemental detail that feeds
// My Stats and any future team/tournament stats sections. Resolves who's
// doing the logging via useAuth() itself rather than a prop, so callers only
// need to say WHAT is being tracked (context + player), not WHO is tracking.
const DISTANCE_TAGS = [{ key: "short", label: "Short" }, { key: "medium", label: "Medium" }, { key: "long", label: "Long" }];
const CUT_TAGS = [{ key: "cut_left", label: "Left Cut" }, { key: "cut_right", label: "Right Cut" }];
const TECHNIQUE_TAGS = [{ key: "jump", label: "Jump" }, { key: "kick", label: "Kick" }, { key: "bank", label: "Bank" }];
const CATEGORIES = [{ key: "shot", label: "Shot" }, { key: "safety", label: "Safety" }, { key: "break", label: "Break" }, { key: "runout", label: "Runout" }];

export default function ShotTracker({ contextType, contextId, setNum = null, player, teamId = null, opponentNum = null, gameType = null, divisionId = null }) {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("shot");
  const [outcome, setOutcome] = useState(null);
  const [distance, setDistance] = useState(null);
  const [cut, setCut] = useState(null);
  const [techniques, setTechniques] = useState(new Set());
  const [isScratch, setIsScratch] = useState(false);
  const [isFoul, setIsFoul] = useState(false);
  const [isMiscue, setIsMiscue] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = () => {
    setLoading(true);
    db.listShotEvents(contextType, contextId, setNum).then(all => {
      setEvents(all.filter(e => e.player_num === player.num));
      setLoading(false);
    });
  };
  useEffect(() => { if (open) refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, contextId, setNum]);

  const resetForm = () => {
    setCategory("shot"); setOutcome(null); setDistance(null); setCut(null);
    setTechniques(new Set()); setIsScratch(false); setIsFoul(false); setIsMiscue(false);
  };
  const toggleTechnique = (key) => setTechniques(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const logEvent = async () => {
    if (category !== "runout" && !outcome) return;
    setSaving(true);
    const tags = category === "shot" ? [distance, cut, ...techniques].filter(Boolean) : [];
    const row = {
      context_type: contextType, context_id: contextId, set_num: setNum,
      player_num: player.num, team_id: teamId, recorded_by: profile?.id ?? null,
      opponent_player_num: opponentNum, game_type: gameType, division_id: divisionId,
      category, outcome: category === "runout" ? null : outcome,
      is_scratch: isScratch, is_foul: isFoul, is_miscue: isMiscue, tags,
    };
    const saved = await db.logShotEvent(row);
    setSaving(false);
    if (saved) { setEvents(e => [...e, saved]); resetForm(); }
  };

  const undo = async (id) => {
    await db.deleteShotEvent(id);
    setEvents(e => e.filter(ev => ev.id !== id));
  };

  const shots = events.filter(e => e.category === "shot");
  const makes = shots.filter(e => e.outcome === "make").length;

  const describeEvent = (e) => {
    const parts = [e.category === "shot" ? (e.outcome === "make" ? "Make" : "Miss")
      : e.category === "safety" ? (e.outcome === "successful" ? "Safety ✓" : "Safety ✗")
      : e.category === "break" ? `Break${e.outcome === "make" ? " · made" : ""}`
      : "Runout"];
    if (e.tags?.length) parts.push(e.tags.map(t => t.replace("cut_", "")).join("/"));
    if (e.is_scratch) parts.push("scratch");
    if (e.is_foul) parts.push("foul");
    if (e.is_miscue) parts.push("miscue");
    return parts.join(" · ");
  };

  return (
    <div className="shot-tracker">
      <button className="shot-tracker__toggle" onClick={() => setOpen(v => !v)}>
        <Target size={12} /> Track {player.name}'s Shots{shots.length > 0 ? ` (${makes}/${shots.length})` : ""}
      </button>
      {open && (
        <div className="shot-tracker__panel">
          {loading ? (
            <div style={{ fontSize: 11, color: "#6A6A6A" }}>Loading…</div>
          ) : (
            <>
              <div className="seg-control">
                {CATEGORIES.map(c => (
                  <button key={c.key} className={`seg-btn ${category === c.key ? "seg-btn--active" : ""}`}
                    onClick={() => { setCategory(c.key); setOutcome(null); }}>{c.label}</button>
                ))}
              </div>

              {category !== "runout" && (
                <div className="shot-tracker__outcome-row">
                  {category === "safety" ? (
                    <>
                      <button className={`shot-tracker__outcome-btn ${outcome === "successful" ? "shot-tracker__outcome-btn--good" : ""}`} onClick={() => setOutcome("successful")}>Successful</button>
                      <button className={`shot-tracker__outcome-btn ${outcome === "unsuccessful" ? "shot-tracker__outcome-btn--bad" : ""}`} onClick={() => setOutcome("unsuccessful")}>Unsuccessful</button>
                    </>
                  ) : (
                    <>
                      <button className={`shot-tracker__outcome-btn ${outcome === "make" ? "shot-tracker__outcome-btn--good" : ""}`} onClick={() => setOutcome("make")}>Make</button>
                      <button className={`shot-tracker__outcome-btn ${outcome === "miss" ? "shot-tracker__outcome-btn--bad" : ""}`} onClick={() => setOutcome("miss")}>Miss</button>
                    </>
                  )}
                </div>
              )}

              {category === "shot" && (
                <>
                  <div className="shot-tracker__tag-row">
                    {DISTANCE_TAGS.map(t => (
                      <button key={t.key} className={`chip ${distance === t.key ? "chip--active" : ""}`} onClick={() => setDistance(d => d === t.key ? null : t.key)}>{t.label}</button>
                    ))}
                  </div>
                  <div className="shot-tracker__tag-row">
                    {CUT_TAGS.map(t => (
                      <button key={t.key} className={`chip ${cut === t.key ? "chip--active" : ""}`} onClick={() => setCut(c => c === t.key ? null : t.key)}>{t.label}</button>
                    ))}
                  </div>
                  <div className="shot-tracker__tag-row">
                    {TECHNIQUE_TAGS.map(t => (
                      <button key={t.key} className={`chip ${techniques.has(t.key) ? "chip--active" : ""}`} onClick={() => toggleTechnique(t.key)}>{t.label}</button>
                    ))}
                  </div>
                </>
              )}

              {category !== "runout" && (
                <div className="shot-tracker__flag-row">
                  <label><input type="checkbox" checked={isScratch} onChange={e => setIsScratch(e.target.checked)} /> Scratch</label>
                  <label><input type="checkbox" checked={isFoul} onChange={e => setIsFoul(e.target.checked)} /> Foul</label>
                  <label><input type="checkbox" checked={isMiscue} onChange={e => setIsMiscue(e.target.checked)} /> Miscue</label>
                </div>
              )}

              <button className="btn-sm btn-sm--accent" onClick={logEvent} disabled={saving || (category !== "runout" && !outcome)}>
                <Plus size={12} /> {saving ? "Logging…" : `Log ${category === "runout" ? "Runout" : "Event"}`}
              </button>

              {events.length > 0 && (
                <div className="shot-tracker__log">
                  {events.slice().reverse().map(e => (
                    <div key={e.id} className="shot-tracker__log-row">
                      <span>{describeEvent(e)}</span>
                      <button className="btn-icon" onClick={() => undo(e.id)}><X size={11} /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const shotTrackerCss = `
.shot-tracker{margin-top:8px;}
.shot-tracker__toggle{width:100%;display:flex;align-items:center;justify-content:center;gap:6px;background:#141414;border:1.5px dashed #3A3A3A;border-radius:9px;padding:8px;font-family:'Archivo',sans-serif;font-size:11px;font-weight:700;color:#9A9A9A;cursor:pointer;}
.shot-tracker__panel{display:flex;flex-direction:column;gap:8px;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:10px;padding:10px;margin-top:6px;}
.shot-tracker__outcome-row{display:flex;gap:8px;}
.shot-tracker__outcome-btn{flex:1;padding:9px;border-radius:8px;border:1.5px solid #3A3A3A;background:#121212;color:#9A9A9A;font-family:'Archivo',sans-serif;font-size:12px;font-weight:700;cursor:pointer;}
.shot-tracker__outcome-btn--good{background:#16332A;border-color:#1F6B4A;color:#5FCF9E;}
.shot-tracker__outcome-btn--bad{background:#2A1010;border-color:#7F1D1D;color:#F87171;}
.shot-tracker__tag-row{display:flex;gap:6px;flex-wrap:wrap;}
.shot-tracker__flag-row{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:#9A9A9A;}
.shot-tracker__flag-row label{display:flex;align-items:center;gap:5px;cursor:pointer;}
.shot-tracker__log{display:flex;flex-direction:column;gap:4px;max-height:140px;overflow-y:auto;border-top:1px solid #2A2A2A;padding-top:6px;}
.shot-tracker__log-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:#8A8A8A;padding:2px 0;}
.chip--active{background:#0F2D1F;border-color:#1F6B4A;color:#5FCF9E;}
`;
