const IBA_BASE = "https://ibapool.com";
const LEAGUE_ID = "m8-pool-league";

const FORMATS = ["Open", "Advanced", "Masters"];
const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const TIMEOUT_MS = 15000;

function norm(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return _;
      }
    })
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag = "", name = "") {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedName}\\s*=\\s*["']([^"']*)["']`, "i");
  const match = String(tag).match(re);
  return match ? match[1] : "";
}

function stripScripts(html = "") {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
}

async function fetchText(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
        Referer: `${IBA_BASE}/League/Schedules/${LEAGUE_ID}`,
        "X-Requested-With": "XMLHttpRequest",
        ...extraHeaders,
      },
    });

    const text = await response.text();
    return { status: response.status, text, url: response.url, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

function getSetCookie(headers) {
  try {
    if (typeof headers?.getSetCookie === "function") {
      return headers.getSetCookie().map(x => x.split(";", 1)[0]).filter(Boolean).join("; ");
    }
  } catch { /* older Node/runtime */ }
  const raw = headers?.get?.("set-cookie") || "";
  return raw.split(/,(?=[^;,]+=)/).map(x => x.split(";", 1)[0]).filter(Boolean).join("; ");
}

async function fetchJson(url, options = {}) {
  const result = await fetchText(url, options.headers || {});
  if (result.status < 200 || result.status >= 400) {
    throw new Error(`IBA returned HTTP ${result.status}.`);
  }

  let data;
  try { data = JSON.parse(result.text); }
  catch { data = result.text; }

  return { ...result, data };
}

function parseDivisionOptions(html = "") {
  const source = String(html || "");
  const divisions = [];

  const optionRegex =
    /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;

  let match;

  while ((match = optionRegex.exec(source)) !== null) {
    const attributes = match[1] || "";
    const label = norm(match[2] || "");

    const valueMatch = attributes.match(
      /\bvalue\s*=\s*["']([^"']+)["']/i
    );

    const value = valueMatch
      ? valueMatch[1].trim()
      : "";

    if (!value || !label) continue;

    if (/^(division|select|choose)/i.test(label)) {
      continue;
    }

    if (
      !/^\d+!\d+$/.test(value) &&
      !/^\d+$/.test(value)
    ) {
      continue;
    }

    if (!divisions.some((division) => division.value === value)) {
      divisions.push({
        value,
        label,
        selected: /\bselected\b/i.test(attributes),
      });
    }
  }

  return divisions;
}

/**
 * Return table fragments while correctly accounting for nested tables.
 * IBA's Pairings column contains nested tables.
 */
function extractTables(html = "") {
  const source = stripScripts(html);
  const tables = [];
  const tokenRegex = /<\/?table\b[^>]*>/gi;
  const stack = [];
  let match;

  while ((match = tokenRegex.exec(source))) {
    if (/^<table\b/i.test(match[0])) {
      stack.push({ start: match.index, depth: stack.length });
    } else if (stack.length) {
      const table = stack.pop();
      tables.push({ depth: table.depth, html: source.slice(table.start, tokenRegex.lastIndex) });
    }
  }

  return tables.sort((a, b) => a.depth - b.depth);
}

function parseTableRows(tableHtml = "") {
  let html = String(tableHtml)
    .replace(/^\s*<table\b[^>]*>/i, "")
    .replace(/<\/table>\s*$/i, "");

  // Flatten nested tables into their visible contents before looking for
  // outer rows. Without this step a nested <tr> can prematurely terminate
  // the regex that identifies the parent schedule row.
  let previous;
  do {
    previous = html;
    html = html.replace(
      /<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi,
      (_, inner) => norm(inner)
    );
  } while (html !== previous);

  const rows = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html))) {
    const cells = [];
    const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      cells.push(norm(cellMatch[1]));
    }

    if (cells.length) rows.push(cells);
  }

  return rows;
}

function parseTeams(html = "") {
  const tables = extractTables(html);
  const teams = [];

  for (const table of tables) {
    const rows = parseTableRows(table.html);
    if (!rows.length) continue;

    const header = rows[0].map(norm).join(" | ").toLowerCase();
    if (!/team\s*#/.test(header) || !/name/.test(header)) continue;

    for (const row of rows.slice(1)) {
      const teamNum = norm(row[0] || "");
      const name = norm(row[1] || "");
      const venue = norm(row[2] || "");

      if (!/^\d{3,8}$/.test(teamNum) || !name || /^name$/i.test(name)) continue;
      if (teams.some(team => team.teamNum === teamNum)) continue;

      teams.push({
        teamNum,
        name,
        venue,
        isBye: /\bbye\b/i.test(name),
      });
    }
  }

  // Defensive fallback for a markup change: find visible "Team # Name Venue"
  // rows without inventing teams from ordinary schedule text.
  if (!teams.length) {
    const text = stripScripts(html)
      .replace(/<br\s*\/?>(?=\S)/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const re = /\b(\d{5,8})\s+([A-Za-z][^|\n]{1,70}?)(?=\s+\d{5,8}\s+|\s+Team\s*#|$)/g;
    let match;
    while ((match = re.exec(text))) {
      const name = norm(match[2]);
      if (!name || /^(team|name|location)$/i.test(name)) continue;
      if (!teams.some(team => team.teamNum === match[1])) {
        teams.push({ teamNum: match[1], name, venue: "", isBye: /\bbye\b/i.test(name) });
      }
    }
  }

  return teams;
}

function parsePairings(text = "") {
  const pairings = [];
  const regex = /(\d+)\s*(?:vs\.?|versus)\s*(\d+|TBD)/gi;
  let match;

  while ((match = regex.exec(text))) {
    pairings.push({
      home: Number(match[1]),
      away: /^tbd$/i.test(match[2]) ? null : Number(match[2]),
    });
  }

  return pairings;
}

function parseScheduleRows(html = "") {
  const tables = extractTables(html);
  const weeks = [];

  for (const table of tables) {
    const rows = parseTableRows(table.html);
    if (!rows.length) continue;

    const header = rows[0].map(norm).join(" | ").toLowerCase();
    if (!/week/.test(header) || !/date/.test(header) || !/pairings/.test(header)) continue;

    for (const row of rows.slice(1)) {
      if (!row.length) continue;

      const weekValue = norm(row[0] || "");
      const date = norm(row[1] || "");
      const week = /^\d+$/.test(weekValue) ? Number(weekValue) : null;
      const pairText = row.slice(2).join(" ");
      const pairings = parsePairings(pairText);
      const special = pairings.length === 0 && pairText ? pairText : "";

      if (week !== null || date || pairings.length || special) {
        weeks.push({
          week,
          date,
          pairings,
          ...(special ? { special } : {}),
        });
      }
    }
  }

  return weeks;
}

function parseWeeksFallback(html = "") {
  const text = stripScripts(html)
    .replace(/<br\s*\/?>(?=\S)/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const weeks = [];
  const weekRegex = /(?:Week\s+)?(\d+)\s+(\d{1,2}\/\d{1,2}\/\d{4})([\s\S]*?)(?=(?:Week\s+)?\d+\s+\d{1,2}\/\d{1,2}\/\d{4}|$)/gi;
  let match;

  while ((match = weekRegex.exec(text))) {
    const week = Number(match[1]);
    const date = match[2];
    const content = norm(match[3]);
    const pairings = parsePairings(content);
    const special = pairings.length === 0 && content ? content : "";

    weeks.push({
      week,
      date,
      pairings,
      ...(special ? { special } : {}),
    });
  }

  return weeks;
}

function parseScheduleHtml(html = "") {
  const clean = stripScripts(html);
  const teams = parseTeams(clean);
  let weeks = parseScheduleRows(clean);
  if (!weeks.length) weeks = parseWeeksFallback(clean);

  // Remove accidental duplicate week rows while preserving order.
  const seen = new Set();
  weeks = weeks.filter(week => {
    const key = `${week.week ?? ""}|${week.date}|${week.special ?? ""}|${JSON.stringify(week.pairings)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    teams,
    weeks,
    hasSchedule: teams.length > 0 && weeks.length > 0,
  };
}

