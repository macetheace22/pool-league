import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider } from './AuthContext.jsx';
import AdminApp from './AdminApp.jsx';
import LiveEntryApp from './LiveEntryApp.jsx';
import { NavHistoryProvider } from './Shell.jsx';
import { Home, LeaguesDashboard, LeagueOffice, SeasonManagementHub, TournamentsPlaceholder, TeamsPlayersDashboard } from './Dashboard.jsx';
import Practice from './Practice.jsx';
import Schedules from './Schedules.jsx';
import LeagueNewsManager from './LeagueNews.jsx';
import { ActiveSessionProvider } from './ActiveSessionContext.jsx';

// Reset the document scroll position whenever the active route changes.
// This covers links, bottom-tab navigation, and browser Back/Forward without
// resetting scroll for in-page state changes such as filters or saves.
function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [pathname]);

  return null;
}

// Shared save-button feedback: once a field changes, the nearest Save/Update
// action turns green until it is clicked. This keeps the behavior consistent
// across existing forms without requiring every screen to implement its own state.
function DirtySaveButtonBehavior() {
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.dirtySaveBehavior = 'true';
    style.textContent = `
      button.save-button--dirty {
        background: #126B46 !important;
        border-color: #5FCF9E !important;
        color: #FFFFFF !important;
        box-shadow: 0 0 0 1px rgba(95, 207, 158, 0.28) !important;
      }
      button.save-button--dirty:hover:not(:disabled) {
        background: #188357 !important;
      }
    `;
    document.head.appendChild(style);

    const isSaveButton = (button) => {
      const label = (button.innerText || button.getAttribute('aria-label') || button.title || '').trim();
      return /^(save|update|apply changes|save changes|save and continue|update password|update profile|save game|save role|save username|save phone number|save player number|save division|save season)\b/i.test(label)
        || button.classList.contains('btn-icon--confirm');
    };

    const nearestSaveButton = (field) => {
      let node = field.parentElement;
      while (node && node !== document.body) {
        const candidates = Array.from(node.querySelectorAll('button')).filter(isSaveButton);
        if (candidates.length) {
          if (candidates.length === 1) return candidates[0];
          const fieldRect = field.getBoundingClientRect();
          const fieldX = fieldRect.left + fieldRect.width / 2;
          const fieldY = fieldRect.top + fieldRect.height / 2;
          return candidates.reduce((closest, candidate) => {
            const rect = candidate.getBoundingClientRect();
            const distance = Math.hypot(fieldX - (rect.left + rect.width / 2), fieldY - (rect.top + rect.height / 2));
            return !closest || distance < closest.distance ? { button: candidate, distance } : closest;
          }, null)?.button ?? null;
        }
        node = node.parentElement;
      }
      return null;
    };

    const onFieldChange = (event) => {
      const field = event.target;
      if (!(field instanceof HTMLElement) || !field.matches('input,select,textarea,[contenteditable="true"]')) return;
      const button = nearestSaveButton(field);
      if (button) button.classList.add('save-button--dirty');
    };
    const onButtonClick = (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (button && isSaveButton(button)) button.classList.remove('save-button--dirty');
    };

    document.addEventListener('input', onFieldChange, true);
    document.addEventListener('change', onFieldChange, true);
    document.addEventListener('click', onButtonClick, true);
    return () => {
      document.removeEventListener('input', onFieldChange, true);
      document.removeEventListener('change', onFieldChange, true);
      document.removeEventListener('click', onButtonClick, true);
      style.remove();
    };
  }, []);
  return null;
}


function MyStatsBrowserErrorCapture() {
  const [failure, setFailure] = React.useState(null);
  const [breadcrumbs, setBreadcrumbs] = React.useState([]);

  React.useEffect(() => {
    const addBreadcrumb = (event) => {
      setBreadcrumbs(current => [...current.slice(-7), event.detail]);
    };
    const onError = (event) => {
      const error = event.error;
      setFailure({
        type: "Browser runtime error",
        message: event.message || error?.message || "Unknown browser error",
        source: event.filename ? `${event.filename}:${event.lineno || 0}:${event.colno || 0}` : "",
        stack: error?.stack || "",
      });
    };
    const onRejection = (event) => {
      const reason = event.reason;
      setFailure({
        type: "Unhandled promise rejection",
        message: reason?.message || String(reason ?? "Unknown rejection"),
        source: "",
        stack: reason?.stack || "",
      });
    };
    window.addEventListener("my-stats-filter-debug", addBreadcrumb);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("my-stats-filter-debug", addBreadcrumb);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  if (!failure) return null;
  return (
    <div role="alert" style={{position:"fixed",inset:"12px",zIndex:2147483647,overflow:"auto",background:"#160D0D",color:"#FFF",border:"2px solid #E05252",borderRadius:12,padding:16,fontFamily:"sans-serif",boxShadow:"0 8px 40px #000"}}>
      <h2 style={{fontSize:18,margin:"0 0 10px"}}>My Stats browser error captured</h2>
      <div style={{fontSize:13,fontWeight:700,color:"#FF9B9B"}}>{failure.type}</div>
      <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontSize:12,lineHeight:1.45}}>{failure.message}{failure.source ? "\\n" + failure.source : ""}{failure.stack ? "\\n\\n" + failure.stack : ""}</pre>
      {breadcrumbs.length > 0 && <>
        <div style={{fontWeight:700,fontSize:12,marginTop:12}}>Filter actions immediately before the error</div>
        <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontSize:11}}>{breadcrumbs.map(item => JSON.stringify(item)).join("\\n")}</pre>
      </>}
      <button type="button" onClick={() => setFailure(null)} style={{padding:"10px 14px",borderRadius:8,border:"1px solid #888",background:"#333",color:"#FFF"}}>Dismiss diagnostic</button>
    </div>
  );
}

class MyStatsRouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: "" };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const componentStack = info?.componentStack ?? "";
    console.error("My Stats route failed to render", error, componentStack);
    this.setState({ componentStack });
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{maxWidth:640,margin:"24px auto",padding:16,color:"#E0E0E0",fontFamily:"sans-serif"}}>
          <section style={{background:"#1C1C1C",border:"1px solid #7F3030",borderRadius:12,padding:16}}>
            <h2 style={{fontSize:18,margin:"0 0 10px"}}>My Stats could not be displayed</h2>
            <p style={{fontSize:13,lineHeight:1.5,color:"#F0A0A0"}}>A rendering error occurred in the My Stats page. Your saved league and practice data has not been changed.</p>
            <details open style={{marginTop:12,fontSize:12,whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>
              <summary>Technical details — please share this with support</summary>
              <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{this.state.error?.stack || this.state.error?.message || String(this.state.error)}{this.state.componentStack ? "\\n\\nReact component stack:\\n" + this.state.componentStack : ""}</pre>
            </details>
            <button type="button" onClick={() => this.setState({error:null,componentStack:""})} style={{marginTop:14,padding:"10px 14px",borderRadius:8,border:"1px solid #666",background:"#292929",color:"#FFF"}}>Try again</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ScrollToTop />
      <DirtySaveButtonBehavior />
      <NavHistoryProvider>
        <AuthProvider>
          <ActiveSessionProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/leagues" element={<LeaguesDashboard />} />
            <Route path="/teams-and-players" element={<TeamsPlayersDashboard />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/league-office" element={<LeagueOffice />} />
            <Route path="/season-management" element={<SeasonManagementHub />} />
            <Route path="/practice" element={<Practice />} />
            <Route path="/tournaments" element={<TournamentsPlaceholder />} />
            <Route path="/seasons" element={<AdminApp page="seasons" />} />
            <Route path="/manage-divisions" element={<AdminApp page="divisions" />} />
            <Route path="/manage" element={<Navigate to="/season-management" replace />} />
            <Route path="/manual-season-import" element={<AdminApp page="manual-import" />} />
            <Route path="/playoff-eligibility" element={<AdminApp page="playoff-eligibility" />} />
            <Route path="/playoffs" element={<AdminApp page="playoffs" />} />
            <Route path="/locations" element={<AdminApp page="locations" />} />
            <Route path="/weekly-data" element={<AdminApp page="weekly" />} />
            <Route path="/matches" element={<AdminApp page="matches" />} />
            <Route path="/team-info" element={<AdminApp page="teaminfo" />} />
            <Route path="/my-team" element={<AdminApp page="myteam" />} />
            <Route path="/player-lookup" element={<AdminApp page="players" />} />
            <Route path="/team-lookup" element={<AdminApp page="teamlookup" />} />
            <Route path="/team-standings" element={<AdminApp page="standings" />} />
            <Route path="/mvp-standings" element={<AdminApp page="mvp" />} />
            <Route path="/match-lookup" element={<AdminApp page="matchlkp" />} />
            <Route path="/leaderboard" element={<AdminApp page="leaderboard" />} />
            <Route path="/my-stats" element={<><MyStatsBrowserErrorCapture /><MyStatsRouteErrorBoundary><AdminApp page="stats" /></MyStatsRouteErrorBoundary></>} />
            <Route path="/league-news" element={<LeagueNewsManager />} />
            <Route path="/access" element={<AdminApp page="access" />} />
            <Route path="/me" element={<AdminApp page="me" />} />
            <Route path="/live" element={<LiveEntryApp />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </ActiveSessionProvider>
        </AuthProvider>
      </NavHistoryProvider>
    </BrowserRouter>
  </React.StrictMode>
);
