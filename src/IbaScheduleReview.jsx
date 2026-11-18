import { useEffect, useState } from "react";
import { Check, X, AlertCircle, RefreshCw, Upload, Calendar } from "lucide-react";
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
function chicagoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export default function IbaScheduleReview() {
  const { profile } = useAuth();
  const [rows, setRows] = useState([]);
  const [tbaRows, setTbaRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tbaLoading, setTbaLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setLoading(true); setError("");
    const { data, error: e } = await supabase
      .from("iba_schedule_monitor_checks")
      .select("id,monitor_date,changes,summary,checked_at,review_status,review_note,seasons(type,year),divisions(num,name,format,day)")
      .in("review_status", ["pending", "approved"])
      .eq("status", "changes_found")
      .order("checked_at", { ascending: false });
    if (e) setError(e.message);
    setRows(data ?? []);
    setLoading(false);
  };

  const loadTba = async () => {
    setTbaLoading(true);
    const [{ data: divisions, error: divisionError }, { data: weeks, error: weekError }] = await Promise.all([
      supabase.from("divisions")
        .select("id,num,name,format,day,season_id,seasons(type,year,is_active)")
        .eq("seasons.is_active", true),
      supabase.from("schedule_weeks")
        .select("id,division_id,week_num,date,is_playoff,schedule_pairings(id,home_team_id,away_team_id,home_tbd_code,away_tbd_code)")
        .order("week_num"),
    ]);
    if (divisionError || weekError) {
      setError(divisionError?.message || weekError?.message || "Could not load post-Week-5 TBA entries.");
      setTbaRows([]);
      setTbaLoading(false);
      return;
    }

    const today = chicagoDate();
    const divisionById = new Map((divisions ?? []).map(d => [d.id, d]));
    const results = [];
    for (const week of weeks ?? []) {
      const division = divisionById.get(week.division_id);
      if (!division || week.is_playoff || !week.date || week.date >= today) continue;
      const pairings = week.schedule_pairings ?? [];
      for (const pairing of pairings) {
        const homeTba = pairing.home_team_id == null && String(pairing.home_tbd_code ?? "").trim() !== "";
        const awayTba = pairing.away_team_id == null && String(pairing.away_tbd_code ?? "").trim() !== "";
        if (homeTba || awayTba) {
          results.push({
            id: `${pairing.id}:${homeTba ? "home" : "away"}`,
            pairingId: pairing.id,
            weekId: week.id,
            weekNum: week.week_num,
            date: week.date,
            division,
            side: homeTba ? "home" : "away",
            tbdCode: homeTba ? pairing.home_tbd_code : pairing.away_tbd_code,
            opponentTeamId: homeTba ? pairing.away_team_id : pairing.home_team_id,
          });
        }
      }
    }
    setTbaRows(results.sort((a,b) => a.date.localeCompare(b.date) || a.weekNum - b.weekNum));
    setTbaLoading(false);
  };

  useEffect(() => {
    if (profile?.role === "manager") {
      load();
      loadTba();
    } else {
      setLoading(false);
      setTbaLoading(false);
    }
  }, [profile?.role]);

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

  const apply = async (row) => {
    const confirmed = window.confirm(
      `Apply the approved IBA schedule change for ${divisionLabel(row)}? This will replace that division's live schedule with the approved IBA snapshot. The current schedule is preserved in application history.`
    );
    if (!confirmed) return;
    setBusyId(row.id); setError("");
    const { data, error: e } = await supabase.rpc("apply_iba_schedule_change", { p_check_id: row.id });
    if (e) {
      setError(e.message);
    } else if (!data?.ok) {
      setError(data?.error || "The approved schedule change was not applied.");
    } else {
      await load();
      await loadTba();
    }
    setBusyId(null);
  };

  const convertTba = async (row) => {
    const confirmed = window.confirm(
      `Convert ${row.side.toUpperCase()} ${row.tbdCode} in ${divisionLabel({divisions: row.division})}, Week ${row.weekNum} to BYE? This is a manager-controlled post-Week-5 schedule change.`
    );
    if (!confirmed) return;
    setBusyId(row.id); setError("");
    const { data, error: e } = await supabase.rpc("convert_iba_tba_to_bye", {
      p_pairing_id: row.pairingId,
      p_side: row.side,
    });
    if (e) {
      setError(e.message);
    } else if (!data?.ok) {
      setError(data?.error || "The TBA participant was not converted to BYE.");
    } else {
      await loadTba();
    }
    setBusyId(null);
  };

  if (!profile) return null;
  if (profile.role !== "manager") return (
    <div className="app"><style>{shellCss}</style><PageHeader title="IBA Schedule Review" />
      <div className="tab-content"><AccessDenied /></div>
    </div>
  );

  const pendingCount = rows.filter(row => row.review_status === "pending").length;
  const approvedCount = rows.filter(row => row.review_status === "approved").length;

  return (
    <div className="app"><style>{shellCss}</style>
      <PageHeader title="IBA Schedule Review" subtitle="Manager review and controlled application of changes detected from IBA" />
      <div className="tab-content">
        {error && <div className="card" style={{borderColor:"#8B2E2E",color:"#F2B8B8",marginBottom:12}}>{error}</div>}

        <div className="card" style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <Calendar size={17}/>
            <div>
              <div className="card__title" style={{marginBottom:2}}>Post-Week-5 TBA → BYE</div>
              <div style={{color:"#AAA",fontSize:12,lineHeight:1.5}}>
                Unresolved TBA schedule participants remain untouched through Week 5. After the Week 5 date passes,
                a manager may explicitly convert an individual TBA participant to a schedule BYE.
              </div>
            </div>
          </div>
        </div>

        {tbaLoading ? <div className="empty-state">Loading unresolved post-Week-5 TBA entries…</div> :
          tbaRows.length === 0 ? (
            <div className="card" style={{marginBottom:12}}>
              <div className="card__title">No post-Week-5 TBA entries</div>
              <div style={{color:"#AAA",fontSize:12,lineHeight:1.5}}>
                There are no unresolved TBA participants in completed regular-season weeks after the Week 5 cutoff.
              </div>
            </div>
          ) : tbaRows.map(row => (
            <div className="card" key={row.id} style={{marginBottom:10}}>
              <div className="card__title">
                {row.division.seasons?.type} {row.division.seasons?.year} · Div {row.division.num} · {row.division.name}
              </div>
              <div style={{color:"#AAA",fontSize:11,marginTop:3}}>
                Week {row.weekNum} · {row.date} · {row.division.format} · {row.division.day}
              </div>
              <div style={{marginTop:10,fontSize:13}}>
                <strong>{row.side === "home" ? "Home" : "Away"}:</strong> {row.tbdCode}
                <span style={{color:"#AAA"}}> · unresolved TBA</span>
              </div>
              {row.opponentTeamId && <div style={{color:"#AAA",fontSize:11,marginTop:4}}>Opponent is already assigned.</div>}
              <button
                className="btn-primary"
                style={{marginTop:10}}
                disabled={busyId === row.id}
                onClick={() => convertTba(row)}
              >
                {busyId === row.id ? "Converting…" : "Convert to BYE"}
              </button>
            </div>
          ))}

        <div className="card" style={{marginTop:18,marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <AlertCircle size={17}/>
            <div>
              <div className="card__title" style={{marginBottom:2}}>
                {pendingCount ? `${pendingCount} awaiting review` : "No changes awaiting review"}
                {approvedCount ? ` · ${approvedCount} approved and ready to apply` : ""}
              </div>
              <div style={{color:"#AAA",fontSize:12}}>
                Approval alone does not modify the league schedule. Application is a separate manager action.
              </div>
            </div>
          </div>
        </div>

        {loading ? <div className="empty-state">Loading schedule changes…</div> :
          rows.length === 0 ? (
            <div className="card">
              <div className="card__title">No schedule changes awaiting action</div>
              <div style={{color:"#AAA",fontSize:12,lineHeight:1.5}}>
                The daily IBA monitor has not found any pending or approved changes. Current-season divisions
                beyond Week 5 are not monitored.
              </div>
              <button className="btn-secondary" style={{marginTop:10}} onClick={load}><RefreshCw size={14}/> Refresh</button>
            </div>
          ) : <>
            {rows.map(row => {
              const approved = row.review_status === "approved";
              return (
                <div className="card" key={row.id} style={{marginBottom:12}}>
                  <div className="card__title">{seasonLabel(row)} · {divisionLabel(row)}</div>
                  <div style={{color:"#AAA",fontSize:11,marginTop:3}}>
                    Monitor date {row.monitor_date} · Checked {new Date(row.checked_at).toLocaleString()}
                  </div>
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
                  {approved ? (
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginTop:12,paddingTop:10,borderTop:"1px solid #333"}}>
                      <div style={{color:"#8FD8B5",fontSize:12}}><Check size={14}/> Approved — ready to apply</div>
                      <button className="btn-primary" disabled={busyId===row.id} onClick={() => apply(row)}>
                        <Upload size={14}/> {busyId===row.id ? "Applying…" : "Apply to Schedule"}
                      </button>
                    </div>
                  ) : (
                    <div style={{display:"flex",gap:8,marginTop:12}}>
                      <button className="btn-primary" disabled={busyId===row.id} onClick={() => decide(row,"approved")}><Check size={14}/> Approve</button>
                      <button className="btn-secondary" disabled={busyId===row.id} onClick={() => decide(row,"rejected")}><X size={14}/> Reject</button>
                    </div>
                  )}
                  {row.review_note && (
                    <div style={{color:"#AAA",fontSize:11,marginTop:8}}>Review note: {row.review_note}</div>
                  )}
                </div>
              );
            })}
          </>
        }
      </div>
    </div>
  );
}