async function getDivisions(format, day) {
  if (!FORMATS.includes(format)) {
    throw new Error(`Invalid IBA format: ${format}`);
  }

  if (!DAYS.includes(day)) {
    throw new Error(`Invalid IBA day: ${day}`);
  }

  const url = new URL(`${IBA_BASE}/League/GetDivisions`);
  url.searchParams.set("id", LEAGUE_ID);
  url.searchParams.set("format", format);
  url.searchParams.set("day", day);
  url.searchParams.set("_", Date.now().toString());

  // First attempt: direct AJAX request.
  let result = await fetchJson(url.toString());
  let response = result.data;

  // Unwrap JSON strings until we reach an object or raw HTML.
  for (let i = 0; i < 3 && typeof response === "string"; i += 1) {
    const trimmed = response.trim();

    if (!trimmed) {
      break;
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        response = JSON.parse(trimmed);
        continue;
      } catch {
        // Treat it as raw HTML.
      }
    }

    break;
  }

  let divisionHtml = "";

  if (response && typeof response === "object") {
    divisionHtml =
      response.html ??
      response.data ??
      response.schedule ??
      "";
  } else if (typeof response === "string") {
    divisionHtml = response;
  }

  if (typeof divisionHtml !== "string") {
    divisionHtml = String(divisionHtml || "");
  }

  let divisions = parseDivisionOptions(divisionHtml).map(
    ({ value, label }) => ({ value, label })
  );

  // ------------------------------------------------------------
  // SECOND ATTEMPT: plain request
  // ------------------------------------------------------------
  if (!divisions.length) {
    try {
      const plain = await fetchText(url.toString(), {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "",
        Referer: "",
      });

      let plainResponse = plain.text;

      if (typeof plainResponse === "string") {
        try {
          plainResponse = JSON.parse(plainResponse);
        } catch {
          // Raw HTML.
        }
      }

      if (typeof plainResponse === "string") {
        try {
          plainResponse = JSON.parse(plainResponse);
        } catch {
          // Still raw HTML.
        }
      }

      const plainHtml =
        plainResponse && typeof plainResponse === "object"
          ? (
              plainResponse.html ??
              plainResponse.data ??
              plainResponse.schedule ??
              ""
            )
          : typeof plainResponse === "string"
            ? plainResponse
            : "";

      const plainDivisions = parseDivisionOptions(plainHtml).map(
        ({ value, label }) => ({ value, label })
      );

      if (plainDivisions.length) {
        result = plain;
        response = plainResponse;
        divisionHtml =
          typeof plainHtml === "string"
            ? plainHtml
            : String(plainHtml || "");

        divisions = plainDivisions;
      }
    } catch {
      // Continue to session bootstrap.
    }
  }

  // ------------------------------------------------------------
  // THIRD ATTEMPT: establish an IBA schedule-page session
  // ------------------------------------------------------------
  if (!divisions.length) {
    try {
      const page = await fetchText(
        `${IBA_BASE}/League/Schedules/${LEAGUE_ID}`,
        {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "X-Requested-With": "",
        }
      );

      const cookie = getSetCookie(page.headers);

      if (page.status >= 200 && page.status < 400 && cookie) {
        result = await fetchJson(url.toString(), {
          headers: {
            Cookie: cookie,
          },
        });

        response = result.data;

        for (
          let i = 0;
          i < 3 && typeof response === "string";
          i += 1
        ) {
          const trimmed = response.trim();

          if (
            trimmed.startsWith("{") ||
            trimmed.startsWith("[")
          ) {
            try {
              response = JSON.parse(trimmed);
              continue;
            } catch {
              // Raw HTML.
            }
          }

          break;
        }

        divisionHtml =
          response && typeof response === "object"
            ? (
                response.html ??
                response.data ??
                response.schedule ??
                ""
              )
            : typeof response === "string"
              ? response
              : "";

        if (typeof divisionHtml !== "string") {
          divisionHtml = String(divisionHtml || "");
        }

        divisions = parseDivisionOptions(divisionHtml).map(
          ({ value, label }) => ({ value, label })
        );
      }
    } catch {
      // Final raw-body fallback below.
    }
  }

  // ------------------------------------------------------------
  // FINAL ATTEMPT: parse the complete raw response body
  // ------------------------------------------------------------
  if (!divisions.length) {
    divisions = parseDivisionOptions(result.text).map(
      ({ value, label }) => ({ value, label })
    );
  }

  // ------------------------------------------------------------
  // DIAGNOSTICS
  // ------------------------------------------------------------
  const contentType =
    result.headers.get("content-type") || "";

  const rawText = String(result.text || "");

  const rawPreview = rawText
    .replace(/\s+/g, " ")
    .slice(0, 2000);

  const optionMatches = [
  ...divisionHtml.matchAll(
    /<option\b([^>]*)>([\s\S]*?)<\/option>/gi
  ),
]
  .slice(0, 20)
  .map((match) => {
    const attributes = match[1] || "";
    const label = norm(match[2] || "");

    const valueMatch = attributes.match(
      /\bvalue\s*=\s*["']([^"']+)["']/i
    );

    return {
      value: valueMatch ? valueMatch[1] : "",
      label,
    };
  });

  const diagnostic = {
    httpStatus: result.status,
    finalUrl: result.url,
    contentType,
    responseBytes: rawText.length,

    responseType: typeof result.data,

    responseKeys:
      result.data &&
      typeof result.data === "object"
        ? Object.keys(result.data)
        : [],

    hasDivisionsSelect:
      /<select\b[^>]*id=["']Divisions["']/i.test(
        divisionHtml
      ),

    hasDivisionOption:
      /<option\b[^>]*value=["'][^"']+![0-9]+["']/i.test(
        divisionHtml
      ),

    preview: rawPreview,

    divisionHtmlPreview: String(divisionHtml || "")
      .replace(/\s+/g, " ")
      .slice(0, 5000),

    optionMatches,

    request: {
      format,
      day,
      leagueId: LEAGUE_ID,
    },

    parserFoundDivisions: divisions.length,
  };

  return {
    format,
    day,
    divisions,
    url: result.url,
    diagnostic,
  };
}

