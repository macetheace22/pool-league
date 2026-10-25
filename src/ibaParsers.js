// Shared IBA report parsers. Manual paste and automatic PDF imports both use these functions.
// Extract the week explicitly printed in an IBA weekly PDF. IBA report types
// use two common labels: roster/ratings and MVP use "For week: 17", while
// team standings uses "Week 17". Do not infer a week from today's date or the
// app's current week; callers must compare this value with the selected
// division's schedule before importing.
//
// If the extracted PDF text contains conflicting week labels, return an
// ambiguous result rather than silently choosing one.
function extractIbaReportWeek(raw) {
  const text = String(raw || "");
  const matches = [...text.matchAll(/\b(?:For\s+)?Week\s*:?\s*(\d+)\b/gi)]
    .map(match => ({ weekNumber: Number(match[1]), matchedText: match[0] }));
  const distinctWeeks = [...new Set(matches.map(match => match.weekNumber))];
  return {
    weekNumber: distinctWeeks.length === 1 ? distinctWeeks[0] : null,
    weekNumbers: distinctWeeks,
    matchedLabels: matches.map(match => match.matchedText),
    missing: matches.length === 0,
    ambiguous: distinctWeeks.length > 1,
  };
}

// Extract week labels independently for division-scoped report sections. Some
// PDFs print a week label per division, so a report-wide week must never be
// assigned to every division when the source contains differing weeks.
// Extract the date printed on the IBA report. Repeated headers across pages
// are common, so repeated copies of the same date are fine; conflicting dates
// are treated as unavailable rather than guessing.
function extractIbaReportPrintedOnDate(raw) {
  const text = String(raw || "");
  const datePattern = "(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}/\\d{1,2}/\\d{4})";
  const regex = new RegExp("(?:report\\s+printed|printed\\s+on|print(?:ed)?\\s+date)\\s*:?\\s*" + datePattern, "gi");
  const normalized = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = match[1];
    let year, month, day, parts = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (parts) [, year, month, day] = parts;
    else {
      parts = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (parts) [, month, day, year] = parts;
    }
    if (!parts) continue;
    const y = Number(year), m = Number(month), d = Number(day);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) continue;
    normalized.add(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return normalized.size === 1 ? [...normalized][0] : null;
}

function extractIbaReportWeeksByDivision(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const divisionHeader = /^\s*(?:Division\s*#?\s*)?(\d{3})\s+(.{2,80}?)\s*$/i;
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(divisionHeader);
    const looksLikeDivision = match && !/^(?:week|for week|team|player|printed|fall season|winter season|spring season)\b/i.test(match[2]);
    if (looksLikeDivision) {
      current = { divisionNum: match[1], divisionLabel: match[2].trim(), lines: [] };
      sections.push(current);
    }
    if (current) current.lines.push(line);
  }

  const byDivision = {};
  for (const section of sections) {
    const metadata = extractIbaReportWeek(section.lines.join("\n"));
    byDivision[section.divisionNum] = {
      ...metadata,
      divisionLabel: section.divisionLabel,
    };
  }
  const reportMetadata = extractIbaReportWeek(lines.join("\n"));
  return {
    byDivision,
    reportWeek: reportMetadata,
    hasDivisionSections: sections.length > 0,
  };
}

function isValidIbaTeamNumber(value) {
  const teamNum = String(value ?? "").trim();
  return /^(?=.*\d)[A-Z0-9]{3,8}$/i.test(teamNum);
}

