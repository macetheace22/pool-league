import { useEffect, useMemo, useState } from "react";
import { Calendar, ChevronDown, MapPin, RefreshCw, Trophy } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import * as db from "./db";
import { PageHeader, TabBar, shellCss } from "./Shell.jsx";

const css = `
.schedules-page{padding-bottom:86px;}
.schedules-controls{display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:12px;}
.schedule-select{width:100%;box-sizing:border-box;background:#1C1C1C;border:1.5px solid #333;border-radius:9px;color:#E8E8E8;padding:10px 34px 10px 11px;font-size:12px;font-weight:700;appearance:none;}
.schedule-select-wrap{position:relative;}
.schedule-select-wrap svg{position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:#7A7A7A;}
.schedule-summary{background:#101010;border:1px solid #282828;border-radius:10px;padding:11px 12px;margin-bottom:10px;}
.schedule-summary__title{font-size:14px;font-weight:800;color:#F0F0F0;}
.schedule-summary__meta{font-size:10.5px;color:#8A8A8A;margin-top:3px;}
.schedule-week-nav{display:flex;gap:6px;overflow-x:auto;padding-bottom:3px;margin-bottom:10px;}
.schedule-week-btn{flex:0 0 auto;border:1px solid #333;background:#181818;color:#A8A8A8;border-radius:8px;padding:7px 9px;font-size:10.5px;font-weight:700;cursor:pointer;}
.schedule-week-btn--active{background:#0F2D1F;border-color:#1F6B4A;color:#5FCF9E;}
.schedule-week-btn--next{box-shadow:inset 0 0 0 1px #5FCF9E;}
.schedule-week{background:#171717;border:1px solid #2A2A2A;border-radius:12px;overflow:hidden;margin-bottom:9px;}
.schedule-week__head{padding:10px 11px;background:#1B1B1B;border-bottom:1px solid #292929;display:flex;align-items:center;justify-content:space-between;gap:8px;}
.schedule-week__label{font-size:12px;font-weight:800;color:#E8E8E8;}
.schedule-week__date{font-size:10px;color:#7F7F7F;margin-top:2px;}
.schedule-badge{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:4px 6px;border-radius:5px;background:#242424;color:#9A9A9A;white-space:nowrap;}
.schedule-badge--next{background:#0F2D1F;color:#5FCF9E;}
.schedule-match{padding:11px;border-bottom:1px solid #262626;}
.schedule-match:last-child{border-bottom:none;}
.schedule-match__teams{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;}
.schedule-team{font-size:12px;font-weight:800;color:#E5E5E5;line-height:1.25;}
.schedule-team--away{text-align:right;}
.schedule-team__venue{font-size:9.5px;font-weight:600;color:#6F6F6F;margin-top:3px;}
.schedule-vs{font-size:9px;font-weight:800;color:#555;text-transform:uppercase;}
.schedule-match__venue{display:flex;align-items:center;gap:4px;font-size:9.5px;color:#777;margin-top:7px;}
.schedule-empty{padding:22px 10px;text-align:center;color:#777;font-size:11px;}
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
        const preferred = rows.find(s => s.id === requestedSeasonId)
          || rows.find(s => s.is_active)
          || rows[0];
        if (preferred && !requestedSeasonId) {
          setSeasonId(preferred.id);
          setParams(p => { p.set("season", preferred.id); p.delete("division"); return p; }, { replace: true });
        }
      })
      .catch(e => !cancelled && setError(e?.message || "Unable to load seasons."))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

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
  const nextWeekId = useMemo(() => {
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

  const pairingRows = (selectedWeek?.pairings ?? []).map(p => ({
    ...p,
    home: teamsById[p.homeTeamId],
    away: teamsById[p.awayTeamId],
  }));

  return (
    <div className="app">
      <style>{css}</style><style>{shellCss}</style>
      <PageHeader title="Schedules" subtitle="IBA league schedules" />
      <div className="tab-content schedules-page">
        <div className="schedules-controls">
          <div className="schedule-select-wrap">
            <select className="schedule-select" value={seasonId} onChange={e => setSeason(e.target.value)} disabled={loading}>
              {!seasons.length && <option value="">Loading seasons…</option>}
              {seasons.map(s => <option key={s.id} value={s.id}>{seasonLabel(s)}{s.is_active ? " · Active" : ""}</option>)}
            </select>
            <ChevronDown size={14}/>
          </div>
          <div className="schedule-select-wrap">
            <select className="schedule-select" value={divisionId} onChange={e => setDivision(e.target.value)} disabled={!status?.divisions?.length}>
              {!status?.divisions?.length && <option value="">No imported divisions</option>}
              {(status?.divisions ?? []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <ChevronDown size={14}/>
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

            <div className="schedule-week-nav" aria-label="Schedule weeks">
              {schedule.map(w => {
                const active = w.id === selectedWeekId;
                const next = w.id === nextWeekId;
                return (
                  <button key={w.id} className={`schedule-week-btn ${active ? "schedule-week-btn--active" : ""} ${next ? "schedule-week-btn--next" : ""}`} onClick={() => setSelectedWeekId(w.id)}>
                    {w.week ? `Week ${w.week}` : w.special || "Week"}
                  </button>
                );
              })}
            </div>

            {selectedWeek ? (
              <div className="schedule-week">
                <div className="schedule-week__head">
                  <div>
                    <div className="schedule-week__label">{selectedWeek.week ? `Week ${selectedWeek.week}` : "Schedule"}</div>
                    <div className="schedule-week__date">{selectedWeek.date || selectedWeek.special || "Date not listed"}</div>
                  </div>
                  <span className={`schedule-badge ${selectedWeek.id === nextWeekId ? "schedule-badge--next" : ""}`}>
                    {selectedWeek.id === nextWeekId ? "Next" : selectedWeek.isPlayoff ? (selectedWeek.playoffLabel || "Playoff") : "Scheduled"}
                  </span>
                </div>
                {pairingRows.length ? pairingRows.map(p => (
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
            ) : (
              <div className="schedule-empty">No schedule week is available.</div>
            )}
          </>
        )}

        <div style={{marginTop:10,fontSize:10,color:"#666",display:"flex",alignItems:"center",gap:5}}>
          <Trophy size={11}/> Schedules are imported from IBA and can be refreshed by league management.
        </div>
      </div>
      <TabBar />
    </div>
  );
}
