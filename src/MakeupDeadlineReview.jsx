import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Scale } from "lucide-react";
import { useAuth } from "./AuthContext";
import { PageHeader } from "./Shell";
import { supabase } from "./supabaseClient";
import { listRosterForTeam } from "./db";
import { resolveMakeupDeadline } from "./makeupDeadlineResolution";
import { isMakeupWithinProhibitedWindow, makeupCutoffFromFinalRegularSeasonDate } from "./makeupDeadlineRules";

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) {
    const [m, d, y] = text.split("/").map(Number);
    return new Date(y, m - 1, d);
  }
  return null;
}
function formatDate(value) {
  const d = parseDate(value) ?? (value ? new Date(value) : null);
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }) : "—";
}
function formatOutcome(row) {
  const r = row.makeup_deadline_resolution;
  if (!r) return null;
  if (r.outcome === "no_agreement") return "No agreement by deadline";
  if (r.outcome === "team_responsible") {
    const side = r.responsibleSide === "home" ? row.team_home_name : row.team_away_name;
    return side + " caused the missed deadline";
  }
  return null;
}
export default function MakeupDeadlineReview() {
  const { profile } = useAuth();
  const [matches, setMatches] = useState([]);
  const [finalDates, setFinalDates] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [notes, setNotes] = useState({});
  const [errors, setErrors] = useState({});
  const [rosters, setRosters] = useState({});
  const [selections, setSelections] = useState({});
  const canManage = profile?.role === "manager";

  async function load() {
    setLoading(true);
    setErrors({});
    const { data, error } = await supabase.from("completed_matches")
      .select("id, division_id, week_num, week_date, team_home_id, team_away_id, team_home_name, team_away_name, team_home_points, team_away_points, is_makeup_pending, makeup_deadline_resolution, created_at")
      .eq("is_makeup_pending", true).order("created_at", { ascending: false });
    if (error) { setErrors({ load: error.message }); setLoading(false); return; }
    const rows = data ?? [];
    setMatches(rows);
    const rosterMap = {};
    await Promise.all(rows.map(async row => {
      const [home, away] = await Promise.all([
        row.team_home_id ? listRosterForTeam(row.team_home_id) : Promise.resolve([]),
        row.team_away_id ? listRosterForTeam(row.team_away_id) : Promise.resolve([]),
      ]);
      rosterMap[row.id] = { home, away };
    }));
    setRosters(rosterMap);
    const dates = {};
    const divisionIds = [...new Set(rows.map(r => r.division_id).filter(Boolean))];
    await Promise.all(divisionIds.map(async divisionId => {
      const { data: weeks } = await supabase.from("schedule_weeks").select("date,is_playoff").eq("division_id", divisionId);
      const regularDates = (weeks ?? []).filter(w => !w.is_playoff).map(w => parseDate(w.date)).filter(Boolean);
      if (regularDates.length) dates[divisionId] = new Date(Math.max(...regularDates.map(d => d.getTime())));
    }));
    setFinalDates(dates);
    setLoading(false);
  }
  useEffect(() => { if (canManage) load(); else setLoading(false); }, [canManage]);

  async function resolve(match, outcome, responsibleSide = null) {
    setBusyId(match.id);
    setErrors(prev => ({ ...prev, [match.id]: null }));
    try {
      const selection = selections[match.id] ?? { home: [], away: [] };
      const result = await resolveMakeupDeadline({
        matchId: match.id,
        outcome,
        responsibleSide,
        note: notes[match.id] ?? "",
        forfeitingPlayers: responsibleSide ? selection[responsibleSide] ?? [] : [],
        receivingPlayers: responsibleSide ? selection[responsibleSide === "home" ? "away" : "home"] ?? [] : [],
      });
      if (!result?.ok) throw new Error("The deadline resolution was not applied.");
      await load();
    } catch (error) {
      setErrors(prev => ({ ...prev, [match.id]: error.message ?? "The deadline resolution was not applied." }));
    } finally {
      setBusyId(null);
    }
  }

  const pending = useMemo(() => matches.map(match => {
    const finalDate = finalDates[match.division_id];
    const dateText = finalDate ? (finalDate.getMonth() + 1) + "/" + finalDate.getDate() + "/" + finalDate.getFullYear() : null;
    const cutoff = dateText ? makeupCutoffFromFinalRegularSeasonDate(dateText) : null;
    const deadlineReached = dateText ? isMakeupWithinProhibitedWindow(dateText) : false;
    return { ...match, finalDate, cutoff, deadlineReached };
  }), [matches, finalDates]);

  if (!profile) return null;
  if (!canManage) return (
    <>
      <PageHeader title="Makeup Deadline Review" backFallback="/league-office" />
      <div style={{ maxWidth: 860, margin: "0 auto", padding: 20 }}><div className="card"><strong>Access denied.</strong> League Management only.</div></div>
    </>
  );

  return (
    <>
      <PageHeader title="Makeup Deadline Review" subtitle="Rule 8.5" backFallback="/league-office" />
      <div style={{ maxWidth: 980, margin: "0 auto", padding: 20 }}>
        <div className="card" style={{ marginBottom: 16, borderColor: "#B45309" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <AlertCircle size={18} />
            <div style={{ fontSize: 13, lineHeight: 1.5 }}><strong>League Management decision only.</strong> The app calculates the seven-day cutoff, but it does not decide which team caused a missed deadline.</div>
          </div>
        </div>
        {loading ? <div className="card">Loading pending makeups…</div> : pending.length === 0 ? (
          <div className="card"><CheckCircle2 size={18} /> No pending makeups require a deadline resolution.</div>
        ) : pending.map(match => {
          const error = errors[match.id];
          const outcome = formatOutcome(match);
          const canResolve = match.deadlineReached && !outcome;
          const busy = busyId === match.id;
          return (
            <div key={match.id} className="card" style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", opacity: .7 }}>Week {match.week_num ?? "—"} · {formatDate(match.week_date)}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, marginTop: 4 }}>{match.team_home_name} vs. {match.team_away_name}</div>
                </div>
                <span className="role-tag role-tag--manager">Makeup Pending</span>
              </div>
              <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.5 }}>
                <div><strong>Last regular-season date:</strong> {match.finalDate ? formatDate(match.finalDate) : "Unavailable"}</div>
                <div><strong>7-day cutoff:</strong> {match.cutoff ? formatDate(match.cutoff) : "Unavailable"}</div>
              </div>
              {!outcome && match.deadlineReached && rosters[match.id] && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>If League Management determines a team caused the missed deadline, select the five players for the resulting full-match forfeit.</div>
                  {["home", "away"].map(side => {
                    const sideName = side === "home" ? match.team_home_name : match.team_away_name;
                    const sideRoster = rosters[match.id]?.[side] ?? [];
                    const selected = selections[match.id]?.[side] ?? [];
                    return (
                      <div key={side} style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 4 }}>{sideName} players</div>
                        {[0,1,2,3,4].map(index => (
                          <select key={index} className="input input--select" style={{ width: "100%", marginBottom: 5 }}
                            value={selected[index]?.num ?? ""}
                            onChange={ev => {
                              const player = sideRoster.find(p => String(p.num) === ev.target.value) ?? null;
                              setSelections(prev => ({
                                ...prev,
                                [match.id]: {
                                  ...(prev[match.id] ?? { home: [], away: [] }),
                                  [side]: Array.from({ length: 5 }, (_, i) => i === index ? player : (prev[match.id]?.[side]?.[i] ?? null)),
                                },
                              }));
                            }}>
                            <option value="">Select {sideName} player {index + 1}…</option>
                            {sideRoster.map(player => (
                              <option key={player.num} value={player.num}>{player.name}{player.nickname ? " \"" + player.nickname + "\"" : ""} ({player.rating ?? "NR"})</option>
                            ))}
                          </select>
                        ))}
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 11.5, color: "#8A8A8A", marginBottom: 8 }}>Players who already appeared in completed sets cannot be selected.</div>
                </div>
              )}
              {outcome ? (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "#102B20", border: "1px solid #276B4A" }}>
                  <strong>{outcome}</strong>
                  {match.makeup_deadline_resolution?.resolvedAt && <div style={{ fontSize: 11.5, marginTop: 4, opacity: .8 }}>Recorded {new Date(match.makeup_deadline_resolution.resolvedAt).toLocaleString()}</div>}
                </div>
              ) : (
                <>
                  {!match.finalDate && <div style={{ marginTop: 10, color: "#B45309", fontSize: 12 }}>The final regular-season date cannot be determined from the saved schedule. No resolution can be recorded.</div>}
                  {match.finalDate && !match.deadlineReached && <div style={{ marginTop: 10, color: "#B45309", fontSize: 12 }}>The seven-day deadline has not passed. No Rule 8.5 deadline resolution is available yet.</div>}
                  {canResolve && (
                    <div style={{ marginTop: 14 }}>
                      <textarea value={notes[match.id] ?? ""} onChange={e => setNotes(prev => ({ ...prev, [match.id]: e.target.value }))} placeholder="Optional League Management note" rows={2} style={{ width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="btn btn-secondary" disabled={busy} onClick={() => resolve(match, "no_agreement")}><Scale size={14} /> No agreement — neither gets points</button>
                        <button className="btn btn-secondary" disabled={busy} onClick={() => resolve(match, "team_responsible", "home")}>{match.team_home_name} responsible — {match.team_away_name} gets forfeit</button>
                        <button className="btn btn-secondary" disabled={busy} onClick={() => resolve(match, "team_responsible", "away")}>{match.team_away_name} responsible — {match.team_home_name} gets forfeit</button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {error && <div style={{ marginTop: 10, color: "#B91C1C", fontSize: 12 }}>{error}</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}