function parseStandingsImport(raw) {
  const rows = [];
  const lines = String(raw || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const trimmed of lines) {
    const parts = trimmed.split(/\t+/);
    let teamNum, teamName, pointsLastWk, totalPoints, setsPlayed;
    if (parts.length >= 4) {
      teamNum = parts[0].trim(); teamName = parts[1].trim();
      pointsLastWk = parseFloat(parts[2]) || 0;
      totalPoints = parseInt(parts[3], 10) || 0;
      setsPlayed = parseInt(parts[4], 10) || 0;
    } else {
      const m = trimmed.match(/^([A-Z0-9]{5})\s+(.+?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+)\s+(\d+)(?:\s+[\d.]+)?$/i);
      if (!m) continue;
      teamNum = m[1]; teamName = m[2];
      pointsLastWk = parseFloat(m[3]) || 0;
      totalPoints = parseInt(m[4], 10) || 0;
      setsPlayed = parseInt(m[5], 10) || 0;
    }
    if (teamNum && teamName) rows.push({ teamNum, teamName, pointsLastWk, totalPoints, setsPlayed });
  }
  if (rows.length) return rows;

  // Current IBA DIV PDFs may extract each cell on its own line. The final
  // token joins points-last-week (in tenths) and sets played, e.g. 95924 = 95.9, 24.
  const compactRows = [];
  for (let i = 0; i < lines.length - 4; i++) {
    if (!isValidIbaTeamNumber(lines[i]) || !/^[-\d.]+$/.test(lines[i + 1])) continue;
    const teamNum = lines[i], teamName = lines[i + 2];
    if (!teamName || /^\d+$/.test(teamName) || /^(Team|Division|Printed|Fall Season|Week|Wed|Sun|Mon|Tue|Thu|Fri|Sat)\b/i.test(teamName)) continue;
    if (!/^\d{3,5}$/.test(lines[i + 3]) || !/^\d{4,6}$/.test(lines[i + 4])) continue;
    const totalPoints = parseInt(lines[i + 3], 10);
    const packed = lines[i + 4], setsPlayed = parseInt(packed.slice(-2), 10);
    const tenths = packed.slice(0, -2);
    if (!tenths || !Number.isFinite(setsPlayed) || setsPlayed < 1 || setsPlayed > 99) continue;
    const pointsLastWk = Number(tenths);
    compactRows.push({ teamNum, teamName, pointsLastWk, totalPoints, setsPlayed });
    i += 4;
  }
  return compactRows;
}
// MVP Standings report: Plyr# <tab> Player Name <tab> Team# <tab> Sets Won
// <tab> Sets Lost <tab> Points Scored <tab> Total MVP Ranking Points. The
// last column is recomputed by the app (pointsScored + 200/win - 200/loss,
// forfeit wins excluded from the bonus) rather than trusted from the paste,
// so real matches and imported weeks use the exact same formula.
function parseMvpImport(raw) {
  const rows = [];
  const lines = String(raw || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const trimmed of lines) {
    const parts = trimmed.split(/\t+/);
    let playerNum, playerName, teamNum, wins, losses, pointsScored, mvpRankingPoints;
    if (parts.length >= 7) {
      [playerNum, playerName, teamNum] = parts.slice(0, 3).map(x => x.trim());
      wins = parseInt(parts[3], 10) || 0; losses = parseInt(parts[4], 10) || 0;
      pointsScored = parseInt(parts[5], 10) || 0; mvpRankingPoints = parseInt(parts[6], 10) || 0;
      if (playerNum && playerName && teamNum) rows.push({ playerNum, playerName, teamNum, wins, losses, pointsScored, mvpRankingPoints });
      continue;
    }
    const m = trimmed.match(/^(\d{5})\s+(.+?)\s+([A-Z0-9]{5})\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)$/i);
    if (m) {
      rows.push({ playerNum:m[1], playerName:m[2], teamNum:m[3], wins:parseInt(m[4],10)||0, losses:parseInt(m[5],10)||0, pointsScored:parseInt(m[6],10)||0, mvpRankingPoints:parseInt(m[7],10)||0 });
      continue;
    }
    // Compact current IBA PDF row: player number + name + team number + joined stats.
    const start = trimmed.match(/^(\d{5})(.*)$/);
    if (!start) continue;
    const playerNumCompact = start[1], remainder = start[2];
    const teamMatches = [...remainder.matchAll(/([A-Z0-9]{5})(?=\d)/gi)];
    let parsed = null;
    for (const tm of teamMatches) {
      const playerNameCompact = remainder.slice(0, tm.index).trim();
      const tail = remainder.slice(tm.index + tm[1].length);
      if (!playerNameCompact || !/^\d+$/.test(tail)) continue;
      for (let winLen = 1; winLen <= 2 && !parsed; winLen++) {
        for (let rankLen = 3; rankLen <= 4 && !parsed; rankLen++) {
          for (let lossLen = 1; lossLen <= 2 && !parsed; lossLen++) {
            const pointsLen = tail.length - winLen - rankLen - lossLen;
            if (pointsLen < 3 || pointsLen > 4) continue;
            const w = Number(tail.slice(0, winLen));
            const rank = Number(tail.slice(winLen, winLen + rankLen));
            const l = Number(tail.slice(winLen + rankLen, winLen + rankLen + lossLen));
            const p = Number(tail.slice(winLen + rankLen + lossLen));
            if (rank === p + 200 * w - 200 * l) {
              parsed = { playerNum:playerNumCompact, playerName:playerNameCompact, teamNum:tm[1], wins:w, losses:l, pointsScored:p, mvpRankingPoints:rank };
            }
          }
        }
      }
      if (parsed) break;
    }
    if (parsed) rows.push(parsed);
  }
  return rows;
}
// ─── Bulk league roster parser (IBA PDF format) ───────────────────────────────
// Handles multiple known "pasted from PDF viewer" layouts. Each layout is
// detected per report-section and dispatched to its own strategy, so new
// layouts can be added later without touching the working ones.
//
// Known layouts:
// 1. MULTI_RATE_FIRST  (Division Roster "page 1" style)
//    Three teams printed side-by-side per physical line, each entry as
//    "Rate Num Play Win Name". Rate leads every row, so it's unambiguous.
// 2. SINGLE_RATE_LAST_SHIFTED  (Division Roster "page 2" style)
//    Teams are printed one-per-block, in COLUMN-MAJOR order (all of visual
//    column 1 top-to-bottom, then column 2, then column 3), because the PDF
//    viewer flattens the 3-across grid by physical text column rather than
//    by row. Each block's header is "Num Play Win Name Rate" (rate LAST).
//    The catch: the Rate value printed at the end of a row does NOT belong
//    to that row's own team -- it belongs to the *next column's* team in
//    the same grid row. The rightmost column has nothing to hand its rate
//    off to, so its true numbers appear as isolated preamble blocks dumped
//    at the very top of the page, before any team header.
// 3. SINGLE_RATE_LAST_DIRECT / SINGLE_RATE_FIRST
//    Straightforward one-team-per-block layouts with no cross-column bleed.
//
// Returns { registry, rosters, teams, needsRating, ambiguousRoster }
//   registry:        { num: {num,name,nickname,rating} }
//   rosters:         { teamId: [num, ...] }
//   teams:           { teamId: {id,name,location,isBye} }
//   needsRating:     [{teamId,num,name,nickname}]      — rate unrecoverable, needs manual entry
//   ambiguousRoster: [{num,guessedTeamId,candidateTeamIds}] — rating correct, team placement uncertain

