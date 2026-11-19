import { useEffect, useMemo, useState } from "react";
import { CloudRain } from "lucide-react";
import { useAuth } from "./AuthContext";
import { PageHeader, TabBar, shellCss, AccessDenied } from "./Shell";
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
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!seasonId) { setHistory([]); return; }
    db.listWeatherEmergencies(seasonId).then(setHistory).catch(e => setError(e?.message ?? "Unable to load weather declarations."));
  }, [seasonId]);

  const declare = async () => {
    setError("");
    setMessage("");
    if (!seasonId || !scheduledDate) {
      setError("Select the active season and scheduled match date.");
      return;
    }
    const [year, month, day] = scheduledDate.split("-");
    const usDate = `${Number(month)}/${Number(day)}/${year}`;
    if (history.some(row => row.scheduled_date === usDate)) {
      setError("A weather emergency has already been declared for that scheduled date.");
      return;
    }
    if (!window.confirm(`Declare a league-wide weather emergency for ${usDate}? Every scheduled regular-season team match on that date will be marked for makeup.`)) return;

    setSaving(true);
    try {
      const result = await db.declareWeatherEmergency(seasonId, usDate, note);
      setMessage(`Weather emergency recorded. ${result.created_makeups ?? 0} match${result.created_makeups === 1 ? "" : "es"} marked for makeup.`);
      setNote("");
      setScheduledDate("");
      setHistory(await db.listWeatherEmergencies(seasonId));
    } catch (e) {
      setError(e?.message ?? "The weather emergency could not be recorded.");
    } finally {
      setSaving(false);
    }
  };

  if (!profile) return null;
  if (profile.role !== "manager") return <AccessDenied />;

  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style>
      <PageHeader title="Weather Emergency" />
      <div className="tab-content">
        {loading ? <div>Loading…</div> : (
          <>
            <div className="admin-card" style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <CloudRain size={20} />
                <strong>Declare a league-wide weather emergency</strong>
              </div>
              <p style={{ marginTop: 0 }}>
                Use this only when the League Office determines that an official weather emergency applies.
                All scheduled regular-season team matches on the selected date will become makeup-pending.
              </p>
              <label>Active season</label>
              <select value={seasonId} onChange={e => setSeasonId(e.target.value)} disabled={saving}>
                <option value="">Select season…</option>
                {activeSeasons.map(s => <option key={s.id} value={s.id}>{seasonLabel(s)}</option>)}
              </select>
              <label style={{ marginTop: 12 }}>Scheduled match date</label>
              <input type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} disabled={saving} />
              <label style={{ marginTop: 12 }}>League Office note (optional)</label>
              <textarea value={note} onChange={e => setNote(e.target.value)} disabled={saving} rows={3} placeholder="Optional reason or weather-service reference" />
              {error && <div style={{ marginTop: 12, color: "#9B1C1C" }}>{error}</div>}
              {message && <div style={{ marginTop: 12, color: "#126B46" }}>{message}</div>}
              <button className="btn-primary" style={{ marginTop: 14 }} onClick={declare} disabled={saving}>
                {saving ? "Recording…" : "Declare Weather Emergency"}
              </button>
            </div>
            <div className="admin-card">
              <strong>Recorded weather emergencies</strong>
              {history.length === 0 ? <p>No weather emergencies have been recorded for this season.</p> : (
                <div style={{ marginTop: 10 }}>
                  {history.map(row => (
                    <div key={row.id} style={{ padding: "10px 0", borderTop: "1px solid #ddd" }}>
                      <strong>{row.scheduled_date}</strong>
                      <div>Declared {row.declared_at ? new Date(row.declared_at).toLocaleString() : "—"}</div>
                      {row.note && <div>{row.note}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <TabBar />
    </div>
  );
}
