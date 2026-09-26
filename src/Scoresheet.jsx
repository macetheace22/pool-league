import { useState, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, FileText, Table as TableIcon, X } from "lucide-react";

const TEAM_RATING_LIMIT = 325; // only used in open/advanced

// Converts a completed_matches row's state.sets (live-entry shape) into the
// shape this component's rendering logic was originally built around.
// playerA = home, playerB = away (arbitrary but consistent -- the original
// prototype's "top row / bottom row" convention mattered for matching a
// physical scanned scoresheet; for a computed view it doesn't).
function toDisplaySets(match) {
  const venue = match.venue || "—";
  return (match.state?.sets ?? [])
    .filter(s => s.complete && s.playerHome && s.playerAway)
    .map(s => {
      if (s.forfeited) {
        return {
          setNum: s.setNum, venue,
          playerA: { name: s.playerHome.name, rating: s.playerHome.rating ?? 0, team: "home" },
          playerB: { name: s.playerAway.name, rating: s.playerAway.rating ?? 0, team: "away" },
          racks: [], finalA: 0, finalB: 0,
          winnerSide: s.winnerSlot === "home" ? "a" : s.winnerSlot === "away" ? "b" : null,
          source: match.source,
          totalInnings: 0, safetiesA: 0, safetiesB: 0,
          forfeited: true, forfeitedBy: s.forfeitedBy, forfeitPoints: s.forfeitPoints ?? 0,
        };
      }
      let runA = 0, runB = 0;
      const racks = (s.racks ?? []).map((r, i) => {
        runA += r.home ?? 0;
        runB += r.away ?? 0;
        return { n: i + 1, a: r.home ?? 0, b: r.away ?? 0, innings: r.innings ?? 0, timeoutA: !!r.timeoutHome, timeoutB: !!r.timeoutAway, runA, runB };
      });
      const safetiesA = (s.racks ?? []).reduce((t, r) => t + (r.safetyHome ?? 0), 0);
      const safetiesB = (s.racks ?? []).reduce((t, r) => t + (r.safetyAway ?? 0), 0);
      return {
        setNum: s.setNum,
        venue,
        playerA: { name: s.playerHome.name, rating: s.playerHome.rating ?? 0, team: "home" },
        playerB: { name: s.playerAway.name, rating: s.playerAway.rating ?? 0, team: "away" },
        racks,
        finalA: runA,
        finalB: runB,
        winnerSide: s.winnerSlot === "home" ? "a" : s.winnerSlot === "away" ? "b" : null,
        source: match.source,
        totalInnings: (s.racks ?? []).reduce((t, r) => t + (r.innings || 0), 0),
        safetiesA, safetiesB,
      };
    });
}

function ratingBonPen(used) {
  const diff = TEAM_RATING_LIMIT - used;
  if (diff >= 0) return { amount: diff, mult: 1, sign: "+", label: "Under" };
  return { amount: Math.abs(diff), mult: 5, sign: "-", label: "Over" };
}