const NOISE_RE = [
  /^For Week|^Report printed|^Rate of|^-{10,}|^Summer|^Winter|^Spring/i,
  /^(Wed|Thu|Mon|Tue|Fri|Sat|Sun)\s/i,
  /Division #/i,
  /Sports Bar$/i,
  /^Rate(\s+Num\s+Play\s+Win\s+Name)?$/i,
  /^Num\s+Play\s+Win\s+Name(\s+Rate)?$/i,
];
function isNoiseLine(line) {
  return NOISE_RE.some(re => re.test(line));
}

function cleanName(fullName) {
  const cleaned = fullName.replace(/^[\s~_\-=+«»'.O\u2013\u2014]+|[\s~_\-=+«»'.]+$/g, '').trim();
  if (!cleaned) return null;
  // PDF extraction sometimes removes the space before a nickname and may drop its closing quote.
  const nickMatch = cleaned.match(/^(.+?)\s*"([^"]+)"?\s*$/);
  const name = nickMatch ? nickMatch[1].trim() : cleaned;
  const nickname = nickMatch ? nickMatch[2].trim() : "";
  return { name, nickname };
}

function splitName(fullName) {
  const trimmed = (fullName || "").trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { firstName: trimmed, lastName: "" };
  return { firstName: trimmed.slice(0, idx), lastName: trimmed.slice(idx + 1).trim() };
}

