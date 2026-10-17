import crypto from "node:crypto";
import pdfParse from "pdf-parse";

const BASE = "https://ibapool.com/Content/Pdfs";
const LEAGUE_TYPES = ["mast", "adv", "open"];
const DAYS = ["mon", "tues", "wed", "thur", "fri", "sat", "sun"];
const REPORT_TYPES = ["rost", "div", "mvp"];
const MAX_BATCH = 63;
const TIMEOUT_MS = 15000;

function expectedReports(leagueType, day) {
  return REPORT_TYPES.map(reportType => ({ leagueType, day, reportType,
    key: `${leagueType}${day}${reportType}`,
    url: `${BASE}/${leagueType}${day}${reportType}.pdf`,
  }));
}

function normalizeCandidates(body = {}) {
  if (Array.isArray(body.reports) && body.reports.length) {
    return body.reports.slice(0, MAX_BATCH).map(r => {
      const leagueType = String(r.leagueType || "").toLowerCase();
      const day = String(r.day || "").toLowerCase();
      const reportType = String(r.reportType || "").toLowerCase();
      if (!LEAGUE_TYPES.includes(leagueType) || !DAYS.includes(day) || !REPORT_TYPES.includes(reportType)) return null;
      return { leagueType, day, reportType, key: `${leagueType}${day}${reportType}`, url: `${BASE}/${leagueType}${day}${reportType}.pdf` };
    }).filter(Boolean);
  }
  const leagueType = String(body.leagueType || "").toLowerCase();
  const day = String(body.day || "").toLowerCase();
  if (LEAGUE_TYPES.includes(leagueType) && DAYS.includes(day)) return expectedReports(leagueType, day);
  return [];
}

async function fetchOne(report) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(report.url, {
        signal: controller.signal,
        headers: { "User-Agent": "MacesPoolLeague/IBA-Report-Sync" },
      });
      if (response.status === 404 || response.status === 204) return { ...report, status: "missing", httpStatus: response.status };
      if (!response.ok) {
        lastError = new Error(`IBA returned HTTP ${response.status}`);
        if (response.status < 500) return { ...report, status: "error", httpStatus: response.status, message: lastError.message };
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) return { ...report, status: "missing", httpStatus: response.status };
      if (buffer.subarray(0, 4).toString() !== "%PDF") return { ...report, status: "error", httpStatus: response.status, message: "Response was not a PDF" };
      const digest = crypto.createHash("sha256").update(buffer).digest("hex");
      const parsed = await pdfParse(buffer);
      const text = String(parsed.text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!text.trim()) return { ...report, status: "empty", httpStatus: response.status, bytes: buffer.length, sha256: digest, pages: parsed.numpages || null };
      return { ...report, status: "ok", httpStatus: response.status, bytes: buffer.length, sha256: digest, pages: parsed.numpages || null, text };
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ...report, status: "error", message: lastError?.name === "AbortError" ? "Timed out fetching report" : (lastError?.message || "Unable to fetch report") };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST required" });
  }

  // Manual single-PDF upload uses the same server-side PDF extraction and SHA-256
  // fingerprint as automatic retrieval, so both paths produce the same report shape.
  if (req.body?.action === "manual-upload") {
    const { leagueType, day, reportType } = req.body;
    if (!LEAGUE_TYPES.includes(String(leagueType || "").toLowerCase()) ||
        !DAYS.includes(String(day || "").toLowerCase()) ||
        !REPORT_TYPES.includes(String(reportType || "").toLowerCase())) {
      return res.status(400).json({ error: "Choose a valid format, day, and report category." });
    }
    const encoded = String(req.body?.pdfBase64 || "");
    if (!encoded || encoded.length > 4_000_000) {
      return res.status(413).json({ error: "PDF is empty or too large. Choose a PDF smaller than about 3 MB." });
    }
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.subarray(0, 4).toString() !== "%PDF") {
      return res.status(400).json({ error: "The selected file is not a valid PDF." });
    }
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    try {
      const parsed = await pdfParse(buffer);
      const text = String(parsed.text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const report = {
        leagueType, day, reportType,
        key: `${leagueType}${day}${reportType}`,
        status: text.trim() ? "ok" : "empty",
        httpStatus: 200, bytes: buffer.length, sha256: digest,
        pages: parsed.numpages || null, text,
        source: "manual",
      };
      return res.status(200).json({ generatedAt: new Date().toISOString(), reports: [report] });
    } catch (error) {
      return res.status(400).json({ error: `Could not read the PDF: ${error?.message || "PDF extraction failed"}` });
    }
  }

  const reports = normalizeCandidates(req.body || {});
  if (!reports.length) return res.status(400).json({ error: "Provide a valid leagueType/day or report list" });

  const results = [];
  for (let i = 0; i < reports.length; i += 4) {
    const batch = reports.slice(i, i + 4);
    results.push(...await Promise.all(batch.map(fetchOne)));
  }
  return res.status(200).json({ generatedAt: new Date().toISOString(), reports: results });
}
