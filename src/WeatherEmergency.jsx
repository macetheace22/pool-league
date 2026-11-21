import { useEffect, useMemo, useState } from "react";
import { CloudRain } from "lucide-react";
import { useAuth } from "./AuthContext";
import { PageHeader, shellCss, AccessDenied } from "./Shell";
import { css } from "./AdminApp";
import * as db from "./db";

function seasonLabel(season) {
  if (!season) return "";
  return `${season.type ?? ""} ${season.year ?? ""}`.trim();
}

export default function WeatherEmergency() {
  const { profile } = useAuth();
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const activeSeasons = useMemo(() => (seasons ?? []).filter(s => s.is_active), [seasons]);

  useEffect(() => {
    let cancelled = false;
    db.listSeasons().then(rows => {
      if (cancelled) return;
      const active = (rows ?? []).filter(s => s.is_active);
      setSeasons(rows ?? []);
      if (active.length === 1) setSeasonId(active[0].id);
      setLoading(false);
    }).catch(e => {
      if (!cancelled) { setError(e?.message ?? "Unable to load the active season."); setLoading(false); }
    });
    return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style>
      <PageHeader title="Weather Emergency" subtitle="Rule 8.6 — League Management declaration" backFallback="/league-office" />
      <div className="tab-content">
        {loading ? <div className="empty-state">Loading weather emergencies…</div> : (
          <>
            <div className="card">
              <div className="section-header"><div className="section-header__title">Declare weather emergency</div></div>
              <div style={{fontSize:11.5,color:"#9A9A9A",lineHeight:1.45}}>Use this only when League Management determines that an official weather emergency applies. All scheduled regular-season team matches on the selected date become makeup-pending.</div>
              <div className="field"><span className="form-label">Active season</span><select className="input input--select" value={seasonId} onChange={e => setSeasonId(e.target.value)} disabled={saving}><option value="">Select season…</option>{activeSeasons.map(s => <option key={s.id} value={s.id}>{seasonLabel(s)}</option>)}</select></div>
              <div className="field"><span className="form-label">Scheduled match date</span><input className="input" type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} disabled={saving} /></div>
              <div className="field"><span className="form-label">League Office note (optional)</span><textarea className="input" value={note} onChange={e => setNote(e.target.value)} disabled={saving} rows={3} placeholder="Optional reason or weather-service reference" /></div>
              {error && <div className="error-msg">{error}</div>}
              {message && <div className="success-msg">{message}</div>}
              <button className="btn-primary" onClick={declare} disabled={saving}>{saving ? "Recording…" : "Declare Weather Emergency"}</button>
            </div>
            <div className="card">
              <div className="card__title">Recorded weather emergencies</div>
              {history.length === 0 ? <div className="empty-state">No weather emergencies have been recorded for this season.</div> : (
                <div>
                  {history.map(row => <div key={row.id} style={{padding:"12px 0",borderTop:"1px solid #2A2A2A",fontSize:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",gap:8}}><strong>{row.scheduled_date}</strong><span className="role-pill role-pill--sm">Declared</span></div>
                    <div style={{color:"#9A9A9A",marginTop:4}}>Declared {row.declared_at ? new Date(row.declared_at).toLocaleString() : "—"}</div>
                    {row.note && <div style={{marginTop:4}}>{row.note}</div>}
                  </div>)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
