import { useEffect, useState } from "react";
import { useAuth } from "./AuthContext";
import { PageHeader, AccessDenied, shellCss } from "./Shell";
import { css } from "./AdminApp";
import { supabase } from "./supabaseClient";
import * as db from "./db";
import { DROPOUT_REMEDIES, normalizeDropoutPreview, validateDropoutResolution } from "./dropoutResolution";

export default function DropoutResolutionReview() {
  const { profile } = useAuth();
  const [seasons, setSeasons] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [teams, setTeams] = useState([]);
  const [seasonId, setSeasonId] = useState("");
  const [divisionId, setDivisionId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [remedies, setRemedies] = useState([]);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(null);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (profile?.role !== "manager") return;
    (async () => {
      const { data } = await supabase.from("seasons").select("id,type,year,is_active").eq("is_active", true).order("year", { ascending: false });
      setSeasons(data ?? []);
    })();
  }, [profile?.role]);

  useEffect(() => {
    if (!seasonId) { setDivisions([]); return; }
    supabase.from("divisions").select("id,num,name,format,day").eq("season_id", seasonId).order("num")
      .then(({ data }) => setDivisions(data ?? []));
    setDivisionId(""); setTeamId(""); setPreview(null);
  }, [seasonId]);

  useEffect(() => {
    if (!divisionId) { setTeams([]); return; }
    supabase.from("teams").select("id,team_num,name,is_bye").eq("division_id", divisionId).eq("is_bye", false).order("team_num")
      .then(({ data }) => setTeams(data ?? []));
    setTeamId(""); setPreview(null);
  }, [divisionId]);

  async function loadHistory() {
    if (!divisionId) return;
    const { data, error } = await supabase.from("team_dropout_resolutions").select("*")
      .eq("division_id", divisionId).order("resolved_at", { ascending: false });
    if (!error) setHistory(data ?? []);
  }

  useEffect(() => { loadHistory(); }, [divisionId]);

  async function getPreview() {
    setMessage("");
    setPreview(null);
    if (!seasonId || !divisionId || !teamId || !effectiveDate) {
      setMessage("Select the season, division, dropout team, and effective date first.");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("preview_team_dropout_resolution", {
      p_season_id: seasonId, p_division_id: divisionId, p_dropout_team_id: teamId,
      p_effective_date: effectiveDate,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setPreview(normalizeDropoutPreview(data));
  }

  async function applyResolution() {
    const errorText = validateDropoutResolution({ seasonId, divisionId, teamId, effectiveDate, remedies, note });
    if (errorText) { setMessage(errorText); return; }
    if (!preview) { setMessage("Preview the affected matches and schedule before applying the resolution."); return; }
    if (!window.confirm("Record this dropout resolution? Original completed match history will remain unchanged.")) return;
    setBusy(true); setMessage("");
    const { data, error } = await supabase.rpc("record_team_dropout_resolution", {
      p_season_id: seasonId, p_division_id: divisionId, p_dropout_team_id: teamId,
      p_effective_date: effectiveDate, p_remedies: remedies,
      p_affected_match_ids: preview.affectedMatchIds,
      p_affected_schedule_week_ids: preview.affectedScheduleWeekIds,
      p_preview: preview, p_note: note,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage(`Dropout resolution recorded: ${data?.resolutionId ?? "saved"}.`);
    setPreview(null); setRemedies([]); setNote(""); await loadHistory();
  }

  if (profile?.role !== "manager") return <AccessDenied />;
  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style>
      <PageHeader title="Team Dropout Resolution" subtitle="Rule 8.7 — record management's chosen remedy without rewriting match history" backFallback="/league-office" />
      <div className="tab-content">
        <div className="card">
          <div className="section-header"><div className="section-header__title">Record team dropout</div></div>
          <div style={{fontSize:11.5,color:"#9A9A9A",lineHeight:1.45}}>Preview the affected history first. Completed matches remain unchanged; this workflow records the League Management decision.</div>
          <div className="field"><span className="form-label">Season</span><select className="input input--select" value={seasonId} onChange={e => setSeasonId(e.target.value)}><option value="">Select…</option>{seasons.map(s => <option key={s.id} value={s.id}>{s.type} · {s.year}</option>)}</select></div>
          <div className="field"><span className="form-label">Division</span><select className="input input--select" value={divisionId} onChange={e => setDivisionId(e.target.value)} disabled={!seasonId}><option value="">Select…</option>{divisions.map(d => <option key={d.id} value={d.id}>{d.num} · {d.name} · {d.format} · {d.day}</option>)}</select></div>
          <div className="field"><span className="form-label">Dropout team</span><select className="input input--select" value={teamId} onChange={e => setTeamId(e.target.value)} disabled={!divisionId}><option value="">Select…</option>{teams.map(t => <option key={t.id} value={t.id}>{t.team_num} · {t.name}</option>)}</select></div>
          <div className="field"><span className="form-label">Effective dropout date</span><input className="input" type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} /></div>
          <button className="btn-primary" onClick={getPreview} disabled={busy}>Preview affected records</button>
        </div>
        {preview && <div className="card">
          <div className="card__title">Impact preview</div>
          <div style={{fontSize:12.5,lineHeight:1.5}}>
            <div>{preview.teamName}: {preview.completedMatchCount} completed match record(s), {preview.futureScheduleWeekCount} future schedule week(s).</div>
            <div style={{marginTop:6}}>Completed match history is preserved. The selected remedies are recorded as the management decision; later work will apply their standings/schedule effects.</div>
          </div>
        </div>}
        <div className="card">
          <div className="card__title">Management remedy</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {DROPOUT_REMEDIES.map(r => <label key={r.value} style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:12.5,color:"#E0E0E0"}}><input type="checkbox" checked={remedies.includes(r.value)} onChange={e => setRemedies(v => e.target.checked ? [...v,r.value] : v.filter(x => x !== r.value))} /> <span>{r.label}</span></label>)}
          </div>
          <div className="field"><span className="form-label">Management note</span><textarea className="input" rows="4" value={note} onChange={e => setNote(e.target.value)} /></div>
          <button className="btn-primary" onClick={applyResolution} disabled={busy || !preview}>Record dropout resolution</button>
          {message && <div className={message.includes("recorded") ? "success-msg" : "error-msg"}>{message}</div>}
        </div>
        <div className="card">
          <div className="card__title">Resolution history</div>
          {!history.length ? <div className="empty-state">No dropout resolutions recorded for this division.</div> : history.map(h => <div key={h.id} style={{borderTop:"1px solid #2A2A2A",padding:"12px 0",fontSize:12}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:8}}><strong>{h.dropout_team_id}</strong><span className="role-pill role-pill--sm">{h.status}</span></div>
            <div style={{color:"#9A9A9A",marginTop:4}}>{h.effective_date}</div>
            <div style={{marginTop:4}}>{(h.remedies ?? []).join(", ")}</div>
            {h.note && <div style={{marginTop:4,color:"#9A9A9A"}}>{h.note}</div>}
          </div>)}
        </div>
      </div>
    </div>
  );
}
