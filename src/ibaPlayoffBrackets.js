// Parse the postseason bracket pages embedded in IBA Division PDFs.
//
// The regular "div" report already carries both weekly standings and the
// published postseason bracket pages. The bracket is therefore an additional
// structure extracted from the same report; it is not a new IBA report URL.
//
// The app's generated bracket remains the provisional structure. The parser
// returns the printed first-round seed/match structure so the import layer can
// compare the IBA publication against that provisional structure and reconcile
// only when the imported structure is unambiguous.

const RANK_RE = /^(\\d+)(?:st|nd|rd|th)$/i;
const TEAM_NUM_RE = /^(?=.*\\d)[A-Z0-9]{5,8}$/i;

function cleanLine(value) {
  return String(value ?? "")
    .replace(/\\s+/g, " ")
    .replace(/[|]+/g, " ")
    .trim();
}

function isNoiseLine(line) {
  return !line ||
    /^(?:IBA\\s*\\/|International Billiards|Winter|Spring|Summer|Fall|Season|Report printed|Printed|Division\\b|MVP\\b|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/i.test(line) ||
    /^#?\\d{1,4}\\s*-?\\s*Division$/i.test(line);
}

function isTeamNumber(line) {
  const value = cleanLine(line);
  return TEAM_NUM_RE.test(value) && !/^\\d{4}[-/]\\d{1,2}/.test(value);
}

function normalizeBracketType(heading) {
  return /consolation/i.test(heading) ? "consolation" : "championship";
}

function extractDivisionNum(lines) {
  for (const line of lines) {
    const match = cleanLine(line).match(/#\\s*(\\d{1,4})\\s*-?\\s*Division\\b/i)
      || cleanLine(line).match(/\\bDivision\\s*#?\\s*(\\d{1,4})\\b/i);
    if (match) return match[1];
  }
  return null;
}

function extractTeamName(lines, seedIndex) {
  for (let i = seedIndex - 1; i >= Math.max(0, seedIndex - 3); i--) {
    const candidate = cleanLine(lines[i]);
    if (!candidate || isNoiseLine(candidate) || RANK_RE.test(candidate) || isTeamNumber(candidate)) continue;
    if (/play-?offs?|division champions?|consolation|championship/i.test(candidate)) continue;
    return candidate;
  }
  return null;
}

function parseBracketSection(lines, heading, divisionNum, bracketIndex) {
  const teams = [];
  for (let i = 0; i < lines.length; i++) {
    const rank = cleanLine(lines[i]).match(RANK_RE);
    if (!rank) continue;

    let teamNumIndex = -1;
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      if (isTeamNumber(lines[j])) {
        teamNumIndex = j;
        break;
      }
    }
    if (teamNumIndex < 0) continue;

    const seed = Number(rank[1]);
    const teamNum = cleanLine(lines[teamNumIndex]);
    const name = extractTeamName(lines, i);
    if (!name) continue;

    teams.push({ seed, teamNum, name, printedOrder: teams.length });
    i = teamNumIndex;
  }

  // The printed bracket is authoritative for matchup order. Do not
  // reconstruct a standard seed formula here; IBA's visual order can differ
  // on larger brackets. Consecutive printed seed entries form the first-round
  // pairings.
  const matches = [];
  for (let i = 0; i + 1 < teams.length; i += 2) {
    const home = teams[i];
    const away = teams[i + 1];
    matches.push({
      slot: matches.length + 1,
      seedHome: home.seed,
      seedAway: away.seed,
      teamNumHome: home.teamNum,
      teamNumAway: away.teamNum,
      teamNameHome: home.name,
      teamNameAway: away.name,
    });
  }

  return {
    bracketType: normalizeBracketType(heading),
    bracketGroup: `${normalizeBracketType(heading)}-${bracketIndex + 1}`,
    bracketLabel: cleanLine(heading) || `${normalizeBracketType(heading)} Bracket ${bracketIndex + 1}`,
    divisionNum,
    teams,
    firstRoundMatches: matches,
    parseError: teams.length < 2 || teams.length % 2 !== 0
      ? "The published bracket did not yield a complete set of first-round team entries."
      : null,
  };
}

export function parseIbaPlayoffBrackets(raw) {
  const pages = String(raw || "")
    .split(/\f|\n\s*PAGE\s+\d+\s*\n/ig)
    .map(page => page.split(/\r?\n/).map(cleanLine).filter(Boolean))
    .filter(page => page.length);

  const brackets = [];
  const warnings = [];
  const divisionNum = extractDivisionNum(pages.flat());

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const lines = pages[pageIndex];
    const headings = lines.filter(line => /\b(?:Championship|Consolation)\s+Play-?Offs?\b/i.test(line));
    if (!headings.length) continue;

    const heading = headings[0];
    // PDF text extraction can place the heading after the teams because the
    // original PDF is laid out in multiple columns. Parse the entire page,
    // not only the text after the heading.
    const bracket = parseBracketSection(lines, heading, divisionNum, brackets.length);
    if (bracket.teams.length) {
      bracket.pageIndex = pageIndex;
      brackets.push(bracket);
    } else {
      warnings.push({
        pageIndex,
        reason: "A postseason bracket heading was found, but no seed/team entries could be read from that page.",
      });
    }
  }

  // Some text extractors remove form-feed/page boundaries. In that case,
  // fall back to heading-delimited sections. This is intentionally only a
  // fallback; the page-aware path above is preferred because the IBA bracket
  // is a visual artifact.
  if (!brackets.length) {
    const allLines = String(raw || "").split(/\r?\n/).map(cleanLine).filter(Boolean);
    const headingIndexes = [];
    allLines.forEach((line, index) => {
      if (/\b(?:Championship|Consolation)\s+Play-?Offs?\b/i.test(line)) headingIndexes.push(index);
    });
    headingIndexes.forEach((headingIndex, index) => {
      const nextHeading = headingIndexes[index + 1] ?? allLines.length;
      const bracket = parseBracketSection(allLines.slice(Math.max(0, headingIndex - 30), nextHeading), allLines[headingIndex], divisionNum, brackets.length);
      if (bracket.teams.length) brackets.push(bracket);
    });
  }

  return {
    detected: brackets.length > 0,
    divisionNum,
    brackets,
    warnings,
  };
}

// Normalize only the structure that can safely be compared before results
// exist. Team names are display text; team numbers and printed seeds are the
// stable identifiers.
export function normalizeImportedPlayoffBracket(bracket) {
  return {
    bracketType: bracket?.bracketType ?? null,
    bracketGroup: bracket?.bracketGroup ?? null,
    firstRoundMatches: (bracket?.firstRoundMatches ?? []).map(match => ({
      slot: Number(match.slot),
      seedHome: Number(match.seedHome),
      seedAway: Number(match.seedAway),
      teamNumHome: String(match.teamNumHome ?? "").trim(),
      teamNumAway: String(match.teamNumAway ?? "").trim(),
    })),
  };
}

export function compareImportedPlayoffBracket(imported, generated) {
  const left = normalizeImportedPlayoffBracket(imported);
  const right = normalizeImportedPlayoffBracket(generated);

  const differences = [];
  if (left.bracketType !== right.bracketType) {
    differences.push({ field: "bracketType", imported: left.bracketType, generated: right.bracketType });
  }

  const max = Math.max(left.firstRoundMatches.length, right.firstRoundMatches.length);
  for (let i = 0; i < max; i++) {
    const a = left.firstRoundMatches[i];
    const b = right.firstRoundMatches[i];
    if (!a || !b) {
      differences.push({ field: `firstRoundMatches[${i}]`, imported: a ?? null, generated: b ?? null });
      continue;
    }
    for (const field of ["seedHome", "seedAway", "teamNumHome", "teamNumAway"]) {
      if (String(a[field]) !== String(b[field])) {
        differences.push({ field: `firstRoundMatches[${i}].${field}`, imported: a[field], generated: b[field] });
      }
    }
  }

  return {
    matches: differences.length === 0,
    differences,
    imported: left,
    generated: right,
  };
}
