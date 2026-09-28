const BASE_URL = "https://ibapool.com/League/Schedules/m8-pool-league";
const FORMATS = ["Open", "Advanced", "Masters"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIMEOUT_MS = 15000;

function norm(v = "") {
  return String(v).replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&#x2F;/gi, "/").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : "";
}
function parseSelects(html) {
  const out = [];
  const re = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m;
  while ((m = re.exec(html))) {
    const head = m[1], body = m[2];
    const name = attr(head, "name") || attr(head, "id");
    if (!name) continue;
    const options = [];
    const ore = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let o;
    while ((o = ore.exec(body))) {
      const oh = o[1];
      options.push({ value: attr(oh, "value"), label: norm(o[2]), selected: /\bselected\b/i.test(oh) });
    }
    out.push({ name, id: attr(head, "id"), options });
  }
  return out;
}
function parseHiddenInputs(html) {
  const out = {};
  const re = /<input\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const type = (attr(m[1], "type") || "text").toLowerCase();
    if (type !== "hidden") continue;
    const name = attr(m[1], "name");
    if (name) out[name] = attr(m[1], "value");
  }
  return out;
}
function formInfo(html) {
  const m = html.match(/<form\b([^>]*)>/i);
  if (!m) return { action: BASE_URL, method: "GET", hidden: {} };
  return { action: attr(m[1], "action") || BASE_URL, method: (attr(m[1], "method") || "GET").toUpperCase(), hidden: parseHiddenInputs(html) };
}
function absoluteUrl(base, action) {
  try { return new URL(action, base).toString(); } catch { return base; }
}
function findSelect(selects, labels) {
  const wanted = labels.map(x => x.toLowerCase());
  return selects.find(s => {
    const hits = s.options.filter(o => wanted.includes(o.label.toLowerCase()));
    return hits.length >= Math.min(2, wanted.length);
  }) || null;
}
function findDivisionSelect(selects, formatSelect, daySelect) {
  const excluded = new Set([formatSelect?.name, daySelect?.name]);
  return selects
    .filter(s => !excluded.has(s.name))
    .map(s => ({ s, options: s.options.filter(o => o.value || o.label) }))
    .sort((a,b) => b.options.length - a.options.length)[0]?.s || null;
}
function optionFor(select, wanted) {
  if (!select) return null;
  const n = String(wanted || "").toLowerCase();
  return select.options.find(o => o.label.toLowerCase() === n)
    || select.options.find(o => o.value.toLowerCase() === n)
    || select.options.find(o => o.label.toLowerCase().includes(n));
}
async function fetchHtml(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal, headers: { "User-Agent": "MacesPoolLeague/IBA-Schedule-Sync", ...(init.headers || {}) } });
    const html = await r.text();
    return { status: r.status, html, url: r.url };
  } finally { clearTimeout(timer); }
}
function directCandidates(format, day, division = null) {
  const candidates = [];
  const combos = [
    ["Format", "Night", "Division"],
    ["format", "night", "division"],
    ["leagueFormat", "leagueDay", "division"],
    ["leagueType", "day", "division"],
  ];
  for (const [f,d,v] of combos) {
    const u = new URL(BASE_URL);
    u.searchParams.set(f, format); u.searchParams.set(d, day);
    if (division != null) u.searchParams.set(v, division);
    candidates.push(u.toString());
  }
  return candidates;
}

