import { useEffect, useMemo, useState } from "react";
import { Calendar, ChevronDown, MapPin, RefreshCw, Trophy } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import * as db from "./db";
import { PageHeader, TabBar, shellCss } from "./Shell.jsx";
import { useAuth } from "./AuthContext";
import { css as adminCss } from "./AdminApp.jsx";
import { dashboardCss } from "./Dashboard.jsx";

const css = `
.schedules-page{padding-bottom:86px;}
.schedules-controls{display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:12px;}
.schedule-control{display:flex;flex-direction:column;gap:4px;}
.schedule-control__label{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#8A8A8A;}
.schedule-select{width:100%;box-sizing:border-box;background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:10px;color:#E0E0E0;padding:10px 36px 10px 12px;font-size:12px;font-weight:700;appearance:none;}
.schedule-select-wrap{position:relative;}
.schedule-select-wrap svg{position:absolute;right:11px;top:50%;transform:translateY(-50%);pointer-events:none;color:#6A6A6A;}
.schedule-summary{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;padding:14px;margin-bottom:10px;}
.schedule-summary__title{font-family:'Archivo Black',sans-serif;font-size:14px;font-weight:800;color:#FFF;}
.schedule-summary__meta{font-size:10.5px;color:#8A8A8A;margin-top:3px;}
.schedule-week{background:#1C1C1C;border:1.5px solid #2E2E2E;border-radius:14px;overflow:hidden;margin-bottom:10px;}
.schedule-week--current{border-color:#1F6B4A;}
.schedule-week__head{padding:12px 14px;background:#1C1C1C;border-bottom:1px solid #2A2A2A;display:flex;align-items:center;justify-content:space-between;gap:8px;}
.schedule-week__label{font-size:12px;font-weight:800;color:#E0E0E0;}
.schedule-week__date{font-size:10px;color:#8A8A8A;margin-top:2px;}
.schedule-badge{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:4px 6px;border-radius:5px;background:#2A2A2A;color:#9A9A9A;white-space:nowrap;}
.schedule-badge--current{background:#0F2D1F;color:#5FCF9E;}
.schedule-match{padding:11px 14px;border-bottom:1px solid #2A2A2A;}
.schedule-match:last-child{border-bottom:none;}
.schedule-match__teams{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;}
.schedule-team{font-size:12px;font-weight:700;color:#E0E0E0;line-height:1.25;}
.schedule-team--away{text-align:right;}
.schedule-team__venue{font-size:9.5px;font-weight:600;color:#6F6F6F;margin-top:3px;}
.schedule-vs{font-size:9px;font-weight:800;color:#555;text-transform:uppercase;}
.schedule-match__venue{display:flex;align-items:center;gap:4px;font-size:9.5px;color:#777;margin-top:7px;}
.schedule-empty{padding:22px 10px;text-align:center;color:#6A6A6A;font-size:11px;}
.schedule-note{margin-top:10px;font-size:10px;color:#666;display:flex;align-items:center;gap:5px;}
@media(min-width:640px){.schedules-controls{grid-template-columns:1fr 1fr}.schedule-match__teams{grid-template-columns:1fr 70px 1fr;}}
`;

function parseScheduleDate(value) {
  if (!value) return null;
  const m = String(value).match(/^(\\d{1,2})[\\/\\-](\\d{1,2})[\\/\\-](\\d{2,4})/);
  if (!m) return null;
  const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(year, Number(m[1]) - 1, Number(m[2]));
  d.setHours(0,0,0,0);
  return Number.isNaN(d.getTime()) ? null : d;
}

function seasonLabel(s) {
  const type = s?.type ? String(s.type) : "";
  const year = s?.year ? String(s.year) : "";
  return [type, year].filter(Boolean).join(" ") || "Season";
}

