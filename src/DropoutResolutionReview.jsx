import { useEffect, useState } from "react";
import { useAuth } from "./AuthContext";
import { PageHeader, AccessDenied, shellCss } from "./Shell";
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
    <div className="app"><style>{shellCss}</style>
      <PageHeader title="Team Dropout Resolution" subtitle="Rule 8.7 — record management's chosen remedy without rewriting match history" />
      <div className="admin-card">
        <div className="form-grid">
          <label>Season<select value={seasonId} onChange={e => setSeasonId(e.target.value)}><option value="">Select…</option>{seasons.map(s => <option key={s.id} value={s.id}>{s.type} · {s.year}</option>)}</select></label>
          <label>Division<select value={divisionId} onChange={e => setDivisionId(e.target.value)} disabled={!seasonId}><option value="">Select…</option>{divisions.map(d => <option key={d.id} value={d.id}>{d.num} · {d.name} · {d.format} · {d.day}</option>)}</select></label>
          <label>Dropout team<select value={teamId} onChange={e => setTeamId(e.target.value)} disabled={!divisionId}><option value="">Select…</option>{teams.map(t => <option key={t.id} value={t.id}>{t.team_num} · {t.name}</option>)}</select></label>
          <label>Effective dropout date<input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} /></label>
        </div>
        <button className="btn btn-primary" onClick={getPreview} disabled={busy}>Preview affected records</button>
        {preview && <div className="admin-card" style={{ marginTop: 16 }}>
          <strong>Impact preview</strong>
          <p>{preview.teamName}: {preview.completedMatchCount} completed match record(s), {preview.futureScheduleWeekCount} future schedule week(s).</p>
          <p>Completed match history is preserved. The selected remedies are recorded as the management decision; later work will apply their standings/schedule effects.</p>
        </div>}
        <fieldset style={{ marginTop: 16 }}>
          <legend>Management remedy</legend>
          {DROPOUT_REMEDIES.map(r => <label key={r.value} style={{ display:"block", margin:"8px 0" }}><input type="checkbox" checked={remedies.includes(r.value)} onChange={e => setRemedies(v => e.target.checked ? [...v,r.value] : v.filter(x => x !== r.value))} /> {r.label}</label>)}
        </fieldset>
        <label style={{ display:"block", marginTop:16 }}>Management note<textarea rows="4" value={note} onChange={e => setNote(e.target.value)} /></label>
        <button className="btn btn-success" onClick={applyResolution} disabled={busy || !preview}>Record dropout resolution</button>
        {message && <p style={{ marginTop:12 }}>{message}</p>}
      </div>
      <div className="admin-card" style={{ marginTop:16 }}>
        <h3>Resolution history</h3>
        {!history.length ? <p>No dropout resolutions recorded for this division.</p> : history.map(h => <div key={h.id} style={{ borderTop:"1px solid #444", padding:"12px 0" }}><strong>{h.dropout_team_id}</strong> — {h.effective_date} — {h.status}<div>{(h.remedies ?? []).join(", ")}</div>{h.note && <div>{h.note}</div>}</div>)}
      </div>
    </div>
  );
}