function requestForSelection(page, format, day, division, formHtml = page.html) {
  const selects = parseSelects(formHtml);
  const fs = findSelect(selects, FORMATS);
  const ds = findSelect(selects, DAYS);
  const vs = findDivisionSelect(selects, fs, ds);
  const info = formInfo(formHtml);
  const values = { ...info.hidden };
  if (fs) { const o = optionFor(fs, format); if (o) values[fs.name] = o.value; }
  if (ds) { const o = optionFor(ds, day); if (o) values[ds.name] = o.value; }
  if (vs && division != null) { const o = optionFor(vs, division); if (o) values[vs.name] = o.value; }
  const target = absoluteUrl(BASE_URL, info.action);
  if (info.method === "POST") {
    return { url: target, init: { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString() } };
  }
  const u = new URL(target);
  Object.entries(values).forEach(([k,v]) => u.searchParams.set(k, v));
  return { url: u.toString(), init: { method: "GET" } };
}
function stripScripts(html) { return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, ""); }
function cellsFromRow(rowHtml) {
  return [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => norm(m[1]));
}
function parseTables(html) {
  const tables = [];
  const tre = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tre.exec(html))) {
    const rows = [];
    const rre = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rre.exec(tm[1]))) { const cells = cellsFromRow(rm[1]); if (cells.length) rows.push(cells); }
    if (rows.length) tables.push(rows);
  }
  return tables;
}
function parseScheduleHtml(html) {
  const clean = stripScripts(html);
  const tables = parseTables(clean);
  let teamTable = null, scheduleTable = null;
  for (const rows of tables) {
    const header = rows[0].map(norm).join(" | ").toLowerCase();
    if (/team\s*#/.test(header) && /name/.test(header)) teamTable = rows;
    if (/week/.test(header) && /date/.test(header) && /pairings/.test(header)) scheduleTable = rows;
  }
  const teams = [];
  if (teamTable) {
    for (const row of teamTable.slice(1)) {
      const [teamNum, name, venue] = row;
      if (/^\d{3,6}$/.test(teamNum || "") && name && !/^name$/i.test(name)) teams.push({ teamNum, name, venue: venue || "", isBye: /\bbye\b/i.test(name) });
    }
  }
  const weeks = [];
  if (scheduleTable) {
    for (const row of scheduleTable.slice(1)) {
      if (!row.length) continue;
      const week = /^\d+$/.test(row[0]) ? Number(row[0]) : null;
      const date = row[1] || "";
      const pairText = row.slice(2).join(" ");
      const special = pairText && !/\d+\s*vs\s*\d+/i.test(pairText) ? pairText : "";
      const pairings = [];
      for (const m of pairText.matchAll(/(\d+)\s*vs\s*(\d+)/gi)) pairings.push({ home: Number(m[1]), away: Number(m[2]) });
      if (week != null || date || special) weeks.push({ week, date, pairings, ...(special ? { special } : {}) });
    }
  }
  if (!teams.length || !weeks.length) {
    // Fallback to visible text. This also makes the importer resilient if IBA
    // changes table markup while retaining the same text layout.
    const text = clean.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const teamMatches = [...text.matchAll(/(\d{5})\s+([^|]{2,60}?)(?=\s+\d{5}\s+|$)/g)];
    for (const m of teamMatches.slice(0, 100)) {
      const name = m[2].trim();
      if (name && !/^(Team|Name|Location)$/i.test(name) && !teams.some(t => t.teamNum === m[1])) teams.push({ teamNum: m[1], name, venue: "", isBye: /\bbye\b/i.test(name) });
    }
  }
  return { teams, weeks, hasSchedule: teams.length > 0 && weeks.length > 0 };
}

function parseSelectDiagnostics(html) {
  const out = [];
  const re = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m;
  while ((m = re.exec(html))) {
    const head = m[1], body = m[2];
    const options = [];
    const ore = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
    let o;
    while ((o = ore.exec(body))) {
      options.push({
        value: attr(o[1], "value"),
        label: norm(o[2]),
        selected: /\bselected\b/i.test(o[1])
      });
    }
    out.push({
      name: attr(head, "name"),
      id: attr(head, "id"),
      className: attr(head, "class"),
      onchange: attr(head, "onchange"),
      dataUrl: attr(head, "data-url"),
      dataAction: attr(head, "data-action"),
      dataTarget: attr(head, "data-target"),
      options
    });
  }
  return out;
}

function parseFormsDiagnostics(html) {
  const forms = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html))) {
    const head = m[1];
    forms.push({
      action: attr(head, "action") || BASE_URL,
      method: (attr(head, "method") || "GET").toUpperCase(),
      id: attr(head, "id"),
      name: attr(head, "name"),
      className: attr(head, "class")
    });
  }
  return forms;
}

