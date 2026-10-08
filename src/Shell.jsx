import { useState, useEffect, useRef, useContext, createContext } from "react";
import { Link, useNavigate, useLocation, useNavigationType } from "react-router-dom";
import {
  Menu, X, ChevronLeft, LogOut, UserCircle, Calendar, Settings2, Upload,
  Trophy, Eye, Users, Search, ClipboardList, Key, Building2,
  Home, Dumbbell, Award, TrendingUp, Wrench, BarChart3,
} from "lucide-react";
import { useAuth } from "./AuthContext";

// ─── In-app navigation history ─────────────────────────────────────────────
// Tracks how many real in-app navigations deep the current page is, purely
// from PUSH/POP/REPLACE events on this router -- not the raw browser
// history stack. That distinction matters: calling navigate(-1) blindly can
// walk a user right out of the app (to whatever tab/site was open before
// they arrived), which is a bad surprise on a phone. This only ever reports
// "can go back" when there's a real prior in-app page to land on, and
// "back" always means "back to a page inside this app."
const NavHistoryContext = createContext({ canGoBack: false, goBack: () => {} });
export function useNavHistory() { return useContext(NavHistoryContext); }

export function NavHistoryProvider({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType(); // "PUSH" | "POP" | "REPLACE"
  const depthRef = useRef(0);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    if (navType === "PUSH") depthRef.current += 1;
    else if (navType === "POP") depthRef.current = Math.max(0, depthRef.current - 1);
    // REPLACE (e.g. the unknown-URL redirect to "/") doesn't change depth --
    // it swaps the current entry rather than adding a real page to return to.
    setCanGoBack(depthRef.current > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const goBack = () => { if (depthRef.current > 0) navigate(-1); };

  return <NavHistoryContext.Provider value={{ canGoBack, goBack }}>{children}</NavHistoryContext.Provider>;
}

// ─── Top-level navigation destinations ─────────────────────────────────────
// Single source of truth for the landing hub grid AND the hamburger drawer.
// `roles` gates visibility; a manager sees everything, captains/players see
// only what applies to them.
// ─── League Office menu ─────────────────────────────────────────────────────
// Every admin/reference page from before the dashboard redesign, now reached
// from inside the Leagues tab instead of a flat hamburger list. `roles`
// still gates visibility -- a manager sees everything, a captain sees their
// scoped subset, a player sees just the shared reference pages.
export const LEAGUE_OFFICE_ITEMS = [
  { key: "seasons",  label: "Create or Update Seasons",     path: "/seasons",      roles: ["manager"],                     icon: Calendar },
  { key: "manage",   label: "Manage Season Data",           path: "/manage",       roles: ["manager"],                     icon: Settings2 },
  { key: "weekly",   label: "Update Weekly League Data",    path: "/weekly-data",  roles: ["manager"],                     icon: Upload },
  { key: "access",   label: "Manage App Access",            path: "/access",       roles: ["manager"],                     icon: Key },
  { key: "myteam",   label: "Manage My Team",               path: "/my-team",      roles: ["captain"],                     icon: Users },
  { key: "schedules", label: "Schedules",                    path: "/schedules",      roles: ["manager", "captain", "player"], icon: Calendar },
  { key: "matches",  label: "Current League Matches",       path: "/matches",      roles: ["manager", "captain", "player"], icon: Trophy },
  { key: "teaminfo", label: "Team & Player Information",    path: "/team-info",    roles: ["manager", "captain", "player"], icon: Eye },
  { key: "players",  label: "Player Lookup / History",      path: "/player-lookup", roles: ["manager", "captain", "player"], icon: Search },
  { key: "teamlkp",  label: "Team Lookup / History",        path: "/team-lookup",  roles: ["manager", "captain", "player"], icon: Building2 },
  { key: "matchlkp", label: "Match Lookup / History",       path: "/match-lookup", roles: ["manager", "captain", "player"], icon: ClipboardList },
  { key: "leaderboard", label: "Advanced Stats Leaderboard", path: "/leaderboard", roles: ["manager", "captain", "player"], icon: TrendingUp },
];

export function navItemsForRole(role) {
  return LEAGUE_OFFICE_ITEMS.filter(item => item.roles.includes(role));
}

// Shared confirmation for every Sign Out entry point (page header, drawer,
// Hub footer) -- one place to keep the prompt wording consistent, and to
// guard against an accidental tap signing someone out mid-match.
export function confirmAndLogout(logout) {
  return () => { if (window.confirm("Sign out of the IBA Pool App?")) logout(); };
}

// ─── Bottom tab bar ─────────────────────────────────────────────────────────
// Primary navigation between the app's top-level areas. Stays visible (and
// highlights the right tab) even while deep inside nested pages -- e.g. any
// League Office page still shows "Leagues" active, so switching areas is
// always one tap regardless of how far in you've drilled.
//
// The League Office LANDING page itself (/league-office) was never actually
// included in that "any League Office page" match below -- only its child
// items (LEAGUE_OFFICE_ITEMS' own paths) were. That meant visiting the
// office list page directly left every tab unhighlighted. Managers now get
// a dedicated fifth tab straight to it, so their case is handled by an exact
// match on their own tab; everyone else still reaches League Office via the
// Leagues tab's office-card link, so /league-office is added to Leagues'
// own match for them.
const BASE_TABS = [
  { key: "home",        label: "Home",        path: "/",            icon: Home,     match: (p) => p === "/" },
  { key: "practice",    label: "Practice",     path: "/practice",    icon: Dumbbell, match: (p) => p.startsWith("/practice") },
  { key: "tournaments", label: "Tournaments",  path: "/tournaments", icon: Award,    match: (p) => p.startsWith("/tournaments") },
];

function tabsForRole(role) {
  const isManager = role === "manager";
  const leagues = {
    key: "leagues", label: "Leagues", path: "/leagues", icon: Trophy,
    match: (p) => p.startsWith("/leagues")
      || LEAGUE_OFFICE_ITEMS.some(it => p.startsWith(it.path))
      || (!isManager && p === "/league-office"),
  };
  const office = { key: "office", label: "Office", path: "/league-office", icon: Wrench, match: (p) => p === "/league-office" };
  return isManager
    ? [BASE_TABS[0], leagues, BASE_TABS[1], BASE_TABS[2], office]
    : [BASE_TABS[0], leagues, BASE_TABS[1], BASE_TABS[2]];
}

export function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const path = location.pathname;
  const tabs = tabsForRole(profile?.role);
  return (
    <div className="tab-bar-nav">
      {tabs.map(t => {
        const Icon = t.icon;
        const active = t.match(path);
        return (
          <button key={t.key} className={`tab-bar-nav__item ${active ? "tab-bar-nav__item--active" : ""}`} onClick={() => navigate(t.path)}>
            <Icon size={20} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Hamburger drawer ───────────────────────────────────────────────────────
// Mirrors the same top-level hierarchy as the Home tile grid (My Stats,
// Leagues, Practice, Tournaments, plus League Office for whichever roles
// have any League Office pages at all) -- League Office is the one parent
// with real sub-pages, so its items render indented underneath it, same
// shape as the old pre-tab-bar drawer had, just nested instead of flat.
const PRIMARY_NAV_ITEMS = [
  { key: "stats",       label: "My Stats",    path: "/my-stats",   icon: BarChart3 },
  { key: "leagues",     label: "Leagues",     path: "/leagues",    icon: Trophy },
  { key: "practice",    label: "Practice",    path: "/practice",   icon: Dumbbell },
  { key: "tournaments", label: "Tournaments", path: "/tournaments", icon: Award },
];

const LEAGUE_NAV_ITEMS = [
  { key: "schedules", label: "Schedules", path: "/schedules", icon: Calendar, roles: ["manager", "captain", "player"] },
];

export function NavDrawer({ open, onClose, profile, onLogout }) {
  const location = useLocation();
  const officeItems = navItemsForRole(profile.role).filter(item => item.key !== "schedules");
  const leagueItems = LEAGUE_NAV_ITEMS.filter(item => item.roles.includes(profile.role));
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + "/");

  return (
    <>
      {open && <div className="drawer-scrim" onClick={onClose} />}
      <div className={`drawer ${open ? "drawer--open" : ""}`}>
        <div className="drawer__top">
          <div className="drawer__brand">IBA Pool App</div>
          <button className="btn-icon-sm" onClick={onClose} aria-label="Close menu"><X size={14} /></button>
        </div>
        <div className="drawer__who">
          <RoleTag role={profile.role} />
          <span className="drawer__username">@{profile.username}</span>
        </div>
        <div className="drawer__items">
          {PRIMARY_NAV_ITEMS.map(item => {
            const Icon = item.icon;
            return (
              <Link key={item.key} to={item.path} onClick={onClose}
                className={`drawer__item ${isActive(item.path) ? "drawer__item--active" : ""}`}>
                <Icon size={16} /><span>{item.label}</span>
              </Link>
            );
          })}
          {leagueItems.length > 0 && (
            <>
              {leagueItems.map(item => {
                const Icon = item.icon;
                return (
                  <Link key={item.key} to={item.path} onClick={onClose}
                    className={`drawer__item drawer__item--sub ${isActive(item.path) ? "drawer__item--active" : ""}`}>
                    <Icon size={14} /><span>{item.label}</span>
                  </Link>
                );
              })}
            </>
          )}
          {officeItems.length > 0 && (
            <>
              <Link to="/league-office" onClick={onClose}
                className={`drawer__item ${location.pathname === "/league-office" ? "drawer__item--active" : ""}`}>
                <Wrench size={16} /><span>League Office</span>
              </Link>
              {officeItems.map(item => {
                const Icon = item.icon;
                return (
                  <Link key={item.key} to={item.path} onClick={onClose}
                    className={`drawer__item drawer__item--sub ${isActive(item.path) ? "drawer__item--active" : ""}`}>
                    <Icon size={14} /><span>{item.label}</span>
                  </Link>
                );
              })}
            </>
          )}
        </div>
        <div className="drawer__bottom">
          <Link to="/me" onClick={onClose} className={`drawer__item ${location.pathname === "/me" ? "drawer__item--active" : ""}`}>
            <UserCircle size={16} /><span>My Profile</span>
          </Link>
          <button className="drawer__item drawer__item--logout" onClick={confirmAndLogout(onLogout)}>
            <LogOut size={16} /><span>Sign Out</span>
          </button>
        </div>
      </div>
    </>
  );
}

function RoleTag({ role }) {
  const label = role === "manager" ? "Manager" : role === "captain" ? "Captain" : "Player";
  return <span className={`role-tag role-tag--${role}`}>{label}</span>;
}

// ─── Page header (hamburger + title + sign out) ────────────────────────────
export function PageHeader({ title, subtitle, hideBack }) {
  const { profile, logout } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { canGoBack, goBack } = useNavHistory();

  if (!profile) return null;

  return (
    <>
      <div className="page-header">
        <div className="page-header__left">
          {!hideBack && canGoBack && (
            <button className="btn-icon-sm" onClick={goBack} aria-label="Back"><ChevronLeft size={16} /></button>
          )}
          <button className="btn-icon-sm" onClick={() => setDrawerOpen(true)} aria-label="Open menu"><Menu size={15} /></button>
          <div>
            <div className="page-header__title">{title}</div>
            {subtitle && <div className="page-header__subtitle">{subtitle}</div>}
          </div>
        </div>
        <div className="page-header__right">
          <button className="btn-icon-sm" onClick={confirmAndLogout(logout)} aria-label="Sign out"><LogOut size={13} /></button>
        </div>
      </div>
      <NavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} profile={profile} onLogout={logout} />
    </>
  );
}

// ─── Sub-tab bar (within-page tabs, e.g. Teams / Schedule / Players) ───────
export function SubTabBar({ children }) {
  return <div className="tab-bar">{children}</div>;
}
export function SubTabBtn({ active, onClick, children }) {
  return <button className={`tab-btn ${active ? "tab-btn--active" : ""}`} onClick={onClick}>{children}</button>;
}

// ─── Access-denied fallback for a role hitting a page it can't see ─────────
export function AccessDenied() {
  return <div className="empty-state">You don't have access to this page.</div>;
}

// ─── Shared shell styling ───────────────────────────────────────────────────
export const shellCss = `
.page-header{background:#0B3D2E;background-image:radial-gradient(circle at 50% 0%,#0F4A37 0%,#0B3D2E 70%);padding:14px 16px;min-height:58px;display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;}
.page-header__left{display:flex;align-items:center;gap:10px;}
.page-header__title{font-family:'Archivo Black',sans-serif;font-size:15px;color:#FFF;}
.page-header__subtitle{font-size:10px;font-weight:700;color:#9FC4B4;letter-spacing:0.05em;margin-top:1px;}
.page-header__right{display:flex;align-items:center;gap:8px;}
.btn-icon-sm{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:8px;border:1.5px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);color:#FFF;cursor:pointer;}
.btn-icon-sm--active{background:#5FCF9E;border-color:#5FCF9E;color:#0B3D2E;}

.drawer-scrim{position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:40;}
.drawer{position:fixed;top:0;left:0;bottom:0;width:280px;max-width:82vw;background:#141414;border-right:1.5px solid #2E2E2E;z-index:41;transform:translateX(-100%);transition:transform 0.2s ease;display:flex;flex-direction:column;padding:16px 0;}
.drawer--open{transform:translateX(0);}
.drawer__top{display:flex;align-items:center;justify-content:space-between;padding:0 14px 12px;}
.drawer__brand{font-family:'Archivo Black',sans-serif;font-size:14px;color:#FFF;}
.drawer__who{display:flex;align-items:center;gap:8px;padding:0 14px 14px;border-bottom:1.5px solid #2A2A2A;margin-bottom:8px;}
.drawer__username{font-size:12px;color:#9A9A9A;font-weight:600;}
.drawer__items{display:flex;flex-direction:column;flex:1;overflow-y:auto;}
.drawer__item{display:flex;align-items:center;gap:10px;padding:11px 14px;color:#E0E0E0;text-decoration:none;font-size:12.5px;font-weight:600;border:none;background:none;text-align:left;cursor:pointer;}
.drawer__item:hover{background:#1C1C1C;}
.drawer__item--active{background:#0F2D1F;color:#5FCF9E;border-left:3px solid #5FCF9E;padding-left:11px;}
.drawer__item--sub{padding-left:34px;font-size:11.5px;font-weight:500;color:#B0B0B0;}
.drawer__item--sub.drawer__item--active{padding-left:31px;}
.drawer__bottom{border-top:1.5px solid #2A2A2A;padding-top:8px;margin-top:8px;}
.drawer__item--logout{color:#F87171;}

.role-tag{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;padding:3px 7px;border-radius:5px;}
.role-tag--manager{background:#0F2D1F;color:#5FCF9E;}
.role-tag--captain{background:#1E3A5F;color:#8CB6E8;}
.role-tag--player{background:#2A2A2A;color:#B0B0B0;}

.tab-bar-nav{position:fixed;left:0;right:0;bottom:0;max-width:480px;margin:0 auto;display:flex;background:#141414;border-top:1.5px solid #2A2A2A;z-index:30;}
.tab-bar-nav__item{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 4px 8px;background:none;border:none;color:#6A6A6A;font-family:'Archivo',sans-serif;font-size:10px;font-weight:700;cursor:pointer;}
.tab-bar-nav__item--active{color:#5FCF9E;}

@media (min-width:768px){
  .tab-bar-nav{max-width:640px;}
}
@media (min-width:1200px){
  .tab-bar-nav{max-width:840px;}
}
`;
