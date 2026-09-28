import { useState } from "react";
import { Check, Calendar, RefreshCw, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import * as db from "./db";

async function postSchedule(body) {
  const r = await fetch("/api/iba-schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Could not retrieve the IBA schedule.");
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

  const discover = async () => {
    setLoading(true); setError(""); setResult(null); setPreviews({});
    try {
      const data = await postSchedule({ action: "discover", format: season.format, day: season.day });
      setDivisions(data.divisions || []);
      setSelected(Object.fromEntries((data.divisions || []).map(d => [d.value || d.label, true])));
      if (!data.divisions?.length) setError("IBA did not return any divisions for this format and night. That can be normal before a season is published.");
    } catch (e) { setError(e?.message || "Unable to discover IBA divisions."); }
    finally { setLoading(false); }
  };

  const fetchPreview = async (division) => {
    const key = division.value || division.label;
    setLoading(true); setError("");
    try {
      const data = await postSchedule({ action: "fetch", format: season.format, day: season.day, division: division.value || division.label });
      setPreviews(p => ({ ...p, [key]: data }));
      setExpanded(key);
    } catch (e) { setError(e?.message || `Could not retrieve ${division.label}.`); }
    finally { setLoading(false); }
  };

  const importSelected = async () => {
    const chosen = (divisions || []).filter(d => selected[d.value || d.label]);
    if (!chosen.length) return;
    setImporting(true); setError("");
    try {
      const imported = [];
      const skipped = [];
      for (const d of chosen) {
        const key = d.value || d.label;
        let data = previews[key];
        if (!data) {
          data = await postSchedule({ action: "fetch", format: season.format, day: season.day, division: d.value || d.label });
          setPreviews(p => ({ ...p, [key]: data }));
        }
        if (!data.hasSchedule || !data.teams?.length || !data.weeks?.length) {
          skipped.push(`${d.label}: no schedule data returned`);
          continue;
        }
        const divisionNum = extractDivisionNum(d, data);
        const result = await db.importIbaScheduleDivision(season.id, {
          num: divisionNum,
          name: d.label,
          teams: data.teams,
          weeks: data.weeks,
        });
        if (result.ok) imported.push(result);
        else skipped.push(`${d.label}: ${result.error || "import failed"}`);
      }
      setResult({ imported, skipped });
      if (onImported) await onImported();
    } catch (e) { setError(e?.message || "Unable to import the selected schedules."); }
    finally { setImporting(false); }
  };

  return (
    <div className="card" style={{ marginTop: 10, borderColor: "#3A235F" }}>
      <div className="card__title" style={{ display: "flex", alignItems: "center", gap: 7 }}><Calendar size={14}/> IBA Schedule Import</div>
      <div style={{ fontSize: 11.5, color: "#9A9A9A", lineHeight: 1.5 }}>
        Automatically checks the IBA schedule page for <strong style={{ color: "#E0E0E0" }}>{season.format}</strong> on <strong style={{ color: "#E0E0E0" }}>{season.day}</strong>, discovers the available divisions, then retrieves teams, weekly dates, pairings, holidays and playoff weeks. Nothing is written until you import it.
      </div>

      {!divisions && !result && (
        <button className="btn-primary" onClick={discover} disabled={loading} style={{ marginTop: 9 }}>
          {loading ? <><RefreshCw size={13} className="spin"/> Checking IBA…</> : "Discover IBA Schedules"}
        </button>
      )}

      {error && <div className="import-warning-block" style={{ marginTop: 9 }}><div className="import-warning-block__title"><AlertCircle size={12}/>{error}</div></div>}

      {divisions && !result && (
        <>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
            {divisions.map(d => {
              const key = d.value || d.label;
              const data = previews[key];
              const open = expanded === key;
              return <div key={key} className="list-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <input type="checkbox" checked={!!selected[key]} onChange={e => setSelected(p => ({ ...p, [key]: e.target.checked }))}/>
                  <div className="list-row__body" style={{ flex: 1 }}>
                    <span className="list-row__name">{d.label}</span>
                    <span className="list-row__sub">{data ? `${data.teams?.length ?? 0} teams · ${data.weeks?.length ?? 0} weeks` : "Schedule not retrieved yet"}</span>
                  </div>
                  <button className="btn-sm" onClick={() => data ? setExpanded(open ? null : key) : fetchPreview(d)} disabled={loading}>
                    {data ? (open ? <ChevronUp size={12}/> : <ChevronDown size={12}/>) : "Preview"}
                  </button>
                </div>
                {open && data && <SchedulePreview data={data}/>} 
              </div>;
            })}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <button className="btn-primary" onClick={importSelected} disabled={importing || !Object.values(selected).some(Boolean)}>
              {importing ? "Importing…" : `Import ${Object.values(selected).filter(Boolean).length} Division${Object.values(selected).filter(Boolean).length === 1 ? "" : "s"}`}
            </button>
            <button className="btn-sm" onClick={discover} disabled={loading}>Refresh</button>
          </div>
        </>
      )}

      {result && <div className="import-warning-block" style={{ background: "#0F2D1F", borderColor: "#1F6B4A", marginTop: 10 }}>
        <div className="import-warning-block__title" style={{ color: "#5FCF9E" }}><Check size={12}/> IBA schedules imported</div>
        <div style={{ fontSize: 11, color: "#E0E0E0", lineHeight: 1.5 }}>
          {result.imported.length} division{result.imported.length === 1 ? "" : "s"} imported. {result.imported.reduce((n, x) => n + x.teamCount, 0)} teams and {result.imported.reduce((n, x) => n + x.weekCount, 0)} schedule weeks loaded.
        </div>
        {result.skipped.length > 0 && <div style={{ fontSize: 10.5, color: "#F59E0B", marginTop: 5 }}>Review: {result.skipped.join(" · ")}</div>}
        <button className="btn-sm" onClick={() => { setResult(null); setDivisions(null); setPreviews({}); }} style={{ marginTop: 7 }}>Check Again</button>
      </div>}
    </div>
  );
}

function extractDivisionNum(option, data) {
  const fromValue = String(option.value || "").match(/\d{2,6}/)?.[0];
  if (fromValue) return fromValue;
  const fromLabel = String(option.label || "").match(/\d{2,6}/)?.[0];
  if (fromLabel) return fromLabel;
  const teamNum = data?.teams?.[0]?.teamNum;
  if (teamNum) return String(teamNum).slice(0, 3);
  return String(option.label || "").trim();
}

function SchedulePreview({ data }) {
  const teams = data.teams || [];
  const weeks = data.weeks || [];
  return <div style={{ background: "#0D0D0D", border: "1px solid #262626", borderRadius: 8, padding: 8 }}>
    <div style={{ fontSize: 10.5, color: "#7A7A7A", marginBottom: 6 }}>Source: IBA schedule page</div>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
      <div><strong style={{ color: "#E0E0E0" }}>{teams.length}</strong> teams</div>
      <div><strong style={{ color: "#E0E0E0" }}>{weeks.length}</strong> weeks</div>
    </div>
    <div style={{ maxHeight: 180, overflow: "auto", fontSize: 10.5 }}>
      {teams.map((t, i) => <div key={`${t.teamNum}-${i}`} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 6, padding: "3px 0", borderBottom: "1px solid #181818" }}><span>{t.teamNum}</span><span>{t.name}</span></div>)}
    </div>
  </div>;
}
