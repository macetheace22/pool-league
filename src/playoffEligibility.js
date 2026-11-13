// Eligibility codes come from the official IBA playoff roster report.
// Each report is a division-wide snapshot: a player absent from the newest
// report is Unverified, not eligible by virtue of an older report.
export function latestPlayoffEligibilityRows(rows) {
  const dated = (rows ?? []).filter(row => {
    const key = String(row.week_key ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
    const date = new Date(`${key}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key;
  });
  if (!dated.length) return [];
  const latestWeekKey = dated.reduce(
    (latest, row) => String(row.week_key) > latest ? String(row.week_key) : latest,
    "",
  );
  return dated.filter(row => String(row.week_key) === latestWeekKey);
}

export function eligibilityByPlayerNum(rows) {
  const map = {};
  for (const row of latestPlayoffEligibilityRows(rows)) {
    if (row.player_num) {
      map[row.player_num] = {
        code: row.elig_code,
        weekKey: row.week_key,
        label: row.label,
      };
    }
  }
  return map;
}
