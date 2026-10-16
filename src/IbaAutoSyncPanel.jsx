import { useState } from "react";
import { Check, Download, RefreshCw, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { fetchIbaReports, buildIbaPreview, importIbaReports, ibaCodesForSeason } from "./ibaAutoSync";

export default function IbaAutoSyncPanel({ season, schedule, onComplete, reportType = null }) {
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [result, setResult] = useState(null);
  const [expandedPreview, setExpandedPreview] = useState({ rost: false, div: false, mvp: false });

  const codes = ibaCodesForSeason(season);
  const supported = !!codes.leagueType && !!codes.day;
  const reportLabels = { rost: "roster & ratings", div: "team standings", mvp: "MVP standings" };
  const selectedReportLabel = reportLabels[reportType] || "weekly league data";
  const selectedReports = (reports) => reportType ? (reports ?? []).filter(r => r.reportType === reportType) : (reports ?? []);
  const previewRows = (type) => {
    if (type === "rost") {
      const parsed = data?.preview?.roster?.parsed;
      if (!parsed) return [];
      return Object.entries(parsed.registry || {}).map(([playerNum, player]) => ({
        teamNum: Object.entries(parsed.rosters || {}).find(([, nums]) => nums.includes(playerNum))?.[0] || "",
        playerNum, playerName: player.name, nickname: player.nickname || "", rating: player.rating ?? "—",
      }));
    }
    if (type === "div") return data?.preview?.standings?.rows || [];
    if (type === "mvp") return data?.preview?.mvp?.rows || [];
    return [];
  };
  const hasEmptyParsedReport = (data?.reports ?? []).some(r => r.status === "ok" && (
    (r.reportType === "rost" && data?.preview?.roster && data.preview.roster.teamCount === 0 && data.preview.roster.playerCount === 0) ||
    (r.reportType === "div" && data?.preview?.standings?.rows.length === 0) ||
    (r.reportType === "mvp" && data?.preview?.mvp?.rows.length === 0)
  ));
  const columnsFor = (type) => type === "rost"
    ? [{ key:"teamNum", label:"Team" }, { key:"playerNum", label:"Player #" }, { key:"playerName", label:"Player" }, { key:"nickname", label:"Nickname" }, { key:"rating", label:"Rating" }]
    : type === "div"
      ? [{ key:"teamNum", label:"Team #" }, { key:"teamName", label:"Team" }, { key:"pointsLastWk", label:"Last week" }, { key:"totalPoints", label:"Total points" }, { key:"setsPlayed", label:"Sets played" }]
      : [{ key:"playerNum", label:"Player #" }, { key:"playerName", label:"Player" }, { key:"teamNum", label:"Team #" }, { key:"wins", label:"Sets won" }, { key:"mvpRankingPoints", label:"MVP points" }, { key:"losses", label:"Sets lost" }, { key:"pointsScored", label:"Points scored" }];

  const fetchReports = async () => {
    setLoading(true); setError(""); setResult(null);
    try {
      const fetched = await fetchIbaReports(season, reportType);
      const reports = selectedReports(fetched.reports);
      const preview = await buildIbaPreview(reports);
      setData({ ...fetched, reports, preview });
    } catch (e) {
      setError(e?.message || "Unable to retrieve IBA reports.");
    } finally { setLoading(false); }
  };

  const importReports = async () => {
    if (!data?.reports) return;
    setImporting(true); setError("");
    try {
      const imported = await importIbaReports(selectedReports(data.reports), season, schedule);
      setResult(imported);
      if (onComplete) await onComplete();
    } catch (e) {
      setError(e?.message || "Unable to import IBA reports.");
    } finally { setImporting(false); }
  };

  return (
    <div className="card" style={{marginBottom:12}}>
      <div className="card__title" style={{display:"flex",alignItems:"center",gap:7}}>
        <Download size={14}/> {reportType ? `Automatic IBA Sync · ${reportLabels[reportType] || reportType}` : "Automatic IBA Report Sync"}
      </div>
      <div style={{fontSize:12,color:"#9A9A9A",lineHeight:1.5}}>
        Automatically checks the current IBA {season?.format || "league"} · {season?.day || "day"} report{reportType ? ` for ${selectedReportLabel}` : "s for roster/ratings, team standings, and MVP standings"}. A report may be missing when that league is not playing.
      </div>
      {!reportType && <div style={{fontSize:11.5,color:"#D0D0D0",lineHeight:1.5,marginTop:8,padding:"8px 10px",background:"#141414",border:"1px solid #2A2A2A",borderRadius:8}}>
        <strong style={{color:"#E0E0E0"}}>What this sync covers:</strong> roster/ratings, IBA team-standings reports, and IBA MVP reports. It does not import playoff eligibility; use season management for that manual-only report. Imported IBA standings and MVP reports are source snapshots, distinct from the app's computed standings and MVP results.
      </div>}
      {!supported && <div className="import-warning-block"><div className="import-warning-block__title"><AlertCircle size={12}/> Select a season with a supported format and day.</div></div>}
      {supported && !data && (
        <button className="btn-primary" onClick={fetchReports} disabled={loading} style={{marginTop:8}}>
          {loading ? <><RefreshCw size={13} className="spin"/> Checking IBA…</> : reportType ? `Fetch Latest ${reportLabels[reportType] || "IBA Report"}` : "Fetch Latest IBA Reports"}
        </button>
      )}

      {error && <div style={{marginTop:8}}><div className="error-msg">{error}</div></div>}

      {data && (
        <>
          {data.reports.some(r => r.status !== "ok") && (
            <div className="import-warning-block" style={{marginTop:10}}>
              <div className="import-warning-block__title"><AlertCircle size={12}/> Some IBA reports are unavailable</div>
              <div style={{fontSize:11,color:"#D0D0D0"}}>
                {data.reports.filter(r => r.status !== "ok").map(r => `${r.reportType.toUpperCase()}: ${r.message || "report not available"}`).join(" · ")}
              </div>
            </div>
          )}

          {data.reports.filter(r => r.status === "ok" && ["rost","div","mvp"].includes(r.reportType)).map(r => {
            const rows = previewRows(r.reportType);
            const columns = columnsFor(r.reportType);
            const count = r.reportType === "rost" ? (data.preview.roster?.playerCount || 0) : rows.length;
            const empty = r.reportType === "rost"
              ? !data.preview.roster || (data.preview.roster.teamCount === 0 && data.preview.roster.playerCount === 0)
              : rows.length === 0;
            return (
              <section key={r.key} style={{marginTop:12,border:"1px solid #353535",borderRadius:9,overflow:"hidden"}}>
                <button type="button" className="btn-sm" onClick={() => setExpandedPreview(v => ({...v,[r.reportType]:!v[r.reportType]}))} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"10px 12px",borderRadius:0}}>
                  <span style={{textAlign:"left"}}>{r.reportType.toUpperCase()} parsed preview · {count.toLocaleString()} {r.reportType === "rost" ? "players" : "rows"}{r.reportType === "rost" ? ` across ${data.preview.roster?.teamCount || 0} teams` : ""}</span>
                  {expandedPreview[r.reportType] ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
                </button>
                {(() => {
                  const metadata = data.preview.reports.find(item => item.key === r.key)?.reportWeek;
                  if (!metadata) return null;
                  return (
                    <div style={{padding:"7px 10px",fontSize:11,color:metadata.missing || metadata.ambiguous ? "#F0C36D" : "#AAA",borderTop:"1px solid #292929"}}>
                      {metadata.missing ? "Report week not detected" : metadata.ambiguous ? `Conflicting week labels detected: ${metadata.weekNumbers.join(", ")} — review before importing` : `Week ${metadata.weekNumber} detected from PDF text`}
                    </div>
                  );
                })()}
                {expandedPreview[r.reportType] && (
                  <div style={{padding:10}}>
                    {empty ? (
                      <div className="import-warning-block">
                        <div className="import-warning-block__title"><AlertCircle size={12}/> No parsed records</div>
                        <div style={{fontSize:11,color:"#D0D0D0"}}>The PDF was retrieved, but this parser returned no records. Import is blocked. Check the extracted text diagnostics below.</div>
                      </div>
                    ) : (
                      <div style={{overflowX:"auto",maxHeight:360,overflowY:"auto",border:"1px solid #2A2A2A",borderRadius:6}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,minWidth:r.reportType==="mvp"?650:r.reportType==="rost"?520:480}}>
                          <thead><tr>{columns.map(col=><th key={col.key} style={{position:"sticky",top:0,textAlign:"left",padding:"8px 9px",background:"#202020",color:"#D0D0D0",borderBottom:"1px solid #3A3A3A",whiteSpace:"nowrap"}}>{col.label}</th>)}</tr></thead>
                          <tbody>{rows.map((row,i)=><tr key={`${row.playerNum || row.teamNum || "row"}-${i}`}>{columns.map(col=><td key={col.key} style={{padding:"7px 9px",borderBottom:"1px solid #292929",color:"#E0E0E0",whiteSpace:"nowrap"}}>{String(row[col.key] ?? "—")}</td>)}</tr>)}</tbody>
                        </table>
                      </div>
                    )}
                    <div style={{fontSize:10.5,color:"#AAA",marginTop:7}}>Showing parsed records from the downloaded report. Review names, IDs, ratings, and totals before importing.</div>
                  </div>
                )}
              </section>
            );
          })}

          {hasEmptyParsedReport && !result && (
            <div className="import-warning-block" style={{marginTop:10}}>
              <div className="import-warning-block__title"><AlertCircle size={12}/> Import blocked — no rows detected</div>
              <div style={{fontSize:11,color:"#D0D0D0"}}>The PDFs downloaded, but one or more reports could not be parsed into records. Review the extracted text below. Import remains disabled until parsing is corrected.</div>
            </div>
          )}

          {(data.reports ?? []).filter(r => r.status === "ok" && (
            (r.reportType === "rost" && data.preview.roster && data.preview.roster.teamCount === 0 && data.preview.roster.playerCount === 0) ||
            (r.reportType === "div" && data.preview.standings?.rows.length === 0) ||
            (r.reportType === "mvp" && data.preview.mvp?.rows.length === 0)
          )).length > 0 && !result && (
            <div style={{marginTop:10,border:"1px solid #3A3A3A",borderRadius:8,padding:10}}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:5}}>Report parsing diagnostics</div>
              <div style={{fontSize:11,color:"#AAA",marginBottom:8}}>This is the actual text extracted from the downloaded PDF. Expand a report to inspect it; you can select the text and copy it into the chat. No data has been imported.</div>
              {data.reports.filter(r => r.status === "ok" && (
                (r.reportType === "rost" && data.preview.roster && data.preview.roster.teamCount === 0 && data.preview.roster.playerCount === 0) ||
                (r.reportType === "div" && data.preview.standings?.rows.length === 0) ||
                (r.reportType === "mvp" && data.preview.mvp?.rows.length === 0)
              )).map(r => (
                <details key={r.key} style={{marginTop:8}}>
                  <summary style={{cursor:"pointer",fontSize:11,color:"#E0E0E0"}}>{r.reportType.toUpperCase()} · {String(r.text || "").length.toLocaleString()} characters · {String(r.text || "").split("\n").length.toLocaleString()} lines</summary>
                  <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",maxHeight:360,overflowY:"auto",fontSize:10.5,lineHeight:1.45,background:"#111",padding:8,borderRadius:6,color:"#D0D0D0"}}>{String(r.text || "").slice(0,5000) || "[No extracted text returned]"}</pre>
                  {String(r.text || "").length > 5000 && <div style={{fontSize:10,color:"#AAA"}}>Showing first 5,000 characters. You can select and copy the displayed text.</div>}
                </details>
              ))}
            </div>
          )}

          {!result ? (
            <div style={{display:"flex",gap:6,marginTop:10}}>
              <button className="btn-primary" onClick={importReports} disabled={importing || (data.reports ?? []).some(r => r.status === "ok" && (
                (r.reportType === "rost" && data.preview.roster && data.preview.roster.teamCount === 0 && data.preview.roster.playerCount === 0) ||
                (r.reportType === "div" && data.preview.standings?.rows.length === 0) ||
                (r.reportType === "mvp" && data.preview.mvp?.rows.length === 0)
              ))}>
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