function addPlayer(registry, rosters, teamId, num, fullName, rate, needsRating) {
  rosters[teamId] = rosters[teamId] ?? [];
  const parsed = cleanName(fullName);
  if (!parsed) return;
  const hasRate = !!rate && rate !== 0;
  const { firstName, lastName } = splitName(parsed.name);
  if (!hasRate) needsRating.push({ teamId, num, name: parsed.name, nickname: parsed.nickname, firstName, lastName });
  // Add the player either way -- even with no rating yet, they belong on this roster and
  // should show up in the admin panel (as "—") so the rating can be filled in by hand.
  registry[num] = { num, name: parsed.name, nickname: parsed.nickname, rating: hasRate ? rate : null, firstName, lastName };
  if (!rosters[teamId].includes(num)) rosters[teamId].push(num);
}

// ---------- team header detection ----------
function detectTeamHeader(line) {
  if (/^\d{1,3}\s+\d{5}/.test(line)) return null; // a player row, not a header
  if (/^\d{5}\s+[^\dO]*[\dO]+\.?\s+[\dO]/.test(line)) return null; // player row
  const inline = line.match(/^\s*Team\s*([A-Z0-9]{5})\b\s*(.*)$/i);
  if (inline) return { id: inline[1], name: inline[2].replace(/\s*Team\s*$/i, '').trim() };
  // Bare "<id> <team name>" header. Team names can start with a digit
  // (e.g. "8 Ball Donkeys"), so we can't require a leading letter -- we
  // rely on the two negative checks above to already have ruled out
  // anything that looks like a player row.
  const bare = line.match(/^([A-Z0-9]{5})\s+(\S.{0,})$/i);
  if (bare) return { id: bare[1], name: bare[2].replace(/\s*Team\s*$/i, '').trim() };
  return null;
}

// ---------- shared player-row regex ----------
// Matches "<num> <play> <win> <name> [<rate>]" -- the trailing rate is
// optional so this same regex covers both the rate-last and no-rate
// single-column header styles.
const PLAY_WIN = String.raw`[^\dO]*[\dO]+\.?\s+[\dO]+\.?\s+`;
const RE_RATE_LAST_OPT = new RegExp(`^(\\d{5})\\.?\\s+${PLAY_WIN}(.+?)(?:\\s+(\\d{1,3}))?$`);

