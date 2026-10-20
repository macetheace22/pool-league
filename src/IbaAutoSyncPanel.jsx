import { useEffect, useRef, useState } from "react";
import { Check, Download, RefreshCw, AlertCircle, ChevronDown, ChevronUp, FileUp } from "lucide-react";
import { fetchIbaReports, fetchAllIbaReports, buildIbaPreview, validateIbaReports, importIbaReports, ibaCodesForSeason, scopeIbaReportsToSeason, ibaReportMatchesSeasonContext } from "./ibaAutoSync";
import * as db from "./db";

export default function IbaAutoSyncPanel({ season, schedule, onComplete, reportType = null, manualMode = false }) {
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [result, setResult] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [expandedPreview, setExpandedPreview] = useState({ rost: false, div: false, mvp: false });
  const [allScan, setAllScan] = useState(null);
  const [scanProgress, setScanProgress] = useState(null);
  const [scanningAll, setScanningAll] = useState(false);
  const [scanError, setScanError] = useState("");
  const [manualFile, setManualFile] = useState(null);
  const manualFileInputRef = useRef(null);
  const [manualFormat, setManualFormat] = useState("");
  const [manualDay, setManualDay] = useState("");
  const [manualError, setManualError] = useState("");
  const [uploadingManual, setUploadingManual] = useState(false);
  const [discoverySeasons, setDiscoverySeasons] = useState([]);
  const [reviewGroupKey, setReviewGroupKey] = useState("");
  const [reviewSeasonId, setReviewSeasonId] = useState("");
  const [reviewReportType, setReviewReportType] = useState(reportType || "all");
  const [reviewValidation, setReviewValidation] = useState(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewImporting, setReviewImporting] = useState(false);
  const [reviewResult, setReviewResult] = useState(null);
  const manualContexts = [...new Map((season?.divisions || [])
    .map(division => ({
      format: String(division.format || "").toLowerCase(),
      day: String(division.day || "").toLowerCase(),
    }))
    .filter(context => context.format && context.day)
    .map(context => [`${context.format}:${context.day}`, context])).values()];
  const manualFormatOptions = [...new Set(manualContexts.map(context => context.format))];
  const manualDayOptions = [...new Set(manualContexts.filter(context => context.format === manualFormat).map(context => context.day))];
  useEffect(() => {
    if (!manualContexts.length) return;
    if (!manualFormatOptions.includes(manualFormat)) {
      setManualFormat(manualContexts[0].format);
      setManualDay(manualContexts[0].day);
      return;
    }
    if (!manualDayOptions.includes(manualDay)) setManualDay(manualDayOptions[0] || manualContexts[0].day);
  }, [season?.id, manualFormat, manualDay, manualContexts.length, manualFormatOptions.join(","), manualDayOptions.join(",")]);

  useEffect(() => {
    let active = true;
    db.listSeasons()
      .then(rows => { if (active) setDiscoverySeasons(rows || []); })
      .catch(() => { if (active) setReviewError("Unable to load seasons for report mapping."); });
    return () => { active = false; };
  }, []);

  const reviewSeasonOptions = discoverySeasons.filter(target => target.is_active && (allScan?.reports || []).some(report => ibaReportMatchesSeasonContext(report, target)));
  const reviewSeason = reviewSeasonOptions.find(target => String(target.id) === String(reviewSeasonId)) || null;
  const reviewScopedReports = scopeIbaReportsToSeason(allScan?.reports || [], reviewSeason, reviewReportType);
  const reviewReadyReports = reviewScopedReports.filter(report => report.status === "ok" && Number(report.detectedRows) > 0);
  const reviewBlockedReports = reviewScopedReports.filter(report => report.status === "ok" && Number(report.detectedRows) === 0);
  const reviewMissingReports = reviewScopedReports.filter(report => report.status === "missing");
  const reviewErrorReports = reviewScopedReports.filter(report => report.status !== "ok" && report.status !== "missing");
  useEffect(() => {
    if (!allScan) return;
    if (!reviewSeasonOptions.some(target => String(target.id) === String(reviewSeasonId))) {
      setReviewSeasonId(reviewSeasonOptions.length === 1 ? String(reviewSeasonOptions[0].id) : "");
    }
    setReviewValidation(null);
    setReviewResult(null);
  }, [allScan, discoverySeasons]);

  const codes = ibaCodesForSeason(season);
  const supported = Array.isArray(codes.contexts) && codes.contexts.length > 0;
  const reportLabels = { rost: "roster & ratings", div: "team standings", mvp: "MVP standings" };
  const selectedReportLabel = reportLabels[reportType] || "weekly league data";
  const selectedReports = (reports) => reportType ? (reports ?? []).filter(r => r.reportType === reportType) : (reports ?? []);
  const previewRows = (type) => {
    const sections = (data?.preview?.sections || []).filter(section => section.reportType === type && section.status === "ok");
    if (type === "rost" && sections.length) {
      return sections.flatMap(section => Object.entries(section.parsed?.registry || {}).map(([playerNum, player]) => ({
        sourceContext: `${section.formatLabel} · ${section.dayLabel}`,
        sourceKey: section.key,
        teamNum: Object.entries(section.parsed?.rosters || {}).find(([, nums]) => nums.includes(playerNum))?.[0] || "",
        playerNum, playerName: player.name, nickname: player.nickname || "", rating: player.rating ?? "—",
      })));
    }
    if (type === "rost") {
      const parsed = data?.preview?.roster?.parsed;
      if (!parsed) return [];
      return Object.entries(parsed.registry || {}).map(([playerNum, player]) => ({
        teamNum: Object.entries(parsed.rosters || {}).find(([, nums]) => nums.includes(playerNum))?.[0] || "",
        playerNum, playerName: player.name, nickname: player.nickname || "", rating: player.rating ?? "—",
      }));
    }
    if (sections.length) return sections.flatMap(section => (section.rows || []).map(row => ({
      ...row, sourceContext: `${section.formatLabel} · ${section.dayLabel}`, sourceKey: section.key,
    })));
    if (type === "div") return data?.preview?.standings?.rows || [];
    if (type === "mvp") return data?.preview?.mvp?.rows || [];
    return [];
  };
  const hasEmptyParsedReport = (data?.reports ?? []).some(report => {
    if (report.status !== "ok") return false;
    const parsedReport = (data?.preview?.reports || []).find(item => item.key === report.key);
    return Number(parsedReport?.detectedRows ?? 0) === 0;
  });
  const columnsFor = (type) => type === "rost"
    ? [{ key:"sourceContext", label:"IBA group" }, { key:"teamNum", label:"Team" }, { key:"playerNum", label:"Player #" }, { key:"playerName", label:"Player" }, { key:"nickname", label:"Nickname" }, { key:"rating", label:"Rating" }]
    : type === "div"
      ? [{ key:"sourceContext", label:"IBA group" }, { key:"teamNum", label:"Team #" }, { key:"teamName", label:"Team" }, { key:"pointsLastWk", label:"Last week" }, { key:"totalPoints", label:"Total points" }, { key:"setsPlayed", label:"Sets played" }]
      : [{ key:"sourceContext", label:"IBA group" }, { key:"playerNum", label:"Player #" }, { key:"playerName", label:"Player" }, { key:"teamNum", label:"Team #" }, { key:"wins", label:"Sets won" }, { key:"mvpRankingPoints", label:"MVP points" }, { key:"losses", label:"Sets lost" }, { key:"pointsScored", label:"Points scored" }];

  const fetchReports = async () => {
    setLoading(true); setError(""); setResult(null); setPreflight(null);
    try {
      const fetched = await fetchIbaReports(season, reportType);
      const reports = selectedReports(fetched.reports);
      const preview = await buildIbaPreview(reports);
      setData({ ...fetched, reports, preview });
    } catch (e) {
      setError(e?.message || "Unable to retrieve IBA reports.");
    } finally { setLoading(false); }
  };

  const scanAllReports = async () => {
    setScanningAll(true);
    setScanError("");
    setAllScan(null);
    setScanProgress({ completedGroups: 0, totalGroups: 21, reports: 0 });
    try {
      const fetched = await fetchAllIbaReports(setScanProgress);
      const reports = await Promise.all((fetched.reports || []).map(async report => {
        if (report.status !== "ok") return { ...report, detectedRows: null, reportWeek: null };
        const preview = await buildIbaPreview([report]);
        const reportWeek = preview.reports?.[0]?.reportWeek || null;
        const detectedRows = report.reportType === "rost"
          ? (preview.roster?.playerCount || 0)
          : report.reportType === "div"
            ? (preview.standings?.rows?.length || 0)
            : (preview.mvp?.rows?.length || 0);
        const teamCount = report.reportType === "rost" ? (preview.roster?.teamCount || 0) : null;
        return { ...report, detectedRows, teamCount, reportWeek };
      }));
      setAllScan({ generatedAt: fetched.generatedAt, reports });
    } catch (e) {
      setScanError(e?.message || "Unable to scan all IBA reports.");
    } finally {
      setScanningAll(false);
    }
  };

  const uploadManualPdf = async () => {
    if (!manualFile || !reportType) return;
    setUploadingManual(true);
    setManualError("");
    setError("");
    setResult(null);
    setPreflight(null);
    try {
      if (manualFile.type && manualFile.type !== "application/pdf" && !manualFile.name.toLowerCase().endsWith(".pdf")) {
        throw new Error("Choose a PDF file.");
      }
      const pdfBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read the selected file."));
        reader.onload = () => {
          const value = String(reader.result || "");
          const comma = value.indexOf(",");
          resolve(comma >= 0 ? value.slice(comma + 1) : "");
        };
        reader.readAsDataURL(manualFile);
      });
      const response = await fetch("/api/iba-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "manual-upload", leagueType: ({ masters: "mast", advanced: "adv", open: "open" })[manualFormat] || manualFormat, day: ({ monday: "mon", tuesday: "tues", wednesday: "wed", thursday: "thur", friday: "fri", saturday: "sat", sunday: "sun" })[manualDay] || manualDay, reportType, pdfBase64 }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Unable to extract the uploaded PDF.");
      const reports = selectedReports(body.reports || []);
      const preview = await buildIbaPreview(reports);
      setData({ ...body, reports, preview });
      if (reports[0]?.status !== "ok") setManualError("The PDF was received, but no searchable text was extracted. It may be scanned/image-only.");
      setManualFile(null);
    } catch (e) {
      setManualError(e?.message || "Unable to process the selected PDF.");
    } finally {
      setUploadingManual(false);
    }
  };

  const importReports = async () => {
    if (!data?.reports) return;
    setImporting(true); setError("");
    try {
      const reportsToImport = selectedReports(data.reports);
      const validation = await validateIbaReports(reportsToImport, season);
      setPreflight(validation);
      if (!validation.canImport) {
        setError("Import blocked. Review the per-division validation results below; no report data was written.");
        return;
      }
      const imported = await importIbaReports(reportsToImport, season, schedule, validation);
      setResult(imported);
      if (onComplete) await onComplete();
    } catch (e) {
      setError(e?.message || "Unable to import IBA reports.");
    } finally { setImporting(false); }
  };

  return (
    <div className="card" style={{marginBottom:12}}>
      <style>{`
        .manual-pdf-controls{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin-top:10px;align-items:start}
        .manual-pdf-field{display:grid;gap:5px;min-width:0;font-size:11px;color:#CCC}
        .manual-pdf-field select{min-height:38px}
        .manual-pdf-choose-button{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;min-width:0;min-height:38px;box-sizing:border-box;cursor:pointer;font:inherit;color:#E0E0E0;text-align:center}
        .manual-pdf-choose-button:hover:not(:disabled){border-color:#5FCF9E;color:#5FCF9E}
        .manual-pdf-native-input{display:none}
        .manual-pdf-filename{font-size:10.5px;color:#AAA;overflow-wrap:anywhere;min-height:14px}
        .manual-pdf-filename--empty{color:#666}
        @media(min-width:760px){.manual-pdf-controls{grid-template-columns:repeat(3,minmax(0,1fr))}}
      `}</style>
      <div className="card__title" style={{display:"flex",alignItems:"center",gap:7}}>
        <Download size={14}/> {manualMode ? `Manual PDF Import · ${reportLabels[reportType] || reportType}` : reportType ? `Automatic IBA Sync · ${reportLabels[reportType] || reportType}` : "Automatic IBA Report Sync"}
      </div>
      <div style={{fontSize:12,color:"#9A9A9A",lineHeight:1.5}}>
        {manualMode ? "Upload a PDF for the selected report type. Choose only a format/day represented by this season; the report week and schedule are validated before import." : <>Checks IBA reports across all configured formats and days{reportType ? ` for ${selectedReportLabel}` : " across roster/ratings, team standings, and MVP standings"}. Each report is validated against the matching division schedule before import. A report may be missing when that league is not playing.</>}
      </div>
      {!reportType && <div style={{fontSize:11.5,color:"#D0D0D0",lineHeight:1.5,marginTop:8,padding:"8px 10px",background:"#141414",border:"1px solid #2A2A2A",borderRadius:8}}>
        <strong style={{color:"#E0E0E0"}}>What this sync covers:</strong> roster/ratings, IBA team-standings reports, and IBA MVP reports. It does not import playoff eligibility; use season management for that manual-only report. Imported IBA standings and MVP reports are source snapshots, distinct from the app's computed standings and MVP results.
      </div>}
      {!manualMode && (
        <section style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #303030" }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>Scan all formats and days</div>
          <div style={{ fontSize: 11, color: "#AAA", lineHeight: 1.5, marginTop: 4 }}>
            Scan Masters, Advanced, and Open across all seven days. Discovery is read-only; review matching reports for the selected season, either together or by report category.
          </div>
          <button className="btn-sm" onClick={scanAllReports} disabled={scanningAll} style={{ marginTop: 8 }}>
            {scanningAll ? <><RefreshCw size={12} className="spin" /> Scanning {scanProgress?.completedGroups || 0}/{scanProgress?.totalGroups || 21} format/day combinations…</> : "Scan All IBA Formats & Days"}
          </button>
          {scanError && <div className="error-msg" style={{ marginTop: 8 }}>{scanError}</div>}
          {allScan && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 11, marginBottom: 8 }}>
                <span>{allScan.reports.length} reports checked</span>
                <span>· {allScan.reports.filter(r => r.status === "ok").length} available</span>
                <span>· {allScan.reports.filter(r => r.status === "missing").length} missing</span>
                <span>· {allScan.reports.filter(r => r.status !== "ok" && r.status !== "missing").length} errors/empty</span>
                <span>· {allScan.reports.filter(r => r.status === "ok" && r.detectedRows === 0).length} with zero parsed rows</span>
              </div>
              <section style={{ margin: "10px 0", padding: 10, border: "1px solid #3A3A3A", borderRadius: 7 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Review & import across the selected season</div>
                <div style={{ fontSize: 11, color: "#AAA", lineHeight: 1.5, marginTop: 4 }}>
                  Review all three report categories together or focus on one category across all matching formats and days. Each report is matched to the season's divisions and checked against its schedule and import history. Missing PDFs are normal; extraction errors and zero-row reports block the batch.
                </div>
                <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                  <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#CCC" }}>
                    Import scope
                    <select className="input" value={reviewReportType} onChange={e => { setReviewReportType(e.target.value); setReviewValidation(null); setReviewResult(null); setReviewError(""); }} style={{ width: "100%" }}>
                      <option value="all">All categories — full season</option><option value="rost">Roster & ratings — full season</option><option value="div">Team standings — full season</option><option value="mvp">MVP standings — full season</option>
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 4, fontSize: 11, color: "#CCC" }}>
                    Target season
                    <select className="input" value={reviewSeasonId} onChange={e => { setReviewSeasonId(e.target.value); setReviewValidation(null); setReviewResult(null); setReviewError(""); }} style={{ width: "100%" }}>
                      <option value="">Select target season…</option>
                      {reviewSeasonOptions.map(target => <option key={target.id} value={String(target.id)}>{target.type} {target.year} · {(target.divisions || []).length} division(s)</option>)}
                    </select>
                  </label>
                </div>
                <div style={{ fontSize: 11, color: "#CCC", marginTop: 8 }}>
                  {reviewScopedReports.filter(report => report.status === "ok").length} extracted · {reviewReadyReports.length} eligible with rows · {reviewBlockedReports.length} zero-row blocked · {reviewMissingReports.length} missing (allowed) · {reviewErrorReports.length} extraction/fetch error(s)
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                  {reviewScopedReports.map(report => {
                    const blocked = report.status === "ok" && report.detectedRows === 0;
                    const failed = report.status !== "ok" && report.status !== "missing";
                    const label = report.reportLabel || report.reportType.toUpperCase();
                    const status = blocked ? "NOT IMPORTED · 0 ROWS" : failed ? "ERROR" : report.status === "missing" ? "MISSING · SKIPPED" : "READY";
                    const detail = blocked
                      ? "No usable rows were extracted. This report is blocked from import."
                      : failed
                        ? (report.message || "Report retrieval or extraction failed.")
                        : report.status === "missing"
                          ? "No report was returned for this format/day/category; missing reports are allowed."
                          : `${report.detectedRows} rows${report.reportWeek?.weekNumber ? ` · Week ${report.reportWeek.weekNumber}` : ""}`;
                    return <div key={report.key} role="status" style={{ border: `1px solid ${blocked || failed ? "#8A5A16" : "#3A3A3A"}`, borderRadius: 7, padding: "7px 9px", background: blocked || failed ? "#30230F" : "#1C1C1C" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 5 }}>
                        <span style={{ color: "#F0F0F0", fontWeight: 700 }}>{report.formatLabel} · {report.dayLabel} · {label}</span>
                        <span style={{ color: blocked || failed ? "#F59E0B" : report.status === "missing" ? "#AAA" : "#5FCF9E", fontWeight: 700 }}>{status}</span>
                      </div>
                      <div style={{ color: blocked || failed ? "#F0C27A" : "#AAA", marginTop: 3, lineHeight: 1.45 }}>{detail}</div>
                    </div>;
                  })}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  <button className="btn-primary" disabled={!reviewSeason || reviewReadyReports.length === 0 || reviewBlockedReports.length > 0 || reviewErrorReports.length > 0 || reviewLoading || reviewImporting} onClick={async () => {
                    setReviewLoading(true); setReviewError(""); setReviewValidation(null); setReviewResult(null);
                    try {
                      const validation = await validateIbaReports(reviewScopedReports, reviewSeason);
                      setReviewValidation(validation);
                      if (!validation.canImport) setReviewError("Preflight blocked this season-wide batch. Review each division result; no data was written.");
                    } catch (e) {
                      setReviewError(e?.message || "Could not validate the selected season reports.");
                    } finally { setReviewLoading(false); }
                  }}>
                    {reviewLoading ? "Validating…" : "Validate full-season selection"}
                  </button>
                  <button className="btn-primary" disabled={!reviewValidation?.canImport || reviewReadyReports.length === 0 || reviewBlockedReports.length > 0 || reviewErrorReports.length > 0 || !reviewSeason || reviewImporting || reviewLoading} onClick={async () => {
                    setReviewImporting(true); setReviewError(""); setReviewResult(null);
                    try {
                      const result = await importIbaReports(reviewScopedReports, reviewSeason, [], reviewValidation);
                      setReviewResult(result);
                      if (onComplete) await onComplete();
                    } catch (e) {
                      setReviewError(`Import failed. Some writes may already have succeeded; verify data and import history for each matching division before retrying. ${e?.message || ""}`);
                    } finally { setReviewImporting(false); }
                  }}>
                    {reviewImporting ? "Importing…" : "Import validated selection"}
                  </button>
                </div>
                {reviewValidation && (
                  <div style={{ marginTop: 10, borderTop: "1px solid #303030", paddingTop: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700 }}>Per-division preflight</div>
                    {reviewValidation.checks.map((check, index) => <div key={check.key || index} style={{ fontSize: 10.5, color: check.status === "ready" || check.status === "duplicate" ? "#5FCF9E" : "#F0C36D", marginTop: 4 }}>
                      {check.reportType.toUpperCase()} · Division {check.divisionNum}: {check.status} — {check.reason}{Number.isFinite(check.parsedRowCount) ? ` (${check.parsedRowCount} matching record(s))` : ""}
                    </div>)}
                    {reviewValidation.reportFailures?.filter(failure => failure.status !== "missing").map((failure, index) => <div key={index} style={{ fontSize: 10.5, color: "#F0C36D", marginTop: 4 }}>{failure.reportType.toUpperCase()}: {failure.status} — {failure.reason}</div>)}
                  </div>
                )}
                {reviewError && <div className="error-msg" style={{ marginTop: 8 }}>{reviewError}</div>}
                {reviewResult && (
                  <div style={{ fontSize: 11, color: "#5FCF9E", marginTop: 8, padding: 8, border: "1px solid #315B49", borderRadius: 6 }}>
                    <strong>Import operation finished.</strong>
                    {reviewResult.roster && <div>Roster & ratings: {(reviewResult.roster.updatedDivisions || []).length} division(s) updated{reviewResult.roster.skippedDuplicates ? " · exact duplicate skipped" : ""}.</div>}
                    {reviewResult.standings && <div>Team standings: {reviewResult.standings.imported || 0} row(s) imported{reviewResult.standings.skipped?.length ? ` · ${reviewResult.standings.skipped.length} unmatched/ambiguous row(s) skipped` : ""}.</div>}
                    {reviewResult.mvp && <div>MVP standings: {reviewResult.mvp.imported || 0} row(s) imported{reviewResult.mvp.skipped?.length ? ` · ${reviewResult.mvp.skipped.length} unmatched/ambiguous row(s) skipped` : ""}.</div>}
                    {(reviewResult.warnings || []).map((warning, index) => <div key={index} style={{ color: "#F0C36D" }}>{warning}</div>)}
                    <div style={{ color: "#AAA", marginTop: 4 }}>Review this result before another import. If any error was reported, verify each matching division's data and import history before retrying.</div>
                  </div>
                )}
              </section>
              <div style={{ maxHeight: 440, overflowY: "auto", border: "1px solid #303030", borderRadius: 7 }}>
                {allScan.reports.map(report => {
                  const zeroRows = report.status === "ok" && report.detectedRows === 0;
                  const statusColor = report.status === "ok" && !zeroRows ? "#5FCF9E" : report.status === "missing" ? "#999" : "#F0C36D";
                  return (
                    <details key={report.key} style={{ padding: "8px 10px", borderBottom: "1px solid #292929" }}>
                      <summary style={{ cursor: "pointer", fontSize: 11, color: statusColor }}>
                        <strong>{report.formatLabel} · {report.dayLabel}</strong> — {report.reportType.toUpperCase()} · {report.status}
                        {report.status === "ok" ? ` · ${report.detectedRows} ${report.reportType === "rost" ? "players" : "rows"}${report.reportType === "rost" ? ` / ${report.teamCount} teams` : ""}${report.reportWeek?.weekNumber ? ` · Week ${report.reportWeek.weekNumber}` : report.reportWeek?.ambiguous ? " · Week needs review" : report.reportWeek?.missing ? " · Week not detected" : ""}` : ""}
                        {zeroRows ? " · REVIEW: zero rows parsed" : ""}
                      </summary>
                      <div style={{ fontSize: 10.5, color: "#AAA", marginTop: 6 }}>
                        {report.reportWeek?.missing ? "Report week not detected." : report.reportWeek?.ambiguous ? `Ambiguous report weeks: ${(report.reportWeek.weekNumbers || []).join(", ")}.` : report.reportWeek?.weekNumber ? `Week ${report.reportWeek.weekNumber} detected.` : ""}
                        {report.message ? ` ${report.message}` : ""}
                        {report.status === "ok" && <div style={{ marginTop: 4 }}>PDF: {report.key}.pdf · {report.pages || "?"} pages · {report.bytes?.toLocaleString() || "?"} bytes</div>}
                      </div>
                      {report.status === "ok" && zeroRows && (
                        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflowY: "auto", fontSize: 10, lineHeight: 1.4, background: "#111", padding: 7, borderRadius: 5, color: "#D0D0D0", marginTop: 7 }}>{String(report.text || "").slice(0, 3000) || "[No extracted text returned]"}</pre>
                      )}
                    </details>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}
      {reportType && manualMode && (
        <section style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #303030" }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>Upload PDF</div>
          <div style={{ fontSize: 11, color: "#AAA", lineHeight: 1.5, marginTop: 4 }}>
            Upload a PDF for this report category to extract and preview it. This step does not write to the database. Import still uses the selected season and its validation checks. The consolidated review flow imports one report category at a time.
          </div>
          <div className="manual-pdf-controls">
            <label className="manual-pdf-field">
              <span>Format</span>
              <select className="input" value={manualFormat} onChange={e => { setManualFormat(e.target.value); setManualError(""); setData(null); setPreflight(null); setResult(null); setError(""); }} style={{width:"100%"}}>
                {manualFormatOptions.map(format => <option key={format} value={format}>{({ masters: "Masters", advanced: "Advanced", open: "Open" })[format] || format}</option>)}
              </select>
            </label>
            <label className="manual-pdf-field">
              <span>Day</span>
              <select className="input" value={manualDay} onChange={e => { setManualDay(e.target.value); setManualError(""); setData(null); setPreflight(null); setResult(null); setError(""); }} style={{width:"100%"}}>
                {manualDayOptions.map(day => <option key={day} value={day}>{day.charAt(0).toUpperCase() + day.slice(1)}</option>)}
              </select>
            </label>
            <div className="manual-pdf-field manual-pdf-file">
              <span>PDF File</span>
              <input
                ref={manualFileInputRef}
                className="manual-pdf-native-input"
                type="file"
                accept="application/pdf,.pdf"
                onChange={e => { setManualFile(e.target.files?.[0] || null); setManualError(""); }}
              />
              <button type="button" className="input manual-pdf-choose-button" onClick={() => manualFileInputRef.current?.click()}>
                <FileUp size={14} /> Choose PDF…
              </button>
              <span className={`manual-pdf-filename ${manualFile ? "" : "manual-pdf-filename--empty"}`}>
                {manualFile ? `${manualFile.name} · ${Math.ceil(manualFile.size / 1024).toLocaleString()} KB` : "No file selected"}
              </span>
            </div>
          </div>
          <button className="btn-primary" onClick={uploadManualPdf} disabled={!manualFile || uploadingManual || !supported || !manualFormatOptions.length || !manualDayOptions.length} style={{ marginTop: 10 }}>
            {uploadingManual ? <><RefreshCw size={12} className="spin" /> Extracting PDF…</> : "Extract & Preview PDF"}
          </button>
          {manualError && <div className="error-msg" style={{ marginTop: 8 }}>{manualError}</div>}
        </section>
      )}
      {!supported && <div className="import-warning-block"><div className="import-warning-block__title"><AlertCircle size={12}/> Import the IBA schedule for this season first so its divisions have format/day context.</div></div>}

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
            const rows = previewRows(r.reportType).filter(row => row.sourceKey === r.key);
            const columns = columnsFor(r.reportType);
            const parsedReport = data.preview.reports.find(item => item.key === r.key);
            const count = Number(parsedReport?.detectedRows ?? rows.length);
            const empty = count === 0;
            return (
              <section key={r.key} style={{marginTop:12,border:"1px solid #353535",borderRadius:9,overflow:"hidden"}}>
                <button type="button" className="btn-sm" onClick={() => setExpandedPreview(v => ({...v,[r.key]:!v[r.key]}))} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"10px 12px",borderRadius:0}}>
                  <span style={{textAlign:"left"}}>{r.reportType.toUpperCase()} parsed preview · {count.toLocaleString()} {r.reportType === "rost" ? "players" : "rows"}{r.reportType === "rost" ? ` across ${data.preview.roster?.teamCount || 0} teams` : ""}</span>
                  {expandedPreview[r.key] ? <ChevronUp size={15}/> : <ChevronDown size={15}/>}
                </button>
                {(() => {
                  const reportMetadata = data.preview.reports.find(item => item.key === r.key);
                  const metadata = reportMetadata?.reportWeek;
                  const divisionWeeks = Object.entries(reportMetadata?.reportWeeksByDivision?.byDivision || {});
                  if (!metadata) return null;
                  return (
                    <div style={{padding:"7px 10px",fontSize:11,color:metadata.missing || metadata.ambiguous ? "#F0C36D" : "#AAA",borderTop:"1px solid #292929"}}>
                      <div>{metadata.missing ? "Report week not detected" : metadata.ambiguous ? `Multiple week labels found (${metadata.weekNumbers.join(", ")}); verify each division before importing` : `Week ${metadata.weekNumber} detected in PDF text`}</div>
                      {divisionWeeks.length > 0 && (
                        <div style={{display:"grid",gap:3,marginTop:6}}>
                          {divisionWeeks.map(([divisionNum, division]) => (
                            <div key={divisionNum} style={{color:division.missing || division.ambiguous ? "#F0C36D" : "#AFAFAF"}}>
                              Division {divisionNum} · {division.divisionLabel}: {division.missing ? "week not detected" : division.ambiguous ? `conflicting weeks ${division.weekNumbers.join(", ")}` : `Week ${division.weekNumber}`}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {expandedPreview[r.key] && (
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

          {hasEmptyParsedReport && !result && (
            <div style={{marginTop:10,border:"1px solid #3A3A3A",borderRadius:8,padding:10}}>
              <div style={{fontSize:12,fontWeight:700,marginBottom:5}}>Report parsing diagnostics</div>
              <div style={{fontSize:11,color:"#AAA",marginBottom:8}}>This is the actual text extracted from the downloaded PDF. Expand a report to inspect it; you can select the text and copy it into the chat. No data has been imported.</div>
              {(data.reports ?? []).filter(r => r.status === "ok" && (data.preview.reports || []).some(item => item.key === r.key && Number(item.detectedRows ?? 0) === 0)).map(r => (
                <details key={r.key} style={{marginTop:8}}>
                  <summary style={{cursor:"pointer",fontSize:11,color:"#E0E0E0"}}>{r.reportType.toUpperCase()} · {String(r.text || "").length.toLocaleString()} characters · {String(r.text || "").split("\n").length.toLocaleString()} lines</summary>
                  <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",maxHeight:360,overflowY:"auto",fontSize:10.5,lineHeight:1.45,background:"#111",padding:8,borderRadius:6,color:"#D0D0D0"}}>{String(r.text || "").slice(0,5000) || "[No extracted text returned]"}</pre>
                  {String(r.text || "").length > 5000 && <div style={{fontSize:10,color:"#AAA"}}>Showing first 5,000 characters. You can select and copy the displayed text.</div>}
                </details>
              ))}
            </div>
          )}

          {preflight && (
            <div className="import-warning-block" style={{marginTop:10}}>
              <div className="import-warning-block__title"><AlertCircle size={12}/> Import validation results</div>
              <div style={{fontSize:11,color:"#D0D0D0"}}>Every report is checked against each division's schedule and saved import history before any data is written. Changed reports, missing weeks, schedule mismatches, and unavailable history block the batch. Exact duplicate divisions are skipped while other validated divisions can import.</div>
              {preflight.reportFailures.map((item,i)=><div key={`failure-${i}`} style={{fontSize:11,color:"#F0C36D"}}>{item.reportType.toUpperCase()}: {item.reason}</div>)}
              <div style={{display:"grid",gap:6,marginTop:5}}>
                {preflight.checks.map(check=>(
                  <div key={check.key} style={{borderTop:"1px solid #3A3A3A",paddingTop:5,fontSize:11,color:check.status==="ready"?"#5FCF9E":check.status==="duplicate"?"#9A9A9A":"#F0C36D"}}>
                    <strong>{check.reportType.toUpperCase()} · Division {check.divisionNum} {check.divisionName || ""}</strong> · {check.weekNumber ? `Week ${check.weekNumber}` : "week unknown"} · {check.status}
                    <div style={{color:"#AAA",marginTop:2}}>{check.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!result ? (
            <div style={{display:"flex",gap:6,marginTop:10}}>
              <button className="btn-primary" onClick={importReports} disabled={importing || (preflight && !preflight.canImport) || hasEmptyParsedReport}>
                {importing ? "Importing…" : manualMode ? "Import Manual PDF" : "Import Retrieved Reports"}
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
              {(result.skippedDuplicateDivisions?.length || result.warnings?.length || result.standings?.skipped?.length || result.mvp?.skipped?.length) ? (
                <div style={{fontSize:10.5,color:"#F59E0B",marginTop:5}}>
                  Review warnings: {[...(result.skippedDuplicateDivisions||[]).map(x=>`Skipped duplicate ${x}`), ...(result.warnings||[]), ...((result.standings?.skipped||[]).map(x=>`Standings Team ${x.teamNum}: ${x.reason}`)), ...((result.mvp?.skipped||[]).map(x=>`MVP Team ${x.teamNum}: ${x.reason}`))].join(" · ")}
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