async function getDivisionSchedule(division) {
  if (!division) throw new Error("A division value is required.");

  const url = new URL(`${IBA_BASE}/League/GetSchedule`);
  url.searchParams.set("id", LEAGUE_ID);
  url.searchParams.set("divId", division);
  url.searchParams.set("_", Date.now().toString());

  const result = await fetchJson(url.toString());
  let response = result.data;
  let scheduleHtml = "";

  if (typeof response === "string") {
    scheduleHtml = response;
  } else if (response && typeof response === "object") {
    scheduleHtml = response.html || response.schedule || response.data || "";
  }

  // Be tolerant if the endpoint wraps the HTML in another JSON string/object.
  if (typeof scheduleHtml === "string") {
    const trimmed = scheduleHtml.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || trimmed.startsWith("{")) {
      try {
        const decoded = JSON.parse(trimmed);
        if (typeof decoded === "string") scheduleHtml = decoded;
        else if (decoded) scheduleHtml = decoded.html || decoded.schedule || decoded.data || scheduleHtml;
      } catch { /* ordinary HTML */ }
    }
  }

  const parsed = parseScheduleHtml(scheduleHtml);
  return {
    division,
    url: result.url,
    htmlBytes: scheduleHtml.length,
    ...parsed,
  };
}

async function getAllDivisionSchedules(format, day, divisions) {
  // Retrieve divisions concurrently. IBA can serve the individual schedules
  // independently, and sequential requests can exceed a serverless function's
  // execution window even when each individual Preview request succeeds.
  const settled = await Promise.allSettled(
    divisions.map(async (division) => ({
      division,
      ...(await getDivisionSchedule(division.value)),
    }))
  );

  const results = [];
  const errors = [];

  for (let i = 0; i < settled.length; i += 1) {
    const item = settled[i];
    const division = divisions[i];

    if (item.status === "fulfilled") {
      results.push(item.value);
    } else {
      errors.push({
        division,
        error: item.reason?.message || "Unable to retrieve division schedule.",
      });
    }
  }

  return {
    format,
    day,
    results,
    errors,
    totals: {
      divisions: results.length,
      teams: results.reduce((sum, result) => sum + result.teams.length, 0),
      weeks: results.reduce((sum, result) => sum + result.weeks.length, 0),
      matchups: results.reduce(
        (sum, result) => sum + result.weeks.reduce((weekSum, week) => weekSum + week.pairings.length, 0),
        0
      ),
    },
  };
}

