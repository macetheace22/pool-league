import { useState } from "react";
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

export default function IbaScheduleImportPanel({ season, onImported, compact = false }) {
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [divisions, setDivisions] = useState(null);
  const [selected, setSelected] = useState({});
  const [previews, setPreviews] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [result, setResult] = useState(null);
  const [diagnostic, setDiagnostic] = useState(null);

  const discover = async () => {
    setLoading(true);
    setError("");
    setResult(null);
    setDiagnostic(null);
    setPreviews({});

    try {
      // First discover the published divisions, then use the same individual
      // schedule endpoint as Preview for every division concurrently. This is
      // the proven IBA path and avoids depending on a server-side aggregation
      // response for the UI.
      const discovered = await postSchedule({
        action: "discover",
        format: season.format,
        day: season.day,
      });

      const found = discovered.divisions || [];
      setDiagnostic(discovered.diagnostic || null);
      setDivisions(found);

      setSelected(
        Object.fromEntries(
          found.map((d) => [d.value || d.label, true])
        )
      );

      if (!found.length) {
        setError(
          "IBA returned zero divisions for this format and night. Review the IBA response diagnostics below."
        );
        return;
      }

      // Use the same proven request as Preview, one division at a time.
      // IBA may throttle or reject concurrent schedule requests even though
      // individual Preview requests succeed.
      const fetched = {};
      const errors = [];

      for (const division of found) {
        const key = division.value || division.label;

        try {
          const data = await postSchedule({
            action: "fetch",
            format: season.format,
            day: season.day,
            division: division.value || division.label,
          });
          fetched[key] = data;
          setPreviews({ ...fetched });
        } catch (e) {
          errors.push(`${division.label}: ${e?.message || "Unable to retrieve division schedule."}`);
        }
      }

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
    const key = division.value || division.label;
    setLoading(true);
    setError("");

    try {
      const data = await postSchedule({
        action: "fetch",
        format: season.format,
        day: season.day,
        division: division.value || division.label,
      });
      setPreviews(p => ({ ...p, [key]: data }));
      setExpanded(key);
    } catch (e) {
      setError(e?.message || `Could not retrieve ${division.label}.`);
    } finally {
      setLoading(false);
    }
  };

  const importSelected = async () => {
    const chosen = (divisions || []).filter(d => selected[d.value || d.label]);
    if (!chosen.length) return;

    setImporting(true);
    setError("");
    setResult(null);

    try {
      const imported = [];
      const skipped = [];

      for (const d of chosen) {
        const key = d.value || d.label;
        let data = previews[key];

        if (!data) {
          data = await postSchedule({
            action: "fetch",
            format: season.format,
            day: season.day,
            division: d.value || d.label,
          });
          setPreviews(p => ({ ...p, [key]: data }));
        }

        if (!data.hasSchedule || !data.teams?.length || !data.weeks?.length) {
          skipped.push(`${d.label}: no schedule data returned`);
          continue;
        }

        const divisionNum = extractDivisionNum(d);
        const importedDivision = await db.importIbaScheduleDivision(season.id, {
          num: divisionNum,
          name: d.label,
          teams: data.teams,
          weeks: data.weeks,
        });

        if (importedDivision.ok) {
          imported.push(importedDivision);
        } else {
          skipped.push(`${d.label}: ${importedDivision.error || "import failed"}`);
        }
      }

      setResult({ imported, skipped });
      if (onImported) await onImported();
    } catch (e) {
      setError(e?.message || "Unable to import the selected schedules.");
    } finally {
      setImporting(false);
    }
  };

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const totalTeams = result?.imported?.reduce((n, x) => n + (x.teamCount || 0), 0) || 0;
  const totalWeeks = result?.imported?.reduce((n, x) => n + (x.weekCount || 0), 0) || 0;
  const totalPairings = result?.imported?.reduce((n, x) => n + (x.pairingCount || 0), 0) || 0;

  return (
    <div className="card" style={{ marginTop: 10, borderColor: "#3A235F" }}>
      <div className="card__title" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <Calendar size={14}/> IBA Schedule Import
      </div>

      <div style={{ fontSize: 11.5, color: "#9A9A9A", lineHeight: 1.5 }}>
        Automatically checks the IBA schedule for <strong style={{ color: "#E0E0E0" }}>{season.format}</strong> on <strong style={{ color: "#E0E0E0" }}>{season.day}</strong>, discovers every published division, retrieves each division's teams and complete schedule, and imports them into this season.
      </div>

      {!divisions && !result && (
        <button className="btn-primary" onClick={discover} disabled={loading} style={{ marginTop: 9 }}>
          {loading ? <><RefreshCw size={13} className="spin"/> Checking IBA…</> : "Discover IBA Schedules"}
        </button>
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
              const key = d.value || d.label;
              const data = previews[key];
              const open = expanded === key;

              return (
                <div key={key} className="list-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 5 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <input
                      type="checkbox"
                      checked={!!selected[key]}
                      onChange={e => setSelected(p => ({ ...p, [key]: e.target.checked }))}
                    />
                    <div className="list-row__body" style={{ flex: 1 }}>
                      <span className="list-row__name">{d.label}</span>
                      <span className="list-row__sub">
                        {data ? `${data.teams?.length ?? 0} teams · ${data.weeks?.length ?? 0} weeks · ${data.weeks?.reduce((n, w) => n + (w.pairings?.length || 0), 0) ?? 0} matchups` : "Schedule unavailable"}
                      </span>
                    </div>
                    <button className="btn-sm" onClick={() => data ? setExpanded(open ? null : key) : fetchPreview(d)} disabled={loading || importing}>
                      {data ? (open ? <ChevronUp size={12}/> : <ChevronDown size={12}/>) : "Preview"}
                    </button>
                  </div>
                  {open && data && <SchedulePreview data={data}/>}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <button className="btn-primary" onClick={importSelected} disabled={importing || selectedCount === 0}>
              {importing ? "Importing all selected divisions…" : `Import ${selectedCount} Division${selectedCount === 1 ? "" : "s"}`}
            </button>
            <button className="btn-sm" onClick={discover} disabled={loading || importing}>Refresh IBA Schedules</button>
          </div>
        </>
      )}

      {result && (
        <div className="import-warning-block" style={{ background: "#0F2D1F", borderColor: "#1F6B4A", marginTop: 10 }}>
          <div className="import-warning-block__title" style={{ color: "#5FCF9E" }}>
            <Check size={12}/> IBA schedule import complete
          </div>
          <div style={{ fontSize: 11, color: "#E0E0E0", lineHeight: 1.5 }}>
            {result.imported.length} division{result.imported.length === 1 ? "" : "s"} imported · {totalTeams} teams · {totalWeeks} schedule weeks · {totalPairings} matchups
          </div>
          {result.skipped.length > 0 && (
            <div style={{ fontSize: 10.5, color: "#F59E0B", marginTop: 5 }}>
              Review: {result.skipped.join(" · ")}
            </div>
          )}
          <button className="btn-sm" onClick={() => { setResult(null); setDivisions(null); setPreviews({}); setSelected({}); }} style={{ marginTop: 7 }}>
            Check Again
          </button>
        </div>
      )}
    </div>
  );
}

function extractDivisionNum(option) {
  const value = String(option?.value || "").trim();

  // IBA values are compound IDs such as "287!8538257". The first portion
  // identifies the league; the second portion identifies the actual division.
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