function computeSetRollup(set, format) {
  const isMasters = (format || "masters").toLowerCase() === "masters";
  const homeSlot = set.playerA.team === "home" ? "a" : "b";
  const awaySlot = homeSlot === "a" ? "b" : "a";
  if (set.forfeited) {
    const totalHome = set.forfeitedBy === "home" ? 0 : set.forfeitPoints;
    const totalAway = set.forfeitedBy === "home" ? set.forfeitPoints : 0;
    return { marginHome: 0, marginAway: 0, addOnHome: 0, addOnAway: 0, winBonusHome: 0, winBonusAway: 0, totalHome, totalAway, homeSlot, awaySlot };
  }
  const winnerSide = set.winnerSide;
  // Margin is measured against what the loser actually raced to -- their
  // true rating normally, or the fixed 45/50 target if either player in the
  // set was unrated (NR), not the loser's raw (and possibly 0/1/2) rating.
  const eitherUnrated = isUnratedRating(set.playerA.rating) || isUnratedRating(set.playerB.rating);
  const fixedTarget = (format || "masters").toLowerCase() === "open" ? 45 : 50;
  const targetA = eitherUnrated ? fixedTarget : set.playerA.rating;
  const targetB = eitherUnrated ? fixedTarget : set.playerB.rating;
  let marginForA = 0, marginForB = 0, addOnA = 0, addOnB = 0, winBonusA = 0, winBonusB = 0;
  if (winnerSide === "a") {
    marginForA = Math.max(0, targetB - set.finalB);
    addOnA = marginForA * 3;
    winBonusA = 100;
  } else if (winnerSide === "b") {
    marginForB = Math.max(0, targetA - set.finalA);
    addOnB = marginForB * 3;
    winBonusB = 100;
  }
  const marginHome = homeSlot === "a" ? marginForA : marginForB;
  const marginAway = homeSlot === "a" ? marginForB : marginForA;
  const addOnHome  = homeSlot === "a" ? addOnA  : addOnB;
  const addOnAway  = homeSlot === "a" ? addOnB  : addOnA;
  const winBonusHome = homeSlot === "a" ? winBonusA : winBonusB;
  const winBonusAway = homeSlot === "a" ? winBonusB : winBonusA;
  const finalHome  = homeSlot === "a" ? set.finalA : set.finalB;
  const finalAway  = homeSlot === "a" ? set.finalB : set.finalA;
  const totalHome = isMasters
    ? (set.winnerSide === homeSlot ? addOnHome + winBonusHome : 0)
    : finalHome + addOnHome + winBonusHome;
  const totalAway = isMasters
    ? (set.winnerSide === awaySlot ? addOnAway + winBonusAway : 0)
    : finalAway + addOnAway + winBonusAway;
  return { marginHome, marginAway, addOnHome, addOnAway, winBonusHome, winBonusAway, totalHome, totalAway, homeSlot, awaySlot };
}