function parseScriptDiagnostics(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const head = m[1];
    const src = attr(head, "src");
    const body = (m[2] || "").replace(/\s+/g, " ").trim();
    const interesting = /ajax|fetch\s*\(|\.get\s*\(|\.post\s*\(|XMLHttpRequest|onchange|schedule|division|league/i.test(body);
    if (src || interesting) scripts.push({ src, inlinePreview: body.slice(0, 1200), interesting });
  }
  return scripts;
}

function parseInputDiagnostics(html) {
  const inputs = [];
  const re = /<input\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const head = m[1];
    inputs.push({
      type: attr(head, "type") || "text",
      name: attr(head, "name"),
      id: attr(head, "id"),
      value: attr(head, "value"),
      onchange: attr(head, "onchange")
    });
  }
  return inputs;
}

async function loadSelected(format, day, division) {
  const first = await fetchHtml(BASE_URL);
  let page = first;
  const attempts = [];
  const request = requestForSelection(first, format, day, division);
  attempts.push(request);
  for (const url of directCandidates(format, day, division)) attempts.push({ url, init: { method: "GET" } });
  for (const attempt of attempts) {
    const selected = await fetchHtml(attempt.url, attempt.init);
    if (selected.status >= 200 && selected.status < 400) {
      const parsed = parseScheduleHtml(selected.html);
      if (parsed.hasSchedule) return { ...selected, parsed };
      page = selected;
    }
  }
  return { ...page, parsed: parseScheduleHtml(page.html) };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "POST required" }); }
  const body = req.body || {};
  try {
    const first = await fetchHtml(BASE_URL);
    if (first.status >= 400) return res.status(502).json({ error: `IBA schedule page returned HTTP ${first.status}.` });
    const selects = parseSelects(first.html);
    const formatSelect = findSelect(selects, FORMATS);
    const daySelect = findSelect(selects, DAYS);
    const divisionSelect = findDivisionSelect(selects, formatSelect, daySelect);
    const format = body.format || "Masters";
    const day = body.day || "Wednesday";

    if (body.action === "discover") {
      const attempts = [requestForSelection(first, format, day, null), ...directCandidates(format, day).map(url => ({ url, init: { method: "GET" } }))];
      let page = first;
      const attemptResults = [];
      for (const attempt of attempts) {
        try {
          const filtered = await fetchHtml(attempt.url, attempt.init);
          const maybe = parseSelects(filtered.html);
          const dv = findDivisionSelect(maybe, findSelect(maybe, FORMATS), findSelect(maybe, DAYS));
          attemptResults.push({ url: filtered.url, status: filtered.status, htmlBytes: filtered.html.length, selectCount: maybe.length, divisionOptionCount: dv?.options?.length || 0 });
          if (filtered.status < 400) {
            page = filtered;
            if (dv?.options?.length) break;
          }
        } catch (err) {
          attemptResults.push({ url: attempt.url, error: err?.message || String(err) });
        }
      }
      const pageSelects = parseSelects(page.html);
      const fs = findSelect(pageSelects, FORMATS);
      const ds = findSelect(pageSelects, DAYS);
      const vs = findDivisionSelect(pageSelects, fs, ds) || divisionSelect;
      const divisions = (vs?.options || []).filter(o => o.value || o.label).filter(o => !/^(select|choose|division)$/i.test(o.label)).map(o => ({ value: o.value, label: o.label }));
      return res.status(200).json({
        format,
        day,
        divisions,
        form: { formatName: fs?.name || null, dayName: ds?.name || null, divisionName: vs?.name || null, method: formInfo(page.html).method },
        diagnostic: {
          selectCount: pageSelects.length,
          htmlBytes: page.html.length,
          finalUrl: page.url,
          attempts: attemptResults,
          selects: parseSelectDiagnostics(page.html),
          forms: parseFormsDiagnostics(page.html),
          inputs: parseInputDiagnostics(page.html),
          scripts: parseScriptDiagnostics(page.html)
        }
      });
    }

    if (body.action === "fetch") {
      if (!body.division) return res.status(400).json({ error: "A division value is required." });
      const loaded = await loadSelected(format, day, body.division);
      return res.status(200).json({ format, day, division: body.division, url: loaded.url, ...loaded.parsed });
    }

    return res.status(400).json({ error: "Unknown action. Use discover or fetch." });
  } catch (e) {
    return res.status(502).json({ error: e?.name === "AbortError" ? "IBA schedule request timed out." : (e?.message || "Unable to retrieve IBA schedule data.") });
  }
}
