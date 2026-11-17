import { useEffect, useState } from "react";
import { Check, X, AlertCircle, RefreshCw } from "lucide-react";
import { supabase } from "./supabaseClient";
import { PageHeader, AccessDenied, shellCss } from "./Shell";
import { useAuth } from "./AuthContext";

const summaryText = (s = {}) => {
  const parts = [];
  if (s.added) parts.push(`${s.added} added`);
  if (s.removed) parts.push(`${s.removed} removed`);
  if (s.changed) parts.push(`${s.changed} matchup changes`);
  if (s.dateChanges) parts.push(`${s.dateChanges} date changes`);
  if (s.tbaResolutions) parts.push(`${s.tbaResolutions} TBA resolutions`);
  return parts.length ? parts.join(", ") : "IBA reported a schedule change.";
};

function seasonLabel(row) {
  const s = row?.seasons;
  return s ? [s.type, s.year].filter(Boolean).join(" ") : "Unknown season";
}
function divisionLabel(row) {
  const d = row?.divisions;
  return d ? [`Div ${d.num}`, d.name, d.format, d.day].filter(Boolean).join(" · ") : "Unknown division";
}

export default function IbaScheduleReview() {
  const { profile } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setLoading(true); setError("");
    const { data, error: e } = await supabase
      .from("iba_schedule_monitor_checks")
      .select("id,monitor_date,changes,summary,checked_at,review_status,seasons(type,year),divisions(num,name,format,day)")
      .eq("review_status", "pending")
      .eq("status", "changes_found")
      .order("checked_at", { ascending: false });
    if (e) setError(e.message);
    setRows(data ?? []);
    setLoading(false);
  };

  useEffect(() => { if (profile?.role === "manager") load(); else setLoading(false); }, [profile?.role]);

  const decide = async (row, decision) => {
    const note = window.prompt(decision === "approved"
      ? "Optional note for this approved change:"
      : "Optional note for this rejected change:");
    if (note === null) return;
    setBusyId(row.id); setError("");
    const { error: e } = await supabase
      .from("iba_schedule_monitor_checks")
      .update({
        review_status: decision,
        reviewed_by: profile.id,
        reviewed_at: new Date().toISOString(),
        review_note: note.trim() || null,
      })
      .eq("id", row.id)
      .eq("review_status", "pending");
    if (e) setError(e.message);
    else await load();
    setBusyId(null);
  };

  if (!profile) return null;
  if (profile.role !== "manager") return (
    <div className="app"><style>{shellCss}</style><PageHeader title="IBA Schedule Review" />
      <div className="tab-content"><AccessDenied /></div>
    </div>
  );

  return (
    <div className="app"><style>{shellCss}</style>
      <PageHeader title="IBA Schedule Review" subtitle="Manager review of changes detected from IBA" />
      <div className="tab-content">
        {error && <div className="card" style={{borderColor:"#8B2E2E",color:"#F2B8B8"}}>{error}</div>}
        {loading ? <div className="empty-state">Loading schedule changes…</div> :
          rows.length === 0 ? (
            <div className="card">
              <div className="card__title">No schedule changes awaiting review</div>
              <div style={{color:"#AAA",fontSize:12,lineHeight:1.5}}>
                The daily IBA monitor has not found any unreviewed changes. Current-season divisions
                beyond Week 5 are not monitored.
              </div>
              <button className="btn-secondary" style={{marginTop:10}} onClick={load}><RefreshCw size={14}/> Refresh</button>
            </div>
          ) : <>
            <div className="card" style={{marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <AlertCircle size={17}/>
                <div><div className="card__title" style={{marginBottom:2}}>{rows.length} change{rows.length===1?"":"s"} awaiting review</div>
                <div style={{color:"#AAA",fontSize:12}}>Approval does not modify the league schedule yet.</div></div>
              </div>
            </div>
            {rows.map(row => (
              <div className="card" key={row.id} style={{marginBottom:12}}>
                <div className="card__title">{seasonLabel(row)} · {divisionLabel(row)}</div>
                <div style={{color:"#AAA",fontSize:11,marginTop:3}}>Monitor date {row.monitor_date} · Checked {new Date(row.checked_at).toLocaleString()}</div>
                <div style={{marginTop:10,fontSize:13}}><strong>Detected:</strong> {summaryText(row.summary)}</div>
                {(row.changes ?? []).map((change,i) => (
                  <div key={i} style={{padding:"8px 0",borderTop:i ? "1px solid #333" : "none"}}>
                    <div style={{fontWeight:600}}>{change.type ?? change.kind ?? "Schedule change"}</div>
                    <div style={{color:"#AAA",fontSize:11,marginTop:2}}>
                      {Object.entries(change).filter(([k]) => !["type","kind"].includes(k))
                        .map(([k,v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}
                    </div>
                  </div>
                ))}
                <div style={{display:"flex",gap:8,marginTop:12}}>
                  <button className="btn-primary" disabled={busyId===row.id} onClick={() => decide(row,"approved")}><Check size={14}/> Approve</button>
                  <button className="btn-secondary" disabled={busyId===row.id} onClick={() => decide(row,"rejected")}><X size={14}/> Reject</button>
                </div>
              </div>
            ))}
          </>
        }
      </div>
    </div>
  );
}