function FrontSheetSet({ set }) {
  const gameCount = set.racks.length;
  const totalInnings = set.totalInnings ?? set.racks.reduce((s, r) => s + (r.innings || 0), 0);
  const containerRef = useRef(null);

  const ROWLABEL_W = 108;
  const SAFETIES_W = 40;
  const RACK_W = 34;
  const TOTAL_W = 60;
  const BASELINE_RACKS = 5;

  const baselineColumnCount = BASELINE_RACKS + 3;
  const containerWidthPx =
    ROWLABEL_W + SAFETIES_W + BASELINE_RACKS * RACK_W + TOTAL_W + baselineColumnCount + 1;

  const actualColumnCount = gameCount + 3;
  const tableWidthPx =
    ROWLABEL_W + SAFETIES_W + gameCount * RACK_W + TOTAL_W + actualColumnCount + 1;

  const fillerWidthPx = Math.max(0, containerWidthPx - tableWidthPx);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const scrollers = Array.from(root.querySelectorAll(`[data-scroll-group="set-${set.setNum}"]`));
    if (scrollers.length < 2) return;
    let syncing = false;
    const handlers = scrollers.map((el) => {
      const onScroll = () => {
        if (syncing) return;
        syncing = true;
        scrollers.forEach((other) => { if (other !== el) other.scrollLeft = el.scrollLeft; });
        syncing = false;
      };
      el.addEventListener("scroll", onScroll);
      return { el, onScroll };
    });
    return () => { handlers.forEach(({ el, onScroll }) => el.removeEventListener("scroll", onScroll)); };
  }, [set.setNum]);

  const renderTable = (side) => {
    const isA = side === "a";
    const player = isA ? set.playerA : set.playerB;
    const isHome = player.team === "home";
    const headerClass = `rack-grid__player-header${isHome ? " rack-grid__player-header--home" : " rack-grid__player-header--away"}`;
    const rowClass = isHome ? "rack-grid__row-home" : "rack-grid__row-away";
    const totalRowClass = isHome ? "rack-grid__row-home-total" : "rack-grid__row-away-total";
    const safeties = isA ? (set.safetiesA ?? 0) : (set.safetiesB ?? 0);
    const finalScore = isA ? set.finalA : set.finalB;
    const chipClass = isHome ? "timeout-chip--home" : "timeout-chip--away";
    const timeoutKey = isA ? "timeoutA" : "timeoutB";

    return (
      <div className="rack-grid__group" style={{ width: `${containerWidthPx}px` }}>
        <div className={headerClass}>
          <div className="rack-grid__player-header-inner">
            <span className="rack-grid__player-name">{player.name}</span>
            <span className="rack-grid__player-rating">Rated {player.rating}</span>
          </div>
        </div>

        <div className="rack-grid__scroll" data-scroll-group={`set-${set.setNum}`}>
          <table style={{ width: `${tableWidthPx + fillerWidthPx}px`, tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: `${ROWLABEL_W}px` }} />
              <col style={{ width: `${SAFETIES_W}px` }} />
              {set.racks.map((r) => <col key={r.n} style={{ width: `${RACK_W}px` }} />)}
              <col style={{ width: `${TOTAL_W}px` }} />
              {fillerWidthPx > 0 && <col style={{ width: `${fillerWidthPx}px` }} />}
            </colgroup>
            <thead>
              <tr>
                <th className="rack-grid__rowlabel rack-grid__rowlabel--th"></th>
                <th className="rack-grid__safeties-col">Saf.</th>
                {set.racks.map((r) => <th key={r.n}>{r.n}</th>)}
                <th className="rack-grid__total-col">Total</th>
                {fillerWidthPx > 0 && <th className="rack-grid__filler-col" style={{ width: `${fillerWidthPx}px` }}></th>}
              </tr>
            </thead>
            <tbody>
              <tr className={rowClass}>
                <td className="rack-grid__rowlabel">Game</td>
                <td className="rack-grid__safeties-col">{safeties}</td>
                {set.racks.map((r) => <td key={r.n}>{isA ? r.a : r.b}</td>)}
                <td className="rack-grid__total-col"></td>
                {fillerWidthPx > 0 && <td className="rack-grid__filler-col"></td>}
              </tr>
              <tr className={totalRowClass}>
                <td className="rack-grid__rowlabel">Total</td>
                <td className="rack-grid__safeties-col"></td>
                {set.racks.map((r) => <td key={r.n}>{isA ? r.runA : r.runB}</td>)}
                <td className="rack-grid__total-col rack-grid__total-col--strong">{finalScore}</td>
                {fillerWidthPx > 0 && <td className="rack-grid__filler-col"></td>}
              </tr>
              <tr className="rack-grid__row-timeout">
                <td className="rack-grid__rowlabel rack-grid__rowlabel--timeout">Timeout</td>
                <td className="rack-grid__safeties-col"></td>
                {set.racks.map((r) => (
                  <td key={r.n} className="rack-grid__timeout-cell">
                    {r[timeoutKey] && <span className={`timeout-chip ${chipClass}`}>TO</span>}
                  </td>
                ))}
                <td className="rack-grid__total-col"></td>
                {fillerWidthPx > 0 && <td className="rack-grid__filler-col"></td>}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="set-sheet" ref={containerRef}>
      <div className="set-sheet__header">
        <span className="set-sheet__num">Set #{set.setNum}</span>
        <span className="set-sheet__venue">{set.venue}</span>
      </div>
      <div className={`data-source-tag ${set.source === "live" || set.source === "manual" ? "data-source-tag--verified" : "data-source-tag--illustrative"}`}>
        {set.source === "live" ? "✓ Rack-by-rack data from Live Entry"
          : set.source === "manual" ? "✓ Rack-by-rack data (entered manually)"
          : "Imported record — summary only"}
      </div>
      <div className="rack-grid">
        {renderTable("a")}
        {renderTable("b")}
      </div>
      <div className="set-sheet__footer">
        <span>{gameCount} games · {totalInnings} innings</span>
      </div>
      {set.winnerSide && (() => {
        const winner = set.winnerSide === "a" ? set.playerA : set.playerB;
        const winScore = set.winnerSide === "a" ? set.finalA : set.finalB;
        const loseScore = set.winnerSide === "a" ? set.finalB : set.finalA;
        return (
          <div className={`set-winner-badge set-winner-badge--${winner.team}`}>
            {winner.name} won the set {winScore} to {loseScore}
          </div>
        );
      })()}
    </div>
  );
}

