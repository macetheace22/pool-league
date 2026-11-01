export default function TeamContextSelector({ teams = [], value, onChange }) {
  if (!Array.isArray(teams) || teams.length < 2) return null;
  return <div className="card" style={{marginBottom:10}}><div className="field" style={{margin:0}}><label className="field-label" htmlFor="team-context-select">Team</label><select id="team-context-select" className="input" value={value ?? ""} onChange={event => onChange?.(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id}>{team.name}{team.context ? " · " + team.context : ""}</option>)}</select></div></div>;
}
