import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './AuthContext.jsx';
import AdminApp from './AdminApp.jsx';
import LiveEntryApp from './LiveEntryApp.jsx';
import { NavHistoryProvider } from './Shell.jsx';
import { Home, LeaguesDashboard, LeagueOffice, SeasonManagementHub, TournamentsPlaceholder } from './Dashboard.jsx';
import Practice from './Practice.jsx';
import Schedules from './Schedules.jsx';

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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <DirtySaveButtonBehavior />
      <NavHistoryProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/leagues" element={<LeaguesDashboard />} />
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
            <Route path="/match-lookup" element={<AdminApp page="matchlkp" />} />
            <Route path="/leaderboard" element={<AdminApp page="leaderboard" />} />
            <Route path="/my-stats" element={<AdminApp page="stats" />} />
            <Route path="/access" element={<AdminApp page="access" />} />
            <Route path="/me" element={<AdminApp page="me" />} />
            <Route path="/live" element={<LiveEntryApp />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </NavHistoryProvider>
    </BrowserRouter>
  </React.StrictMode>
);
