import { useEffect, useState } from "react";
import { useAuth } from "./AuthContext";
import { PageHeader, AccessDenied, shellCss } from "./Shell";
import { supabase } from "./supabaseClient";
import * as db from "./db";
import { normalizeReplacementPreview, validateReplacementResolution } from "./replacementResolution";

export default function ReplacementTeamResolution() {
  const { profile } = useAuth();
  const [seasons, setSeasons] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [dropoutResolutions, setDropoutResolutions] = useState([]);
  const [teams, setTeams] = useState([]);
  const [seasonId, setSeasonId] = useState("");
  const [divisionId, setDivisionId] = useState("");
  const [dropoutResolutionId, setDropoutResolutionId] = useState("");
  const [replacementTeamId, setReplacementTeamId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [preview, setPreview] = useState(null);
  const [inheritedStandings, setInheritedStandings] = useState(null);
  const [note, setNote] = useState("");
  const [history, setHistory] = useState([]);
  const [makeupMatches, setMakeupMatches] = useState([]);
  const [scheduleApplications, setScheduleApplications] = useState([]);
  const [makeupDates, setMakeupDates] = useState({});
  const [schedulingMakeupId, setSchedulingMakeupId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [recordedResolutionId, setRecordedResolutionId] = useState("");
  const [applyingSchedule, setApplyingSchedule] = useState(false);

  useEffect(() => {
    if (profile?.role !== "manager") return;
    supabase.from("seasons")
      .select("id,type,year,is_active")
      .eq("is_active", true)
      .order("year", { ascending: false })
      .then(({ data }) => setSeasons(data ?? []));
  }, [profile?.role]);

  useEffect(() => {
    setDivisions([]); setDropoutResolutions([]); setTeams([]);
    setDivisionId(""); setDropoutResolutionId(""); setReplacementTeamId("");
    setPreview(null); setInheritedStandings(null);
    if (!seasonId) return;
    supabase.from("divisions")
      .select("id,num,name,format,day")
      .eq("season_id", seasonId)
      .order("num")
      .then(({ data }) => setDivisions(data ?? []));
  }, [seasonId]);

  useEffect(() => {
    setDropoutResolutions([]); setTeams([]); setDropoutResolutionId(""); setReplacementTeamId("");
    setPreview(null); setInheritedStandings(null);
    if (!divisionId) return;
    Promise.all([
      supabase.from("team_dropout_resolutions")
        .select("id,dropout_team_id,effective_date,remedies,status")
        .eq("division_id", divisionId)
        .eq("status", "applied")
        .order("resolved_at", { ascending: false }),
      supabase.from("teams")
        .select("id,team_num,name,is_bye")
        .eq("division_id", divisionId)
        .eq("is_bye", false)
        .order("team_num"),
    ]).then(([dropouts, teamRows]) => {
      setDropoutResolutions(dropouts.data ?? []);
      setTeams(teamRows.data ?? []);
    });
  }, [divisionId]);

  async function loadHistory() {
    if (!divisionId) {
      setHistory([]);
      setMakeupMatches([]);
      setScheduleApplications([]);
      return;
    }
    const { data: resolutions, error: resolutionError } = await supabase.from("team_replacement_resolutions")
      .select("*").eq("division_id", divisionId).order("resolved_at", { ascending: false });
    if (resolutionError) { setMessage(resolutionError.message); return; }
    const rows = resolutions ?? [];
    setHistory(rows);
    if (rows.length) {
      const { data: allMakeups, error } = await supabase.from("team_replacement_makeup_matches")
        .select("*")
        .in("replacement_resolution_id", rows.map(row => row.id));
      if (error) { setMessage(error.message); return; }
      setMakeupMatches(allMakeups ?? []);
      const { data: applications, error: applicationError } = await supabase.from("team_replacement_schedule_applications")
        .select("id,replacement_resolution_id,status")
        .in("replacement_resolution_id", rows.map(row => row.id));
      if (applicationError) { setMessage(applicationError.message); return; }
      setScheduleApplications(applications ?? []);
    } else {
      setMakeupMatches([]);
      setScheduleApplications([]);
    }
  }

  async function scheduleMakeup(resolution, slot) {
    const key = resolution.id + ":" + slot.sourceByeWeekId;
    const scheduledDate = makeupDates[key];
    if (!scheduledDate) { setMessage("Choose a date for this replacement-team makeup."); return; }
    if (!window.confirm(`Schedule the makeup against ${slot.opponentName} on ${scheduledDate}?`)) return;
    setSchedulingMakeupId(key);
    setMessage("");
    const { data, error } = await supabase.rpc("schedule_team_replacement_makeup", {
      p_replacement_resolution_id: resolution.id,
      p_source_bye_week_id: slot.sourceByeWeekId,
      p_scheduled_date: scheduledDate,
    });
    setSchedulingMakeupId("");
    if (error) { setMessage(error.message); return; }
    setMessage(data?.status === "already_scheduled" ? "That eligible makeup was already scheduled." : "Replacement-team makeup scheduled.");
    await loadHistory();
  }

  useEffect(() => { loadHistory(); }, [divisionId]);

  async function getPreview() {
    setMessage(""); setPreview(null); setInheritedStandings(null);
    if (!dropoutResolutionId || !replacementTeamId || !effectiveDate) {
      setMessage("Select the dropout resolution, replacement team, and effective date first.");
      return;
    }
    setBusy(true);
    const [{ data, error }, officialRows] = await Promise.all([
      supabase.rpc("preview_team_replacement_resolution", {
        p_season_id: seasonId,
        p_division_id: divisionId,
        p_dropout_resolution_id: dropoutResolutionId,
        p_replacement_team_id: replacementTeamId,
        p_effective_date: effectiveDate,
      }),
      db.listStandingsAdjustments(divisionId),
    ]);
    setBusy(false);
    if (error) { setMessage(error.message); return; }

    const normalized = normalizeReplacementPreview(data);
    const officialStandings = db.computeOfficialStandings(officialRows);
    const dropoutStandings = officialStandings.find(row => row.teamId === normalized.dropoutTeamId);
    const snapshot = dropoutStandings ? {
      totalPoints: dropoutStandings.totalPoints ?? 0,
      wins: dropoutStandings.wins ?? 0,
      losses: dropoutStandings.losses ?? 0,
      setsFor: dropoutStandings.setsFor ?? 0,
      setsAgainst: dropoutStandings.setsAgainst ?? 0,
      setsPlayed: dropoutStandings.setsPlayed ?? 0,
      pointsPerSet: dropoutStandings.setsPlayed
        ? Number(((dropoutStandings.totalPoints ?? 0) / dropoutStandings.setsPlayed).toFixed(2))
        : 0,
      position: dropoutStandings.position ?? null,
      weekKey: dropoutStandings.weekKey ?? null,
      reportLabel: dropoutStandings.reportLabel ?? null,
      source: dropoutStandings.source ?? "official_iba",
      capturedAt: new Date().toISOString(),
    } : null;

    if (!snapshot) {
      setMessage("No imported official IBA team-standings snapshot exists for the dropout team in this division. Import the applicable standings report before recording the replacement.");
      return;
    }

    setPreview(normalized);
    setInheritedStandings(snapshot);
  }

  async function recordResolution() {
    const errorText = validateReplacementResolution({
      dropoutResolutionId, seasonId, divisionId, replacementTeamId,
      effectiveDate, preview, inheritedStandings,
    });
    if (errorText) { setMessage(errorText); return; }
    if (!window.confirm("Record this replacement team resolution? Original dropout match history will remain unchanged.")) return;
    setBusy(true); setMessage("");
    const { data, error } = await supabase.rpc("record_team_replacement_resolution", {
      p_dropout_resolution_id: dropoutResolutionId,
      p_season_id: seasonId,
      p_division_id: divisionId,
      p_dropout_team_id: preview.dropoutTeamId,
      p_replacement_team_id: replacementTeamId,
      p_effective_date: effectiveDate,
      p_inherited_standings: inheritedStandings,
      p_eligible_makeup_week_ids: preview.eligibleMakeupWeekIds.slice(0, 3),
      p_note: note,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage(`Replacement resolution recorded: ${data?.replacementResolutionId ?? "saved"}.`);
    setPreview(null); setInheritedStandings(null); setNote(""); setDropoutResolutionId(""); setReplacementTeamId("");
    await loadHistory();
  }

  if (profile?.role !== "manager") return <AccessDenied />;

  return (
    <div className="app"><style>{shellCss}</style>
      <PageHeader title="Replacement Team Resolution" subtitle="Rule 8.8 — record replacement-team points and makeup entitlement" />
      <div className="admin-card">
        <div className="form-grid">
          <label>Season<select value={seasonId} onChange={e => setSeasonId(e.target.value)}><option value="">Select…</option>{seasons.map(s => <option key={s.id} value={s.id}>{s.type} · {s.year}</option>)}</select></label>
          <label>Division<select value={divisionId} onChange={e => setDivisionId(e.target.value)} disabled={!seasonId}><option value="">Select…</option>{divisions.map(d => <option key={d.id} value={d.id}>{d.num} · {d.name} · {d.format} · {d.day}</option>)}</select></label>
          <label>Dropout resolution<select value={dropoutResolutionId} onChange={e => setDropoutResolutionId(e.target.value)} disabled={!divisionId}><option value="">Select…</option>{dropoutResolutions.map(r => <option key={r.id} value={r.id}>{r.dropout_team_id} · effective {r.effective_date}</option>)}</select></label>
          <label>Replacement team<select value={replacementTeamId} onChange={e => setReplacementTeamId(e.target.value)} disabled={!divisionId}><option value="">Select…</option>{teams.filter(t => t.id !== dropoutResolutions.find(r => r.id === dropoutResolutionId)?.dropout_team_id).map(t => <option key={t.id} value={t.id}>{t.team_num} · {t.name}</option>)}</select></label>
          <label>Effective replacement date<input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} /></label>
        </div>
        <button className="btn btn-primary" onClick={getPreview} disabled={busy}>Preview replacement impact</button>
        {preview && <div className="admin-card" style={{ marginTop: 16 }}>
          <strong>Replacement impact</strong>
          <p>{preview.dropoutTeamName} → {preview.replacementTeamName}</p>
          <p>Eligible post-dropout bye weeks: {preview.eligibleMakeupWeekCount} (maximum three).</p>
          <p>Inherited official IBA snapshot: {inheritedStandings?.totalPoints ?? 0} points; report {inheritedStandings?.reportLabel || inheritedStandings?.weekKey || "unknown week"}.</p>
          <p>Original completed match history remains unchanged. This records the manager's replacement decision and entitlement; future makeup scheduling remains part of the existing makeup workflow.</p>
        </div>}
        <label style={{ display:"block", marginTop:16 }}>Management note<textarea rows="4" value={note} onChange={e => setNote(e.target.value)} /></label>
        <button className="btn btn-success" onClick={recordResolution} disabled={busy || !preview}>Record replacement resolution</button>
        {recordedResolutionId && (
          <button
            className="btn btn-primary"
            style={{ marginLeft: 8 }}
            disabled={applyingSchedule}
            onClick={async () => {
              if (!window.confirm("Apply this replacement team to future scheduled matchups? Existing completed matches and BYE weeks will remain unchanged.")) return;
              setApplyingSchedule(true);
              setMessage("");
              const { data, error } = await supabase.rpc("apply_team_replacement_schedule", {
                p_replacement_resolution_id: recordedResolutionId,
              });
              setApplyingSchedule(false);
              if (error) {
                setMessage(error.message);
                return;
              }
              setMessage(
                data?.status === "already_applied"
                  ? "Replacement schedule was already applied."
                  : `Replacement schedule applied: ${data?.changedMatchupCount ?? 0} future matchup(s) updated.`,
              );
              setRecordedResolutionId("");
              await loadHistory();
            }}
          >
            {applyingSchedule ? "Applying…" : "Apply replacement to future schedule"}
          </button>
        )}
        {message && <p style={{ marginTop:12 }}>{message}</p>}
      </div>
      <div className="admin-card" style={{ marginTop:16 }}>
        <h3>Replacement resolution history</h3>
        {!history.length ? <p>No replacement resolutions recorded for this division.</p> : history.map(h => <div key={h.id} style={{ borderTop:"1px solid #444", padding:"12px 0" }}>
          <strong>{h.replacement_team_id}</strong> — {h.effective_date} — {h.status}
          <div>Inherited points: {h.inherited_standings?.totalPoints ?? 0}; makeup entitlement: {h.makeup_matches_used ?? 0}/{h.makeup_matches_allowed ?? 0} used</div>
          {h.note && <div>{h.note}</div>}
          {!scheduleApplications.some(row => row.replacement_resolution_id === h.id && row.status === "applied") && (
            <button className="btn btn-primary" style={{ marginTop:8 }} disabled={applyingSchedule}
              onClick={async () => {
                if (!window.confirm("Apply this replacement team to future scheduled matchups? Existing completed matches and BYE weeks will remain unchanged.")) return;
                setApplyingSchedule(true);
                setMessage("");
                const { data, error } = await supabase.rpc("apply_team_replacement_schedule", { p_replacement_resolution_id: h.id });
                setApplyingSchedule(false);
                if (error) { setMessage(error.message); return; }
                setMessage(data?.status === "already_applied" ? "Replacement schedule was already applied." : "Replacement schedule applied.");
                await loadHistory();
              }}>Apply replacement to future schedule</button>
          )}
          {(h.eligible_makeup_weeks ?? []).map(slot => {
            const key = h.id + ":" + slot.sourceByeWeekId;
            const existing = makeupMatches.find(row => row.replacement_resolution_id === h.id && row.source_bye_week_id === slot.sourceByeWeekId && row.status !== "voided");
            return <div key={key} style={{ marginTop:10, padding:10, border:"1px solid #555", borderRadius:8 }}>
              <strong>Bye from Week {slot.sourceWeekNum ?? "—"} · {slot.sourceWeekDate ?? ""}</strong>
              <div>Opponent: {slot.opponentName ?? "Unknown team"}</div>
              {existing ? (
                <div style={{ marginTop:6 }}>Scheduled {existing.scheduled_date} · {existing.status}</div>
              ) : (
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"end", marginTop:8 }}>
                  <label>Makeup date<input type="date" value={makeupDates[key] ?? ""} onChange={event => setMakeupDates(prev => ({ ...prev, [key]: event.target.value }))} /></label>
                  <button className="btn btn-primary" disabled={!!schedulingMakeupId || (h.makeup_matches_used ?? 0) >= (h.makeup_matches_allowed ?? 0)} onClick={() => scheduleMakeup(h, slot)}>
                    {schedulingMakeupId === key ? "Scheduling…" : "Schedule makeup"}
                  </button>
                </div>
              )}
            </div>;
          })}
        </div>)}
      </div>
    </div>
  );
}