// ==================================================================
// Section-level dispatch
// ==================================================================
function parseLeagueRoster(raw) {
  // The current PDF extractor can collapse an entire roster page into one
  // line. Restore player-row boundaries from the stable numeric prefix
  // (five-digit player number + play/win counts) before the established
  // layout-specific parser runs. This deliberately leaves team/venue text
  // intact rather than guessing where those names should be split.
  const normalizedRaw = String(raw || "")
    .replace(/Team(?=[A-Z0-9]{5}\b)/gi, "Team ")
    // Restore common venue boundaries so the existing team-header parser
    // keeps team name and venue separate.
    .replace(/\s+(Twin City Billiards|C\.?R\.?['’]?s Sports Bar|Two Stooges Sports Bar|Shooter['’]?s Billiards|Turtle['’]?s Bar\s*&\s*Grill|Pullman Club)\s+(?=Num\s*Play|NumPlay|Rate\s*Num)/gi, "\n$1\n")
    .replace(/(?<!\d)(\d{5})(\d)(\d)(?=[A-Za-z"'])/g, "\n$1 $2 $3 ")
    .split(/\r?\n/)
    .map(line => {
      // Ratings are normally two digits or 100–199. Prefer a three-digit
      // rating before falling back to two digits, so 105 stays 105 (not 1 + 05).
      const row = line.match(/^(\d{5})\s+(\d)\s+(\d)\s+(.+?)(1\d{2}|\d{2})\s*$/);
      if (!row) return line;
      return row[1] + " " + row[2] + " " + row[3] + " " + row[4].trim() + " " + row[5];
    })
    .join("\n");
  const parts = normalizedRaw.split(/Division Roster and Handicap Report/i);
  // Some IBA PDF extraction layouts place the division heading AFTER
  // that division's team blocks. Keep the pre-heading text as a section too;
  // dropping parts[0] silently loses the first division in those reports.
  const sections = parts.filter(part => part.trim());

  const registry = {};
  const rosters = {};
  const teams = {}; // teamId -> { name, location, isBye }
  const needsRating = [];
  const ambiguousRoster = []; // players whose TEAM couldn't be pinned down from text alone

  // First pass: detect if any section uses the multi-column format, to
  // learn how many teams are printed "across" -- reused as the column
  // count for the single-column shifted format later in the same report.
  let learnedColumns = null;
  for (const s of sections) {
    const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const inlineTeams = [...line.matchAll(/\bTeam\s*([A-Z0-9]{5})\b/gi)];
      if (inlineTeams.length >= 2) {
        learnedColumns = Math.max(learnedColumns || 0, inlineTeams.length);
      }
    }
  }

  for (const s of sections) {
    parseSection(s, registry, rosters, teams, needsRating, ambiguousRoster, learnedColumns || 3);
  }

  return { registry, rosters, teams, needsRating, ambiguousRoster };
}

function registerTeam(teams, id, name, location) {
  const isBye = /\bBYE\b/i.test(name || '');
  const existing = teams[id];
  teams[id] = {
    id,
    name: (name || existing?.name || '').replace(/\s{2,}/g, ' ').trim(),
    location: location ?? existing?.location ?? null,
    isBye: isBye || existing?.isBye || false,
  };
}

function parseSection(section, registry, rosters, teams, needsRating, ambiguousRoster, defaultColumns) {
  const lines = section.split('\n').map(l => l.trim()).filter(Boolean);

  const hasMultiColumnLine = lines.some(
    l => [...l.matchAll(/\bTeam\s+([A-Z0-9]{5})\b/gi)].length >= 2
  );

  if (hasMultiColumnLine) {
    parseMultiColumnRateFirst(lines, registry, rosters, teams, needsRating, ambiguousRoster);
  } else {
    parseSingleColumnTeams(lines, registry, rosters, teams, needsRating, defaultColumns);
  }
}

// ==================================================================
// Format 1: multi-column, rate-first (page 1 style)
// ==================================================================
function parseMultiColumnRateFirst(lines, registry, rosters, teams, needsRating, ambiguousRoster) {
  let currentTeams = [];          // all team ids declared on this row, left-to-right (includes BYEs)
  let activeTeams = [];           // currentTeams minus explicit BYE teams -- these are the only ones that can have anchors
  let calibratedPositions = null; // char offsets of columns, learned from the last "full" row
  let expectLocationLine = false; // true right after a header line, so the venue line can be captured before it's dropped as noise

  for (const line of lines) {
    // Venue line (e.g. "Two Stooges Sports Bar Two Stooges Sports Bar C.R.'s
    // Sports Bar") is normally filtered out as noise -- intercept it here,
    // right after a header, so each team's location can be recorded first.
    // Columns are simply concatenated with a space, and every venue name
    // ends in "Sports Bar", so splitting right after that phrase reliably
    // separates them back out in column order.
    if (expectLocationLine && /Sports Bar/i.test(line) && !/^Rate|^Num/i.test(line)) {
      const venues = line.split(/(?<=Sports Bar)\s+/i).map(v => v.trim()).filter(Boolean);
      currentTeams.forEach((id, i) => registerTeam(teams, id, undefined, venues[i]));
      expectLocationLine = false;
      continue;
    }
    expectLocationLine = false;

    if (isNoiseLine(line)) continue;

    const inlineTeams = [...line.matchAll(/\bTeam\s+([A-Z0-9]{5})\b/gi)];
    if (inlineTeams.length >= 2) {
      currentTeams = inlineTeams.map(m => m[1]);
      inlineTeams.forEach((m, i) => {
        const segEnd = i + 1 < inlineTeams.length ? inlineTeams[i + 1].index : line.length;
        const name = line.slice(m.index + m[0].length, segEnd).trim();
        registerTeam(teams, m[1], name, undefined);
      });
      // A team explicitly marked "BYE" (e.g. "Team 15112 BYE -No Match")
      // has zero players by definition -- exclude it from column matching
      // entirely so it can't cause false ambiguity on the teams beside it.
      activeTeams = currentTeams.filter(id => !teams[id].isBye);
      calibratedPositions = null; // header text isn't reliably aligned with the data rows below it
      currentTeams.forEach(id => { rosters[id] = rosters[id] ?? []; });
      expectLocationLine = true;
      continue;
    }

    if (activeTeams.length === 0) continue;

    // Find every "rate num play win " anchor on the line, with its x-position.
    // Play/Win counts occasionally get OCR'd/extracted as a mix of "0" and
    // the letter "O" (e.g. "0O" instead of "00"), so tolerate [\dO] there
    // the same way the single-column regexes do.
    const anchorRe = /(?:^|\s)(\d{1,3})\s+(\d{5})\s+[\dO]+\.?\s+[\dO.]+\s+/g;
    const anchors = [];
    let am;
    while ((am = anchorRe.exec(line)) !== null) {
      anchors.push({ pos: am.index, rate: parseInt(am[1], 10), num: am[2], nameStart: am.index + am[0].length });
    }
    if (anchors.length === 0) continue;

    if (anchors.length === activeTeams.length) {
      // Unambiguous: every (non-BYE) team has an entry on this row, in
      // left-to-right order. Also used to calibrate column x-positions for
      // the rare row where a team runs out of players early and leaves a gap.
      calibratedPositions = anchors.map(a => a.pos);
      anchors.forEach((a, ai) => {
        const nameEnd = ai + 1 < anchors.length ? anchors[ai + 1].pos : line.length;
        addPlayer(registry, rosters, activeTeams[ai], a.num, line.slice(a.nameStart, nameEnd), a.rate, needsRating);
      });
    } else {
      // A team ran out of players before its neighbors, leaving fewer
      // anchors than active teams on this row.
      //
      // Safe case: the missing team(s) are at the END of the row (a
      // trailing dropout) -- the remaining anchors still land close to
      // their normal calibrated positions, so a simple prefix mapping
      // (anchors -> the first N active teams) is reliable.
      //
      // Unsafe case: a MIDDLE column dropped. Every anchor after it then
      // shifts left by roughly one column-width, which makes a plain
      // nearest-position match confidently pick the WRONG team. Rather
      // than silently mis-file a player on the wrong roster in that case,
      // take the best guess for continuity but flag it so the admin
      // panel can prompt for a quick confirmation.
      let prefixIsSafe = true;
      if (calibratedPositions) {
        const TOLERANCE = 6; // characters
        prefixIsSafe = anchors.every((a, ai) => Math.abs(a.pos - calibratedPositions[ai]) <= TOLERANCE);
      }

      anchors.forEach((a, ai) => {
        const nameEnd = ai + 1 < anchors.length ? anchors[ai + 1].pos : line.length;
        const name = line.slice(a.nameStart, nameEnd);

        if (prefixIsSafe) {
          addPlayer(registry, rosters, activeTeams[ai], a.num, name, a.rate, needsRating);
          return;
        }

        let bestCol = ai, bestDist = Infinity;
        if (calibratedPositions) {
          calibratedPositions.forEach((cp, ci) => {
            const d = Math.abs(cp - a.pos);
            if (d < bestDist) { bestDist = d; bestCol = ci; }
          });
        }
        addPlayer(registry, rosters, activeTeams[bestCol], a.num, name, a.rate, needsRating);
        ambiguousRoster.push({ num: a.num, guessedTeamId: activeTeams[bestCol], candidateTeamIds: activeTeams });
      });
    }
  }
}

// ==================================================================
// Format 2/3: single team-per-block ("Num Play Win Name [Rate]")
// ==================================================================
function parseSingleColumnTeams(lines, registry, rosters, teams, needsRating, columns) {
  const preambleBlocks = [];
  let preambleCurrent = null;
  let sawTeamHeader = false;
  let expectLocationLine = false;

  const allTeams = []; // { id, name, players:[{num,name}], trailingRates:[] }
  let current = null;

  for (const line of lines) {
    // Venue line right after a header (e.g. "C.R.'s Sports Bar") is
    // normally filtered as noise -- intercept it here first so it can be
    // recorded against the team it belongs to.
    if (expectLocationLine && /(?:Sports Bar|Billiards|Bar\s*&\s*Grill|Pullman Club)$/i.test(line)) {
      if (current) registerTeam(teams, current.id, undefined, line.trim());
      expectLocationLine = false;
      continue;
    }
    expectLocationLine = false;

    if (isNoiseLine(line)) continue;

    if (/^Team\s*$/i.test(line)) {
      if (!sawTeamHeader) { preambleCurrent = []; preambleBlocks.push(preambleCurrent); }
      continue;
    }

    const header = detectTeamHeader(line);
    if (header) {
      sawTeamHeader = true;
      current = { id: header.id, players: [], trailingRates: [] };
      allTeams.push(current);
      registerTeam(teams, header.id, header.name, undefined);
      rosters[current.id] = rosters[current.id] ?? [];
      expectLocationLine = true;
      continue;
    }

    if (/^\d{1,3}$/.test(line)) {
      const val = parseInt(line, 10);
      if (!sawTeamHeader && preambleCurrent !== null) {
        preambleCurrent.push(val);
      } else if (current) {
        current.trailingRates.push(val); // stray continuation value for current team
      }
      continue;
    }

    if (!current) continue;

    // Current IBA roster PDFs commonly extract rows as:
    // "Rate Num Play Win Name" (rate FIRST), unlike older rate-last layouts.
    // Keep the player number as a string to preserve leading zeroes.
    const rateFirst = line.match(/^(\d{1,3})\s+(\d{5})\.?\s+[\dO]+\.?\s+[\dO]+\.?\s+(.+)$/);
    if (rateFirst) {
      current.players.push({ num: rateFirst[2], name: rateFirst[3], rate: parseInt(rateFirst[1], 10) });
      continue;
    }

    const m = RE_RATE_LAST_OPT.exec(line);
    if (m) {
      current.players.push({ num: m[1], name: m[2] });
      if (m[3] !== undefined) current.trailingRates.push(parseInt(m[3], 10));
      continue;
    }
  }

  const teamsList = allTeams;
  if (teamsList.length === 0) return;

  // Rate-first rows carry their own rating and must never enter the legacy
  // rate-shifting logic used for the older multi-column PDF extraction.
  if (teamsList.some(team => team.players.some(player => player.rate !== undefined))) {
    for (const team of teamsList) {
      team.players.forEach((player, i) => {
        const rate = player.rate !== undefined ? player.rate : team.trailingRates[i];
        addPlayer(registry, rosters, team.id, player.num, player.name, rate, needsRating);
      });
    }
    return;
  }

  // Does any team block genuinely lack a rate column? That's the signature
  // of the shifted/bled layout, where the rightmost grid column never gets
  // an inline rate at all. If none are missing, there's nothing to shift --
  // just apply each team's own trailing rates directly.
  const anyTeamMissingRate = teamsList.some(t => t.players.length > 0 && t.trailingRates.length === 0);

  if (!anyTeamMissingRate) {
    for (const team of teamsList) {
      team.players.forEach((p, i) => {
        addPlayer(registry, rosters, team.id, p.num, p.name, team.trailingRates[i], needsRating);
      });
    }
    return;
  }

  // Shifted layout: teams were declared in column-major order (all of
  // column 1 top-to-bottom, then column 2, then column 3, ...).
  const groupSize = Math.ceil(teamsList.length / columns);
  const groups = [];
  for (let c = 0; c < columns; c++) {
    groups.push(teamsList.slice(c * groupSize, (c + 1) * groupSize));
  }

  const numRows = groups[0].length;
  const numBlocks = preambleBlocks.length;
  // Preamble blocks arrive "late" relative to the row they belong to when
  // there are fewer blocks than rows -- assign them to the LAST numBlocks
  // rows of column 0, leaving the earliest rows unresolved.
  const blockRowOffset = Math.max(0, numRows - numBlocks);

  for (let r = 0; r < numRows; r++) {
    let priorTrailing = null;
    if (r >= blockRowOffset) {
      priorTrailing = preambleBlocks[r - blockRowOffset];
    }

    for (let c = 0; c < columns; c++) {
      const team = groups[c][r];
      if (!team) continue;

      const trueRates = c === 0 ? priorTrailing : groups[c - 1][r].trailingRates;

      team.players.forEach((p, i) => {
        const rate = trueRates ? trueRates[i] : undefined;
        addPlayer(registry, rosters, team.id, p.num, p.name, rate, needsRating);
      });
    }
  }
}


export { extractIbaReportWeek, extractIbaReportPrintedOnDate, extractIbaReportWeeksByDivision, parseStandingsImport, parseMvpImport, parseLeagueRoster };