// Ratings of 0, 1, or 2 signal a new/unrated (NR) player -- for team rating
// total purposes they count as the format's fixed race target (45 Open, 50
// Advanced/Masters), same number an NR player actually races to on the
// table. A rated player always counts as their true rating here, even in a
// set where they raced to the fixed number because their opponent was NR.
const UNRATED_MAX = 2;
function isUnratedRating(rating) {
  return rating != null && rating <= UNRATED_MAX;
}
function ratingForTeamTotal(rating, format) {
  if (isUnratedRating(rating)) return (format || "masters").toLowerCase() === "open" ? 45 : 50;
  return rating;
}

function BackSheet({ match, sets }) {
  const isMasters = match.format === "masters";
  const teamHomeRatingTotal = sets.reduce((s, set) => s + ratingForTeamTotal(set.playerA.team === "home" ? set.playerA.rating : set.playerB.rating, match.format), 0);
  const teamAwayRatingTotal = sets.reduce((s, set) => s + ratingForTeamTotal(set.playerA.team === "away" ? set.playerA.rating : set.playerB.rating, match.format), 0);
  const rollups = sets.map((set) => ({ set, rollup: computeSetRollup(set, match.format) }));
  const subTotalHome = rollups.reduce((s, r) => s + r.rollup.totalHome, 0);
  const subTotalAway = rollups.reduce((s, r) => s + r.rollup.totalAway, 0);
  const bonPenHome = ratingBonPen(teamHomeRatingTotal);
  const bonPenAway = ratingBonPen(teamAwayRatingTotal);
  const teamPointTotalHome = isMasters
    ? subTotalHome
    : subTotalHome + (bonPenHome.sign === "+" ? bonPenHome.amount * bonPenHome.mult : -bonPenHome.amount * bonPenHome.mult);
  const teamPointTotalAway = isMasters
    ? subTotalAway
    : subTotalAway + (bonPenAway.sign === "+" ? bonPenAway.amount * bonPenAway.mult : -bonPenAway.amount * bonPenAway.mult);

  const matchWinner = teamPointTotalHome > teamPointTotalAway ? "home" : teamPointTotalAway > teamPointTotalHome ? "away" : null;

  return (
    <div className="back-sheet">
      <div className="back-sheet__columns">
        <TeamColumn teamName={match.team_home_name} rollups={rollups} team="home" isMasters={isMasters} format={match.format} ratingTotal={teamHomeRatingTotal} bonPen={bonPenHome} teamPointTotal={teamPointTotalHome} />
        <TeamColumn teamName={match.team_away_name} rollups={rollups} team="away" isMasters={isMasters} format={match.format} ratingTotal={teamAwayRatingTotal} bonPen={bonPenAway} teamPointTotal={teamPointTotalAway} />
      </div>
      <div className={`back-sheet__final${matchWinner ? ` back-sheet__final--${matchWinner}` : ""}`}>
        <div className="back-sheet__final-team">
          <div className="back-sheet__final-name">{match.team_home_name}</div>
          <div className="back-sheet__final-score">{teamPointTotalHome}</div>
        </div>
        <div className="back-sheet__final-divider">FINAL</div>
        <div className="back-sheet__final-team back-sheet__final-team--right">
          <div className="back-sheet__final-name">{match.team_away_name}</div>
          <div className="back-sheet__final-score">{teamPointTotalAway}</div>
        </div>
      </div>
    </div>
  );
}