export default function Schedules() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const requestedSeasonId = params.get("season");
  const requestedDivisionId = params.get("division");

  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState(requestedSeasonId || "");
  const [divisionId, setDivisionId] = useState(requestedDivisionId || "");
  const [status, setStatus] = useState(null);
  const [teams, setTeams] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedWeekId, setSelectedWeekId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    db.listSeasons()
      .then(rows => {
        if (cancelled) return;
        setSeasons(rows);

        const memberships = (profile?.team_memberships ?? [])
          .map(m => m.teams)
          .filter(Boolean);
        const preferredMembership = memberships.find(
          team => team.divisions?.seasons?.is_active
        ) || memberships[0];
        const preferredDivisionId = preferredMembership?.divisions?.id || "";
        const preferredSeasonId = preferredMembership?.divisions?.seasons?.id || "";

        const preferred = rows.find(s => s.id === requestedSeasonId)
          || rows.find(s => s.id === preferredSeasonId)
          || rows.find(s => s.is_active)
          || rows[0];

        if (preferred) {
          setSeasonId(preferred.id);
          setParams(p => {
            p.set("season", preferred.id);
            const divisionStillValid = requestedDivisionId
              && preferred.divisions?.some(d => d.id === requestedDivisionId);
            const userDivisionValid = preferred.divisions?.some(d => d.id === preferredDivisionId);
            if (divisionStillValid) p.set("division", requestedDivisionId);
            else if (userDivisionValid) p.set("division", preferredDivisionId);
            else p.delete("division");
            return p;
          }, { replace: true });
        }
      })
      .catch(e => !cancelled && setError(e?.message || "Unable to load seasons."))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [profile]);

  useEffect(() => {
    if (!seasonId) return;
    let cancelled = false;
    setStatus(null);
    setDivisionId("");
    setTeams([]);
    setSchedule([]);
    setSelectedWeekId(null);
    db.getIbaScheduleImportStatus(seasonId).then(next => {
      if (cancelled) return;
      setStatus(next);
      const preferred = next.divisions?.find(d => d.id === requestedDivisionId) || next.divisions?.[0];
      if (preferred) {
        setDivisionId(preferred.id);
        setParams(p => { p.set("season", seasonId); p.set("division", preferred.id); return p; }, { replace: true });
      }
    }).catch(e => !cancelled && setError(e?.message || "Unable to load schedule status."));
    return () => { cancelled = true; };
  }, [seasonId]);

  useEffect(() => {
    if (!divisionId) return;
    let cancelled = false;
    setScheduleLoading(true);
    setError("");
    (async () => {
      try {
        const nextTeams = await db.listTeams(divisionId);
        const nextSchedule = await db.listSchedule(divisionId, nextTeams);
        if (cancelled) return;
        setTeams(nextTeams);
        setSchedule(nextSchedule);
        const today = new Date(); today.setHours(0,0,0,0);
        const dated = nextSchedule.map(w => ({...w, _date: parseScheduleDate(w.date)}));
        const next = dated.find(w => w._date && w._date >= today) || dated.find(w => w.pairings?.length);
        setSelectedWeekId(next?.id ?? nextSchedule[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(e?.message || "Unable to load the selected schedule.");
      } finally {
        if (!cancelled) setScheduleLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [divisionId]);

  const season = seasons.find(s => s.id === seasonId);
  const division = status?.divisions?.find(d => d.id === divisionId);
  const teamsById = useMemo(() => Object.fromEntries(teams.map(t => [t.id, t])), [teams]);

  const selectedWeek = schedule.find(w => w.id === selectedWeekId) || null;
  const currentWeekId = useMemo(() => {
    const today = new Date(); today.setHours(0,0,0,0);
    const dated = schedule.map(w => ({...w, _date: parseScheduleDate(w.date)}));
    return (dated.find(w => w._date && w._date >= today) || dated.find(w => w.pairings?.length))?.id || null;
  }, [schedule]);

  const setSeason = id => {
    setSeasonId(id);
    setParams(p => { p.set("season", id); p.delete("division"); return p; }, { replace: true });
  };
  const setDivision = id => {
    setDivisionId(id);
    setParams(p => { p.set("season", seasonId); p.set("division", id); return p; }, { replace: true });
  };

  const sortedSchedule = useMemo(() => [...schedule].sort((a, b) => {
    const dateA = parseScheduleDate(a.date);
    const dateB = parseScheduleDate(b.date);
    if (dateA && dateB) return dateA - dateB;
    if (dateA) return -1;
    if (dateB) return 1;
    return (a.week ?? Number.MAX_SAFE_INTEGER) - (b.week ?? Number.MAX_SAFE_INTEGER);
  }), [schedule]);

  const displayWeeks = selectedWeekId === "all"
    ? sortedSchedule
    : (selectedWeek ? [selectedWeek] : []);

  return (
    <div className="app">
      <style>{adminCss}</style><style>{dashboardCss}</style><style>{css}</style><style>{shellCss}</style>
      <PageHeader title="Schedules" />
      <div className="tab-content schedules-page">
        <div className="schedules-controls">
          <div className="schedule-control">
            <div className="schedule-control__label">Season</div>
            <div className="schedule-select-wrap">
              <select className="schedule-select" value={seasonId} onChange={e => setSeason(e.target.value)} disabled={loading}>
                {!seasons.length && <option value="">Loading seasons…</option>}
                {seasons.some(s => s.is_active) && (
                  <optgroup label="Active Seasons">
                    {seasons.filter(s => s.is_active).map(s => (
                      <option key={s.id} value={s.id}>{seasonLabel(s)} · Active</option>
                    ))}
                  </optgroup>
                )}
                {seasons.some(s => !s.is_active) && (
                  <optgroup label="Past Seasons">
                    {seasons.filter(s => !s.is_active).map(s => (
                      <option key={s.id} value={s.id}>{seasonLabel(s)}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              <ChevronDown size={14}/>
            </div>
          </div>
          <div className="schedule-control">
            <div className="schedule-control__label">Division</div>
            <div className="schedule-select-wrap">
              <select className="schedule-select" value={divisionId} onChange={e => setDivision(e.target.value)} disabled={!status?.divisions?.length}>
                {!status?.divisions?.length && <option value="">No imported divisions</option>}
                {(status?.divisions ?? []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <ChevronDown size={14}/>
            </div>
          </div>
        </div>

        {loading || scheduleLoading ? (
          <div className="empty-state"><RefreshCw size={16} className="spin" style={{verticalAlign:"middle",marginRight:6}}/> Loading schedule…</div>
        ) : error ? (
          <div className="import-warning-block"><div className="import-warning-block__title">{error}</div></div>
        ) : !status?.hasSchedule ? (
          <div className="empty-state">No imported schedule is available for this season yet.</div>
        ) : (
          <>
            <div className="schedule-summary">
              <div className="schedule-summary__title">{seasonLabel(season)} · {division?.name || "Division"}</div>
              <div className="schedule-summary__meta">{teams.length} teams · {schedule.length} weeks · {schedule.reduce((n,w)=>n+(w.pairings?.length||0),0)} matchups</div>
            </div>

            <div className="schedule-control" style={{ marginBottom: 10 }}>
              <div className="schedule-control__label">Week</div>
              <div className="schedule-select-wrap">
                <select
                  className="schedule-select"
                  value={selectedWeekId || ""}
                  onChange={e => setSelectedWeekId(e.target.value)}
                >
                  <option value="all">All Weeks</option>
                  {sortedSchedule.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.week ? `Week ${w.week}` : (w.special || "Schedule")}
                      {w.id === currentWeekId ? " · Current" : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14}/>
              </div>
            </div>

            {displayWeeks.length ? displayWeeks.map(week => {
              const rows = (week.pairings ?? []).map(p => ({
                ...p,
                home: teamsById[p.homeTeamId],
                away: teamsById[p.awayTeamId],
              }));
              const isCurrent = week.id === currentWeekId;
              return (
                <div className={`schedule-week ${isCurrent ? "schedule-week--current" : ""}`} key={week.id}>
                  <div className="schedule-week__head">
                    <div>
                      <div className="schedule-week__label">{week.week ? `Week ${week.week}` : "Schedule"}</div>
                      <div className="schedule-week__date">{week.date || week.special || "Date not listed"}</div>
                    </div>
                    <span className={`schedule-badge ${isCurrent ? "schedule-badge--current" : ""}`}>
                      {isCurrent ? "Current" : week.isPlayoff ? (week.playoffLabel || "Playoff") : "Scheduled"}
                    </span>
                  </div>
                  {rows.length ? rows.map(p => (
                    <div className="schedule-match" key={p.id}>
                      <div className="schedule-match__teams">
                        <div className="schedule-team">
                          {p.home?.name || "Home TBD"}
                          {p.home?.venue && <div className="schedule-team__venue">{p.home.venue}</div>}
                        </div>
                        <div className="schedule-vs">vs</div>
                        <div className="schedule-team schedule-team--away">
                          {p.away?.name || "Away TBD"}
                          {p.away?.venue && <div className="schedule-team__venue">{p.away.venue}</div>}
                        </div>
                      </div>
                      {p.home?.venue && <div className="schedule-match__venue"><MapPin size={10}/> {p.home.venue}</div>}
                    </div>
                  )) : <div className="schedule-empty">No matchups listed for this week.</div>}
                </div>
              );
            }) : (
              <div className="schedule-empty">No schedule week is available.</div>
            )}
          </>
        )}

        <div className="schedule-note">
          <Trophy size={11}/> Schedules are imported from IBA and can be refreshed by league management.
        </div>
      </div>
      <TabBar />
    </div>
  );
}
