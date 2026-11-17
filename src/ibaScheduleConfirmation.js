// Canonical representation used to decide whether two independent IBA
// schedule retrievals agree. Keep the source team order because IBA matchup
// values are positional (1-based); normalize object fields, not team positions.
export function serializeIbaScheduleSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("A schedule snapshot is required.");
  }
  const teams = (Array.isArray(snapshot.teams) ? snapshot.teams : []).map(team => ({
    teamNum: String(team?.teamNum ?? team?.team_num ?? "").trim(),
    name: String(team?.name ?? "").trim(),
    venue: String(team?.venue ?? team?.location ?? "").trim(),
    isBye: Boolean(team?.isBye ?? team?.is_bye),
    isTbd: Boolean(team?.isTbd ?? team?.is_tbd),
  }));
  const weeks = (Array.isArray(snapshot.weeks) ? snapshot.weeks : [])
    .map(week => ({
      week: week?.week ?? week?.week_num ?? week?.weekNumber ?? null,
      date: String(week?.date ?? "").trim(),
      special: String(week?.special ?? "").trim(),
      pairings: (Array.isArray(week?.pairings) ? week.pairings : []).map(pairing => ({
        home: pairing?.homeTeamNum ?? pairing?.home_team_num ?? pairing?.homeTeamId ?? pairing?.home_team_id ?? pairing?.home ?? null,
        away: pairing?.awayTeamNum ?? pairing?.away_team_num ?? pairing?.awayTeamId ?? pairing?.away_team_id ?? pairing?.away ?? null,
        homeTbdCode: pairing?.homeTbdCode ?? pairing?.home_tbd_code ?? null,
        awayTbdCode: pairing?.awayTbdCode ?? pairing?.away_tbd_code ?? null,
      })),
    }))
    .sort((a, b) => {
      const aw = Number(a.week), bw = Number(b.week);
      if (Number.isFinite(aw) && Number.isFinite(bw) && aw !== bw) return aw - bw;
      return a.date.localeCompare(b.date) || a.special.localeCompare(b.special);
    });
  return JSON.stringify({ teams, weeks });
}

// A fresh UUID must be generated for every actual fetch attempt. The database
// rejects duplicate retrieval IDs so retries cannot accidentally count twice.
export function createIbaScheduleRetrievalId() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure UUID generation is unavailable in this browser.");
  }
  return globalThis.crypto.randomUUID();
}
