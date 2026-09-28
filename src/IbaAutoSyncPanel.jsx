import { useState } from "react";
import { Check, Download, RefreshCw, AlertCircle } from "lucide-react";
import { fetchIbaReports, buildIbaPreview, importIbaReports, ibaCodesForSeason } from "./ibaAutoSync";

export default function IbaAutoSyncPanel({ season, schedule, onComplete }) {
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [result, setResult] = useState(null);

  const codes = ibaCodesForSeason(season);
  const supported = !!codes.leagueType && !!codes.day;

  const fetchReports = async () => {
    setLoading(true); setError(""); setResult(null);
    try {
      const fetched = await fetchIbaReports(season);
      const preview = await buildIbaPreview(fetched.reports);
      setData({ ...fetched, preview });
    } catch (e) {
      setError(e?.message || "Unable to retrieve IBA reports.");
    } finally { setLoading(false); }
  };

  const importReports = async () => {
    if (!data?.reports) return;
    setImporting(true); setError("");
    try {
      const imported = await importIbaReports(data.reports, season, schedule);
      setResult(imported);
      if (onComplete) await onComplete();
    } catch (e) {
      setError(e?.message || "Unable to import IBA reports.");
    } finally { setImporting(false); }
  };

  return (
    <div className="card" style={{marginBottom:12}}>
      <div className="card__title" style={{display:"flex",alignItems:"center",gap:7}}>
        <Download size={14}/> Automatic IBA Report Sync
      </div>
      <div style={{fontSize:12,color:"#9A9A9A",lineHeight:1.5}}>
        Fetches the current IBA {season?.format || "league"} · {season?.day || "day"} reports for roster/ratings, team standings, and MVP standings. Missing reports are treated as normal when that league is not playing.
      </div>
      {!supported && <div className="import-warning-block"><div className="import-warning-block__title"><AlertCircle size={12}/> Select a season with a supported format and day.</div></div>}
      {supported && !data && (
        <button className="btn-primary" onClick={fetchReports} disabled={loading} style={{marginTop:8}}>
          {loading ? <><RefreshCw size={13} className="spin"/> Checking IBA…</> : "Fetch Latest IBA Reports"}
        </button>
      )}

      {error && <div style={{marginTop:8}}><div className="error-msg">{error}</div></div>}

      {data && (
        <>
          <div className="list" style={{marginTop:10}}>
            {data.reports.map(r => (
              <div key={r.key} className="list-row">
                <div className="list-row__body">
                  <span className="list-row__name">{r.reportType.toUpperCase()}</span>
                  <span className="list-row__sub">{r.key}.pdf</span>
                </div>
                <span className="player-rating-badge" style={{color:r.status === "ok" ? "#5FCF9E" : "#9A9A9A"}}>{r.status}</span>
              </div>
            ))}
          </div>

          {data.preview.roster && (
            <div style={{fontSize:11,color:"#5FCF9E",marginTop:8}}>
              Roster: {data.preview.roster.teamCount} teams · {data.preview.roster.playerCount} players
              {data.preview.roster.parsed.ambiguousRoster?.length ? ` · ${data.preview.roster.parsed.ambiguousRoster.length} placement review${data.preview.roster.parsed.ambiguousRoster.length===1?"":"s"}` : ""}
            </div>
          )}
          {data.preview.standings && <div style={{fontSize:11,color:"#D0D0D0",marginTop:4}}>Team standings: {data.preview.standings.rows.length} rows detected.</div>}
          {data.preview.mvp && <div style={{fontSize:11,color:"#D0D0D0",marginTop:4}}>MVP: {data.preview.mvp.rows.length} rows detected.</div>}

          {!result ? (
            <div style={{display:"flex",gap:6,marginTop:10}}>
              <button className="btn-primary" onClick={importReports} disabled={importing}>
                {importing ? "Importing…" : "Import Retrieved Reports"}
              </button>
              <button className="btn-sm" onClick={fetchReports} disabled={loading}>Refresh</button>
            </div>
          ) : (
            <div className="import-warning-block" style={{background:"#0F2D1F",borderColor:"#1F6B4A",marginTop:10}}>
              <div className="import-warning-block__title" style={{color:"#5FCF9E"}}><Check size={12}/> IBA reports imported</div>
              <div style={{fontSize:11,color:"#E0E0E0"}}>
                {result.roster ? `${result.roster.updatedDivisions?.length ?? 0} divisions received roster/rating updates.` : "No roster report imported."}
                {result.standings ? ` ${result.standings.imported} standings rows imported.` : ""}
                {result.mvp ? ` ${result.mvp.imported} MVP rows imported.` : ""}
              </div>
              {(result.warnings?.length || result.standings?.skipped?.length || result.mvp?.skipped?.length) ? (
                <div style={{fontSize:10.5,color:"#F59E0B",marginTop:5}}>
                  Review warnings: {[...(result.warnings||[]), ...((result.standings?.skipped||[]).map(x=>`Standings Team ${x.teamNum}: ${x.reason}`)), ...((result.mvp?.skipped||[]).map(x=>`MVP Team ${x.teamNum}: ${x.reason}`))].join(" · ")}
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
