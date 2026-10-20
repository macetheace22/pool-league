import { useEffect, useState } from "react";

const schedulePanelStateBySeason = new Map();

export function clearIbaSchedulePanelState() {
  schedulePanelStateBySeason.clear();
}
import { useNavigate } from "react-router-dom";
import { Check, Calendar, RefreshCw, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import * as db from "./db";

async function postSchedule(body) {
  const r = await fetch("/api/iba-schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {
    data = { error: raw || `API returned HTTP ${r.status}.` };
  }
  if (!r.ok) {
    const detail = data.error || data.message || `API returned HTTP ${r.status}.`;
    throw new Error(`IBA schedule API error (${r.status}): ${detail}`);
  }
  return data;
}

function divisionKey(division) {
  return `${division?.format || ""}:${division?.day || ""}:${division?.value || division?.label || ""}`;
}

function scheduleMatchupCount(data) {
  return (data?.weeks || []).reduce((total, week) => total + (week.pairings?.length || 0), 0);
}

function hasUsableSchedule(data) {
  return !!(data?.hasSchedule && data.teams?.length && data.weeks?.length && scheduleMatchupCount(data) > 0);
}

export default function IbaScheduleImportPanel({ season, onImported, compact = false }) {
  const navigate = useNavigate();
  const cachedState = schedulePanelStateBySeason.get(season?.id) || {};
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [divisions, setDivisions] = useState(() => cachedState.divisions ?? null);
  const [selected, setSelected] = useState(() => cachedState.selected ?? {});
  const [previews, setPreviews] = useState(() => cachedState.previews ?? {});
  const [rowErrors, setRowErrors] = useState(() => cachedState.rowErrors ?? {});
  const [expanded, setExpanded] = useState(() => cachedState.expanded ?? null);
  const [result, setResult] = useState(() => cachedState.result ?? null);
  const [diagnostic, setDiagnostic] = useState(() => cachedState.diagnostic ?? null);
  const [retrieveProgress, setRetrieveProgress] = useState({ current: 0, total: 0 });
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });
  const [currentImportLabel, setCurrentImportLabel] = useState("");
  const [existingStatus, setExistingStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const refreshImportStatus = async () => {
    if (!season?.id) return;
    setStatusLoading(true);
    try { setExistingStatus(await db.getIbaScheduleImportStatus(season.id)); }
    finally { setStatusLoading(false); }
  };

  useEffect(() => {
    refreshImportStatus();
    // The schedule discovery/preview/result view is cached for this season
    // while the manager navigates between tabs within Create or Update Seasons.
    // A deliberate Refresh IBA Data resets it; leaving the page clears the cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [season?.id]);

  useEffect(() => {
    if (!season?.id) return;
    schedulePanelStateBySeason.set(season.id, {
      divisions, selected, previews, rowErrors, expanded, result, diagnostic,
    });
  }, [season?.id, divisions, selected, previews, rowErrors, expanded, result, diagnostic]);

  const discover = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    setDiagnostic(null);
    setPreviews({});
    setRowErrors({});
    setRetrieveProgress({ current: 0, total: 0 });

    try {
      const discovered = await postSchedule({ action: "discover-all" });
      const found = (discovered.groups || []).flatMap(group =>
        (group.divisions || []).map(division => ({
          ...division,
          format: group.format,
          day: group.day,
        }))
      );
      setDiagnostic(discovered.diagnostic || { totals: discovered.totals, errors: discovered.errors });

      setSelected(
        Object.fromEntries(
          found.map((d) => [divisionKey(d), true])
        )
      );

      if (!found.length) {
        setError(
          "IBA returned no divisions across the available formats and days. Review the IBA response diagnostics below."
        );
        return;
      }

      setRetrieveProgress({ current: 0, total: found.length });
      const fetched = {};
      const errors = [];
      const rowErrorsFound = {};

      // Fetch in small batches so a season with many format/day groups does
      // not require dozens of sequential round trips to IBA.
      for (let i = 0; i < found.length; i += 4) {
        const batch = found.slice(i, i + 4);
        const results = await Promise.all(batch.map(async division => {
          const key = divisionKey(division);
          try {
            const data = await postSchedule({
              action: "fetch",
              format: division.format,
              day: division.day,
              division: division.value || division.label,
            });
            return { key, data, division };
          } catch (e) {
            return { key, division, error: e?.message || "Unable to retrieve division schedule." };
          }
        }));
        for (const item of results) {
          if (item.data) fetched[item.key] = item.data;
          if (item.error) {
            rowErrorsFound[item.key] = item.error;
            errors.push(`${item.division.label} (${item.division.format} · ${item.division.day}): ${item.error}`);
          }
        }
        setRetrieveProgress(progress => ({ ...progress, current: Math.min(found.length, progress.current + batch.length) }));
      }

      setDivisions(found);
      setPreviews(fetched);
      setRowErrors(rowErrorsFound);
      setSelected(Object.fromEntries(found.map(d => {
        const key = divisionKey(d);
        return [key, hasUsableSchedule(fetched[key])];
      })));

      if (errors.length) {
        setError(errors.join(" · "));
      }
    } catch (e) {
      setError(e?.message || "Unable to discover IBA divisions.");
    } finally {
      setLoading(false);
    }
  };

  const fetchPreview = async (division) => {
    const key = divisionKey(division);
    setLoading(true); setError("");
    try {
      const data = await postSchedule({ action: "fetch", format: division.format, day: division.day, division: division.value || division.label });
      setPreviews(p => ({ ...p, [key]: data }));
      setRowErrors(p => { const next = { ...p }; delete next[key]; return next; });
      setSelected(p => ({ ...p, [key]: hasUsableSchedule(data) }));
      setExpanded(key);
      if (result?.skipped?.some(item => item.key === key)) {
        const usable = hasUsableSchedule(data);
        setResult(current => current ? { ...current, recoveredKeys: usable ? [...new Set([...(current.recoveredKeys || []), key])] : (current.recoveredKeys || []).filter(existingKey => existingKey !== key) } : current);
      }
    } catch (e) {
      const message = e?.message || ("Could not retrieve " + division.label + ".");
      setRowErrors(p => ({ ...p, [key]: message }));
      setSelected(p => ({ ...p, [key]: false }));
      setError(message);
    }
    finally { setLoading(false); }
  };

  const importSelected = async (onlyKeys = null) => {
    const targetedKeys = Array.isArray(onlyKeys) ? onlyKeys : null;
    const chosen = (divisions || []).filter(d => targetedKeys ? targetedKeys.includes(divisionKey(d)) : selected[divisionKey(d)]);
    if (!chosen.length) return;
    const previousResult = result;
    setImporting(true); setError(""); setImportProgress({ current: 0, total: chosen.length });
    setCurrentImportLabel(chosen[0]?.label || "");
    const imported = []; const skipped = [];
    for (const d of chosen) {
      const key = divisionKey(d);
      setCurrentImportLabel(`${d.label} · ${d.format} · ${d.day}`);
      try {
        let data = previews[key];
        if (!data) { data = await postSchedule({ action: "fetch", format: d.format, day: d.day, division: d.value || d.label }); setPreviews(p => ({ ...p, [key]: data })); }
        if (!hasUsableSchedule(data)) {
          skipped.push({ key, label: d.label, reason: scheduleMatchupCount(data) === 0 ? "No matchups found — this division was not imported." : "IBA returned no usable team and schedule data." });
          continue;
        }
        const importedDivision = await db.importIbaScheduleDivision(season.id, { num: extractDivisionNum(d), name: d.label, format: d.format, day: d.day, teams: data.teams, weeks: data.weeks });
        if (importedDivision.ok) imported.push(importedDivision); else skipped.push({ key, label: d.label, reason: importedDivision.error || "Import failed" });
      } catch (e) {
        const reason = e?.message || "Unable to retrieve or import this division";
        setRowErrors(p => ({ ...p, [key]: reason }));
        skipped.push({ key, label: d.label, reason });
      }
      finally { setImportProgress(p => ({ ...p, current: p.current + 1 })); }
    }
    const previousImported = previousResult?.imported || [];
    const remainingPreviousSkipped = (previousResult?.skipped || []).filter(item => !chosen.some(d => divisionKey(d) === item.key));
    setResult({ imported: [...previousImported, ...imported], skipped: [...remainingPreviousSkipped, ...skipped], recoveredKeys: (previousResult?.recoveredKeys || []).filter(key => !chosen.some(d => divisionKey(d) === key)) });
    try { await refreshImportStatus(); if (onImported) await onImported(); }
    catch (e) { setError(e?.message || "Schedules were processed, but the season status could not be refreshed."); }
    finally { setImporting(false); setCurrentImportLabel(""); }
  };
  const selectedCount = Object.values(selected).filter(Boolean).length;
  const totalTeams = result?.imported?.reduce((n, x) => n + (x.teamCount || 0), 0) || 0;
  const totalWeeks = result?.imported?.reduce((n, x) => n + (x.weekCount || 0), 0) || 0;
  const totalPairings = result?.imported?.reduce((n, x) => n + (x.pairingCount || 0), 0) || 0;

  const retrieving = loading && retrieveProgress.total > 0;
  const importingSchedules = importing && importProgress.total > 0;
  const statusReady = !statusLoading && (existingStatus?.hasSchedule === true || (existingStatus?.totals?.weeks > 0 && existingStatus?.totals?.pairings > 0));

  return (
    <>
      {(retrieving || importingSchedules) && (
        <div style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: "rgba(0, 0, 0, 0.62)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}>
          <div style={{
            width: "min(430px, 100%)",
            background: "#1C1C1C",
            color: "#FFFFFF",
            border: "1.5px solid #3A3A3A",
            borderRadius: 16,
            padding: 28,
            textAlign: "center",
            boxShadow: "0 20px 60px rgba(0,0,0,.5)",
          }}>
            <RefreshCw size={30} color="#5FCF9E" style={{ animation: "spin 1s linear infinite", marginBottom: 12 }} />
            <div style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 800, color: "#FFFFFF" }}>
              {importingSchedules ? "Importing IBA Divisions" : "Retrieving IBA Schedule Data"}
            </div>
            <div style={{ margin: "0 0 18px", fontSize: 12, lineHeight: 1.5, color: "#BDBDBD" }}>
              {importingSchedules ? `Saving division ${Math.min(importProgress.current + 1, importProgress.total)} of ${importProgress.total}: ${currentImportLabel || "Preparing import"}. Please keep this page open.` : "Retrieving schedule information from IBA. Please wait."}
            </div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#FFFFFF", marginBottom: 10 }}>
              {importingSchedules ? `${importProgress.current} of ${importProgress.total} divisions processed` : `${retrieveProgress.current} of ${retrieveProgress.total} divisions retrieved`}
            </div>
            <div style={{
              width: "100%",
              height: 8,
              background: "#121212",
              borderRadius: 99,
              overflow: "hidden",
              border: "1px solid #2E2E2E",
            }}>
              <div style={{
                width: `${(importingSchedules ? importProgress.total : retrieveProgress.total) ? Math.round(((importingSchedules ? importProgress.current : retrieveProgress.current) / (importingSchedules ? importProgress.total : retrieveProgress.total)) * 100) : 0}%`,
                height: "100%",
                background: "#5FCF9E",
                transition: "width .2s ease",
              }} />
            </div>
          </div>
        </div>
      )}

    <div className="card" style={{ marginTop: 10, borderColor: "#3A235F" }}>
      <div className="card__title" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <Calendar size={14}/> Import Teams & Schedules
      </div>

      <div style={{ fontSize: 11.5, color: "#9A9A9A", lineHeight: 1.5 }}>
        Choose one of two ways to import this season's data: sync divisions, teams, and schedules directly from IBA, or manually import teams and schedules. Use Advanced: Add or Edit Divisions below only to maintain division records—not to import teams or schedules.
      </div>

      {!divisions && !result && statusReady && (
        <div className="import-warning-block" style={{ background: "#0F2D1F", borderColor: "#1F6B4A", marginTop: 10 }}>
          <div className="import-warning-block__title" style={{ color: "#5FCF9E" }}>
            <Check size={12}/> IBA schedule already imported
          </div>
          <div style={{ fontSize: 11, color: "#E0E0E0", lineHeight: 1.5 }}>
            {existingStatus.totals.divisions} divisions · {existingStatus.totals.teams} teams · {existingStatus.totals.weeks} schedule weeks · {existingStatus.totals.pairings} matchups
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            <button className="btn-primary" onClick={() => navigate(`/schedules?season=${encodeURIComponent(season.id)}`)}>
              View Schedules
            </button>
            <button className="btn-primary" onClick={discover} disabled={loading || importing}>
              {loading ? <><RefreshCw size={13} className="spin"/> Checking IBA…</> : "Automatic Import: Sync from IBA"}
            </button>
            <button className="btn-primary" onClick={() => navigate(`/manual-season-import?season=${encodeURIComponent(season.id)}`)}>
              Manual Import: Teams & Schedule
            </button>
          </div>
        </div>
      )}

      {!divisions && !result && !statusReady && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
          <button className="btn-primary" onClick={discover} disabled={loading || importing}>
            {loading ? <><RefreshCw size={13} className="spin"/> Checking IBA…</> : "Automatic Import: Sync from IBA"}
          </button>
          <button className="btn-primary" onClick={() => navigate(`/manual-season-import?season=${encodeURIComponent(season.id)}`)}>
              Manual Import: Teams & Schedule
            </button>
        </div>
      )}

      {error && (
        <div className="import-warning-block" style={{ marginTop: 9 }}>
          <div className="import-warning-block__title"><AlertCircle size={12}/>{error}</div>
          {!divisions?.length && diagnostic && (
            <details style={{ marginTop: 7, fontSize: 10.5, color: "#BDBDBD" }}>
              <summary style={{ cursor: "pointer", color: "#E0E0E0" }}>IBA response diagnostics</summary>
              <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 6, maxHeight: 240, overflow: "auto" }}>{JSON.stringify(diagnostic, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      {divisions && !result && (
        <>
          <div style={{ marginTop: 10, padding: "8px 9px", background: "#101010", border: "1px solid #242424", borderRadius: 8, fontSize: 11, color: "#BDBDBD" }}>
            <strong style={{ color: "#E0E0E0" }}>{divisions.length}</strong> IBA division{divisions.length === 1 ? "" : "s"} discovered and schedule data retrieved. All are selected for import.
          </div>

          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
            {divisions.map(d => {
              const key = divisionKey(d);
              const data = previews[key];
              const open = expanded === key;

              return (
                <div key={key} className="list-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 5 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <input
                      type="checkbox"
                      checked={!!selected[key]}
                      disabled={!!data && !hasUsableSchedule(data)}
                      onChange={e => setSelected(p => ({ ...p, [key]: e.target.checked }))}
                    />
                    <div className="list-row__body" style={{ flex: 1 }}>
                      <span className="list-row__name">{d.label}</span>
                      <span className="list-row__sub">{d.format} · {d.day}</span>
                      <span className="list-row__sub">
                        {!data ? (rowErrors[key] ? "Retrieval failed — retry to try again" : "Schedule not retrieved yet") : !hasUsableSchedule(data) ? (scheduleMatchupCount(data) === 0 ? "No matchups found — excluded from import" : "No usable schedule data — excluded from import") : `${data.teams?.length ?? 0} teams · ${data.weeks?.length ?? 0} weeks · ${scheduleMatchupCount(data)} matchups`}
                      </span>
                      {(rowErrors[key] || data?.error || data?.message || (data && !hasUsableSchedule(data))) && (
                        <span role="status" style={{ display: "block", marginTop: 4, fontSize: 11, color: "#F59E0B", lineHeight: 1.45 }}>
                          {rowErrors[key] || data?.error || data?.message || (scheduleMatchupCount(data) === 0 ? "IBA returned no matchups for this division. It will not be imported." : "IBA did not return usable team and schedule data. It will not be imported.")}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "stretch" }}>
                      <button className="btn-sm" onClick={() => data ? setExpanded(open ? null : key) : fetchPreview(d)} disabled={loading || importing}>
                        {data ? (open ? "Hide preview" : "Preview") : (rowErrors[key] ? "Retry retrieval" : "Retrieve preview")}
                      </button>
                      {data && <button className="btn-sm" onClick={() => fetchPreview(d)} disabled={loading || importing}>Retry from IBA</button>}
                    </div>
                  </div>
                  {open && data && <SchedulePreview data={data}/>}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            <button className="btn-primary" onClick={() => importSelected()} disabled={loading || importing || selectedCount === 0}>
              {importing ? `Importing ${Math.min(importProgress.current + 1, importProgress.total)} of ${importProgress.total}…` : `Upload ${selectedCount} Division${selectedCount === 1 ? "" : "s"}`}
            </button>
            <button className="btn-sm" onClick={discover} disabled={loading || importing}>Refresh IBA Data</button>
          </div>
          {importing && <div role="status" aria-live="polite" style={{marginTop:8,padding:"9px 10px",border:"1px solid #315B48",background:"#10251B",borderRadius:8,fontSize:12,color:"#D9FBE8",lineHeight:1.5}}>
            <strong>Import in progress</strong> — {importProgress.current} of {importProgress.total} divisions processed.
            <div style={{color:"#B6D8C5",marginTop:3}}>Current division: {currentImportLabel || "Preparing import"}. Keep this page open until the results appear.</div>
          </div>}
        </>
      )}

      {result && (
        <div className="import-warning-block" style={{ background: result.skipped.length ? "#30230F" : "#0F2D1F", borderColor: result.skipped.length ? "#8A5A16" : "#1F6B4A", marginTop: 10 }}>
          <div className="import-warning-block__title" style={{ color: result.skipped.length ? "#F59E0B" : "#5FCF9E" }}>{result.skipped.length ? <AlertCircle size={12}/> : <Check size={12}/>} {result.skipped.length ? "IBA schedule sync needs review" : "IBA schedule sync complete"}</div>
          <div style={{ fontSize: 11, color: "#E0E0E0", lineHeight: 1.5 }}>{result.imported.length} division{result.imported.length === 1 ? "" : "s"} imported · {totalTeams} teams · {totalWeeks} schedule weeks · {totalPairings} matchups</div>
          {result.skipped.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: "#E0E0E0", marginTop: 8 }}>Only the divisions listed here need attention. Successful imports are retained; you do not need to rediscover all divisions.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {result.skipped.map(item => {
                  const division = (divisions || []).find(d => divisionKey(d) === item.key);
                  const data = previews[item.key];
                  const usable = !!(data?.hasSchedule && data.teams?.length && data.weeks?.length);
                  const recovered = (result.recoveredKeys || []).includes(item.key);
                  return <div key={item.key} style={{ border: "1px solid #5A421F", borderRadius: 7, padding: 8 }}>
                    <div style={{ fontWeight: 700, color: "#FFFFFF" }}>{item.label}</div>
                    <div style={{ fontSize: 10.5, color: "#C8C8C8", marginTop: 2 }}>{item.reason}</div>
                    {recovered && usable && <div style={{ fontSize: 10.5, color: "#5FCF9E", marginTop: 4 }}>Schedule data retrieved. Ready to upload this division.</div>}
                    <button className="btn-sm" style={{ marginTop: 6 }} disabled={loading || importing || !division} onClick={() => division && fetchPreview(division)}>{loading && expanded === item.key ? "Retrying…" : "Retry this division"}</button>
                  </div>;
                })}
              </div>
              {(result.recoveredKeys || []).length > 0 && <button className="btn-primary" style={{ marginTop: 8 }} disabled={loading || importing} onClick={() => importSelected(result.recoveredKeys)}>Upload recovered divisions</button>}
            </>
          )}
          <button className="btn-sm" onClick={discover} disabled={loading || importing} style={{ marginTop: 8 }}>Rediscover all divisions</button>
        </div>
      )}
    </div>
    </>
  );
}

function extractDivisionNum(option) {
  const value = String(option?.value || "").trim();

  const compound = value.match(/!([0-9]+)$/);
  if (compound) return compound[1];

  const numeric = value.match(/([0-9]+)$/);
  if (numeric) return numeric[1];

  return String(option?.label || "").trim();
}

function SchedulePreview({ data }) {
  const teams = data.teams || [];
  const weeks = data.weeks || [];
  const matchupCount = weeks.reduce((n, week) => n + (week.pairings?.length || 0), 0);

  return (
    <div style={{ background: "#0D0D0D", border: "1px solid #262626", borderRadius: 8, padding: 8 }}>
      <div style={{ fontSize: 10.5, color: "#7A7A7A", marginBottom: 6 }}>Source: IBA schedule page</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        <div><strong style={{ color: "#E0E0E0" }}>{teams.length}</strong> teams</div>
        <div><strong style={{ color: "#E0E0E0" }}>{weeks.length}</strong> weeks</div>
        <div><strong style={{ color: "#E0E0E0" }}>{matchupCount}</strong> matchups</div>
      </div>
      <div style={{ maxHeight: 180, overflow: "auto", fontSize: 10.5 }}>
        {teams.map((t, i) => (
          <div key={`${t.teamNum}-${i}`} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 6, padding: "3px 0", borderBottom: "1px solid #181818" }}>
            <span>{t.teamNum}</span><span>{t.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