function TeamColumn({ teamName, rollups, team, isMasters, format, ratingTotal, bonPen, teamPointTotal }) {
  const isHome = team === "home";
  return (
    <div className={`team-col ${isHome ? "team-col--home" : "team-col--away"}`}>
      <div className="team-col__name">{teamName}</div>
      <div className="team-col__table-wrap">
        <table className="team-col__table">
          <thead>
            <tr>
              <th>Opp Rate</th>
              <th>Opp Score</th>
              <th>Margin</th>
              <th>Add-On</th>
              <th>Win Bonus</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {rollups.map(({ set, rollup }) => {
              const oppPlayer = set.playerA.team === team ? set.playerB : set.playerA;
              const mySlot    = set.playerA.team === team ? "a" : "b";
              const oppScore  = mySlot === "a" ? set.finalB : set.finalA;
              const margin    = team === "home" ? rollup.marginHome : rollup.marginAway;
              const addOn     = team === "home" ? rollup.addOnHome  : rollup.addOnAway;
              const winBonus  = team === "home" ? rollup.winBonusHome : rollup.winBonusAway;
              const total     = team === "home" ? rollup.totalHome  : rollup.totalAway;
              const won       = set.winnerSide === mySlot;
              if (set.forfeited) {
                const iForfeited = set.forfeitedBy === team;
                return (
                  <tr key={set.setNum} className={won ? `team-col__row--won team-col__row--won-${team}` : ""}>
                    <td>{oppPlayer.rating}</td>
                    <td colSpan={4} style={{color:"#B45309",fontWeight:700,fontSize:10.5}}>{iForfeited ? "FORFEITED" : "FORFEIT RECEIVED"}</td>
                    <td className="team-col__total-cell">{total}</td>
                  </tr>
                );
              }
              const eitherUnrated = isUnratedRating(set.playerA.rating) || isUnratedRating(set.playerB.rating);
              const oppRateDisplay = eitherUnrated
                ? `${(format||"masters").toLowerCase()==="open"?45:50} (NR)`
                : oppPlayer.rating;
              return (
                <tr key={set.setNum} className={won ? `team-col__row--won team-col__row--won-${team}` : ""}>
                  <td>{oppRateDisplay}</td>
                  <td>{oppScore}</td>
                  <td>{won ? `${margin}×3` : "—"}</td>
                  <td>{won && addOn > 0 ? addOn : "—"}</td>
                  <td>{won ? winBonus : "—"}</td>
                  <td className="team-col__total-cell">{total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!isMasters && (
        <div className="team-col__rating-box">
          <div className="team-col__rating-row"><span>Team Rating Total</span><strong>{ratingTotal}</strong></div>
          <div className="team-col__rating-row"><span>Limit</span><strong>{TEAM_RATING_LIMIT}</strong></div>
          <div className={`team-col__rating-row team-col__rating-row--${bonPen.sign === "+" ? "bonus" : "penalty"}`}>
            <span>{bonPen.label} by {bonPen.amount} × {bonPen.mult}</span>
            <strong>{bonPen.sign}{bonPen.amount * bonPen.mult}</strong>
          </div>
        </div>
      )}
      <div className="team-col__final"><span>Team Total Points</span><strong>{teamPointTotal}</strong></div>
    </div>
  );
}

export default function Scoresheet({ match, onClose }) {
  const [view, setView] = useState("front");
  const [setIndex, setSetIndex] = useState(0);
  const sets = toDisplaySets(match);
  const isMasters = match.format === "masters";
  const shortTeamName = match.state?.makeup?.shortTeam === "home" ? match.team_home_name
    : match.state?.makeup?.shortTeam === "away" ? match.team_away_name : null;
  const makeupBanner = match.is_makeup_pending ? (
    <div className="makeup-pending-banner">
      <strong>Makeup Pending</strong> — {sets.length} of 5 tables played. The rest need to be rescheduled to complete this match.
      {shortTeamName && <div className="makeup-pending-banner__reason"><strong style={{color:"#F59E0B"}}>{shortTeamName}</strong> is short players.{match.state?.makeup?.reason ? ` ${match.state.makeup.reason}` : ""}</div>}
    </div>
  ) : null;

  if (sets.length === 0) {
    return (
      <div className="scoresheet-app">
        <style>{css}</style>
        <button className="scoresheet-close" onClick={onClose}><X size={14}/> Back to History</button>
        <div className="empty-state-ss">No rack-by-rack detail was recorded for this match.</div>
      </div>
    );
  }

  return (
    <div className="scoresheet-app">
      <style>{css}</style>
      <button className="scoresheet-close" onClick={onClose}><X size={14}/> Back to History</button>
      {makeupBanner}
      <div className="app__header">
        <div className="app__header-meta">{match.venue || "—"} · {match.week_num ? `Week ${match.week_num}` : match.week_date || ""} · {isMasters ? "IBA Masters Format" : "IBA Advanced Format"}</div>
        <div className="app__header-title">{match.team_home_name} <span className="vs-sm">vs</span> {match.team_away_name}</div>
      </div>
      <div className="view-toggle">
        <button className={`view-toggle__btn ${view === "front" ? "view-toggle__btn--active" : ""}`} onClick={() => setView("front")}>
          <TableIcon size={14} /> Game Detail
        </button>
        <button className={`view-toggle__btn ${view === "back" ? "view-toggle__btn--active" : ""}`} onClick={() => setView("back")}>
          <FileText size={14} /> Team Scoresheet
        </button>
      </div>
      {view === "front" ? (
        <>
          <div className="set-nav">
            <button className="set-nav__btn" disabled={setIndex === 0} onClick={() => setSetIndex((i) => Math.max(0, i - 1))}>
              <ChevronLeft size={16} />
            </button>
            <span className="set-nav__label">Set {setIndex + 1} of {sets.length}</span>
            <button className="set-nav__btn" disabled={setIndex === sets.length - 1} onClick={() => setSetIndex((i) => Math.min(sets.length - 1, i + 1))}>
              <ChevronRight size={16} />
            </button>
          </div>
          <FrontSheetSet set={sets[setIndex]} />
        </>
      ) : (
        <BackSheet match={match} sets={sets} />
      )}
    </div>
  );
}

const css = `
.scoresheet-app { font-family: 'Archivo', sans-serif; background: #0E0E0E; padding: 14px; color: #FFFFFF; display: flex; flex-direction: column; gap: 12px; }
.scoresheet-close { display: flex; align-items: center; gap: 6px; background: none; border: none; color: #5FCF9E; font-family: 'Archivo', sans-serif; font-size: 13px; font-weight: 700; cursor: pointer; padding: 0; align-self: flex-start; }
.empty-state-ss { font-size: 12.5px; color: #5A5A5A; text-align: center; padding: 24px; background: #1C1C1C; border: 1.5px solid #2E2E2E; border-radius: 10px; }

.app__header { background: #0B3D2E; background-image: radial-gradient(circle at 50% 0%, #0F4A37 0%, #0B3D2E 70%); border-radius: 14px; padding: 16px 18px; color: #FFFFFF; }
.makeup-pending-banner { background: #2A1F00; border: 1.5px solid #92400E; border-radius: 12px; padding: 10px 14px; margin-bottom: 12px; font-size: 12px; color: #E0E0E0; line-height: 1.5; }
.makeup-pending-banner strong { color: #F59E0B; }
.makeup-pending-banner__reason { font-size: 11.5px; color: #9A9A9A; margin-top: 4px; }
.app__header-meta { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: #9FC4B4; font-weight: 700; margin-bottom: 6px; }
.app__header-title { font-family: 'Archivo Black', sans-serif; font-size: 17px; color: #FFFFFF; }
.vs-sm { font-family: 'Archivo', sans-serif; font-weight: 400; color: #7FA593; font-size: 13px; margin: 0 4px; }

.view-toggle { display: flex; background: #1C1C1C; border: 1.5px solid #333333; border-radius: 11px; padding: 4px; gap: 4px; }
.view-toggle__btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px; border-radius: 8px; border: none; background: none; font-family: inherit; font-size: 12.5px; font-weight: 700; color: #9A9A9A; cursor: pointer; }
.view-toggle__btn--active { background: #0B3D2E; color: #FFFFFF; }

.set-nav { display: flex; align-items: center; justify-content: center; gap: 14px; }
.set-nav__btn { width: 32px; height: 32px; border-radius: 50%; border: 1.5px solid #3A3A3A; background: #1C1C1C; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #E0E0E0; }
.set-nav__btn:disabled { opacity: 0.3; cursor: not-allowed; }
.set-nav__label { font-size: 12.5px; font-weight: 700; color: #E0E0E0; min-width: 80px; text-align: center; }

.set-sheet { background: #FFFFFF; border: 1.5px solid #333333; border-radius: 14px; padding: 14px; }
.data-source-tag { font-size: 10px; font-weight: 600; padding: 6px 10px; border-radius: 7px; margin-bottom: 12px; text-align: center; }
.data-source-tag--verified { background: #16332A; color: #5FCF9E; }
.data-source-tag--illustrative { background: #2A2A2A; color: #9A9A9A; }
.set-sheet__header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.set-sheet__num { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #5A5A5A; }
.set-sheet__venue { font-size: 11px; font-weight: 700; color: #FFFFFF; background: #3A3A3A; padding: 3px 9px; border-radius: 20px; }

.rack-grid__player-header { display: block; color: #FFFFFF; font-size: 12.5px; }
.rack-grid__player-header--home { background: #0B3D2E; }
.rack-grid__player-header--away { background: #1E3A5F; }
.rack-grid__player-header-inner { display: flex; align-items: center; gap: 8px; padding: 8px 10px; width: 100%; box-sizing: border-box; }
.rack-grid__rowlabel--th { text-align: left !important; background: #F2F2F2 !important; }
.rack-grid__player-name { font-size: 12.5px; font-weight: 700; color: #FFFFFF; white-space: nowrap; }
.rack-grid__player-rating { font-size: 10.5px; font-weight: 700; color: #FFFFFF; background: rgba(255,255,255,0.15); padding: 2px 8px; border-radius: 20px; white-space: nowrap; }

.rack-grid { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.rack-grid__group { border: 1px solid #333333; border-radius: 8px; overflow: hidden; max-width: 100%; min-width: 0; }
.rack-grid__scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; min-width: 0; }
.rack-grid table { border-collapse: collapse; table-layout: fixed; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #1A1A1A; }
.rack-grid th, .rack-grid td { padding: 7px 6px; text-align: center; border-bottom: 1px solid #E5E5E5; border-right: 1px solid #E5E5E5; width: 34px; min-width: 34px; max-width: 34px; }
.rack-grid th { background: #F2F2F2; font-weight: 700; color: #6A6A6A; font-family: 'Archivo', sans-serif; font-size: 10px; text-transform: uppercase; }
.rack-grid__rowlabel { text-align: left !important; font-family: 'Archivo', sans-serif !important; font-weight: 600; font-size: 10px !important; color: #4A4A4A; width: 108px !important; min-width: 108px !important; max-width: 108px !important; padding-left: 6px !important; padding-right: 8px !important; white-space: nowrap; position: sticky; left: 0; background: #FFFFFF; }
.rack-grid__rowlabel--timeout { vertical-align: middle; }
.rack-grid__safeties-col { background: #F7F7F7; font-weight: 700; color: #4A4A4A; font-size: 10.5px; width: 40px !important; min-width: 40px !important; max-width: 40px !important; }
.rack-grid__total-col { background: #F2F2F2; font-weight: 700; width: 60px !important; min-width: 60px !important; max-width: 60px !important; }
.rack-grid__total-col--strong { color: #1A1A1A; font-size: 12px; font-weight: 700; }
.rack-grid__filler-col { background: transparent; border-right: none !important; padding: 0 !important; }
.rack-grid__row-timeout td { background: #FAFAFA; height: 26px; padding-top: 0; padding-bottom: 0; }
.rack-grid__timeout-cell { text-align: center; vertical-align: middle; padding-left: 0; padding-right: 0; }
.timeout-chip { display: inline-block; font-family: 'Archivo', sans-serif; font-size: 8px; font-weight: 700; line-height: 1; padding: 4px 5px; border-radius: 5px; white-space: nowrap; }
.timeout-chip--home { background: #DCEAE2; color: #1F6B4A; }
.timeout-chip--away { background: #DCE6F0; color: #1E3A5F; }
.rack-grid__row-home-total td, .rack-grid__row-away-total td { background: #EFEFEF; font-weight: 700; }
.rack-grid__row-home-total .rack-grid__rowlabel, .rack-grid__row-away-total .rack-grid__rowlabel { background: #EFEFEF; }

.set-sheet__footer { display: flex; justify-content: center; align-items: center; font-size: 11px; color: #5A5A5A; margin-top: 10px; margin-bottom: 10px; }
.set-winner-badge { width: 100%; box-sizing: border-box; text-align: center; font-size: 13px; font-weight: 700; padding: 10px 12px; border-radius: 10px; }
.set-winner-badge--home { color: #5FCF9E; background: #16332A; border: 1.5px solid #1F6B4A; }
.set-winner-badge--away { color: #6FA8DC; background: #16273A; border: 1.5px solid #1E3A5F; }

.back-sheet { display: flex; flex-direction: column; gap: 14px; }
.back-sheet__columns { display: flex; flex-direction: column; gap: 14px; }
.team-col { background: #FFFFFF; border: 1.5px solid #D0D0D0; border-radius: 14px; padding: 14px; }
.team-col__name { font-size: 13px; font-weight: 700; color: #1F6B4A; margin-bottom: 10px; }
.team-col--away .team-col__name { color: #1E3A5F; }
.team-col__table-wrap { border: 1px solid #333333; border-radius: 8px; overflow: hidden; margin-bottom: 10px; }
.team-col__table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.team-col__table th { text-align: center; padding: 5px 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; color: #FFFFFF; background: #0B3D2E; border-bottom: none; }
.team-col--away .team-col__table th { background: #1E3A5F; }
.team-col__table td { text-align: center; padding: 6px 3px; border-bottom: 1px solid #E5E5E5; font-family: 'JetBrains Mono', monospace; color: #1A1A1A; }
.team-col__row--won-home { background: #DCEAE2; }
.team-col__row--won-away { background: #DCE6F0; }
.team-col__total-cell { font-weight: 700; color: #1A1A1A; }
.team-col__rating-box { background: #F7F7F7; border: 1px solid #D0D0D0; border-radius: 8px; padding: 9px 10px; margin-bottom: 8px; }
.team-col__rating-row { display: flex; justify-content: space-between; font-size: 11px; color: #5A5A5A; padding: 3px 0; }
.team-col__rating-row strong { font-family: 'JetBrains Mono', monospace; color: #1A1A1A; }
.team-col__rating-row--bonus strong { color: #1F6B4A; }
.team-col__rating-row--penalty strong { color: #C05A10; }
.team-col__final { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: #0B3D2E; border-radius: 9px; color: #FFFFFF; font-size: 12.5px; font-weight: 700; }
.team-col--away .team-col__final { background: #1E3A5F; }
.team-col__final strong { font-family: 'Archivo Black', sans-serif; font-size: 18px; color: #FFFFFF; }

.back-sheet__final { display: flex; align-items: center; justify-content: space-between; background: #FFFFFF; border: 1.5px solid #D0D0D0; border-radius: 14px; padding: 16px 18px; }
.back-sheet__final--home { background: #0B3D2E; border-color: #0B3D2E; }
.back-sheet__final--away { background: #1E3A5F; border-color: #1E3A5F; }
.back-sheet__final-team { flex: 1; }
.back-sheet__final-team--right { text-align: right; }
.back-sheet__final-name { font-size: 11px; font-weight: 600; color: #6A6A6A; margin-bottom: 2px; }
.back-sheet__final--home .back-sheet__final-name, .back-sheet__final--away .back-sheet__final-name { color: rgba(255,255,255,0.65); }
.back-sheet__final-score { font-family: 'Archivo Black', sans-serif; font-size: 32px; color: #1A1A1A; }
.back-sheet__final--home .back-sheet__final-score, .back-sheet__final--away .back-sheet__final-score { color: #FFFFFF; }
.back-sheet__final-divider { font-size: 9px; letter-spacing: 0.12em; font-weight: 700; color: #AAAAAA; padding: 0 14px; }
.back-sheet__final--home .back-sheet__final-divider, .back-sheet__final--away .back-sheet__final-divider { color: rgba(255,255,255,0.45); }
`;