function parseRequestBody(req) {
  if (!req || req.body == null) return {};
  if (typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST required" });
  }

  try {
    const body = parseRequestBody(req);
    const action = body.action || "discover";
    const format = body.format || "Masters";
    const day = body.day || "Wednesday";

    if (action === "discover") {
      const data = await getDivisions(format, day);
      return res.status(200).json({
        format,
        day,
        divisions: data.divisions,
        count: data.divisions.length,
        diagnostic: data.diagnostic,
      });
    }

    if (action === "fetch") {
      if (!body.division) {
        return res.status(400).json({ error: "A division value is required." });
      }

      const data = await getDivisionSchedule(body.division);
      return res.status(200).json({
        format,
        day,
        division: body.division,
        url: data.url,
        teams: data.teams,
        weeks: data.weeks,
        hasSchedule: data.hasSchedule,
        htmlBytes: data.htmlBytes,
      });
    }

    if (action === "fetch-all") {
      const discovered = await getDivisions(format, day);
      const all = await getAllDivisionSchedules(format, day, discovered.divisions);
      return res.status(200).json({ ...all, divisions: discovered.divisions });
    }

    return res.status(400).json({
      error: "Unknown action. Use discover, fetch, or fetch-all.",
    });
  } catch (error) {
    console.error("IBA schedule API error:", error);
    return res.status(502).json({
      error: error?.name === "AbortError"
        ? "IBA schedule request timed out after 15 seconds."
        : error?.message || "Unable to retrieve IBA schedule data.",
      name: error?.name || "Error",
      action: "unknown",
      format: "unknown",
      day: "unknown",
    });
  }
}

export { parseDivisionOptions, parsePairings, parseScheduleHtml };
