import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './AuthContext.jsx';
import AdminApp from './AdminApp.jsx';
import LiveEntryApp from './LiveEntryApp.jsx';
import { NavHistoryProvider } from './Shell.jsx';
import { Home, LeaguesDashboard, LeagueOffice, TournamentsPlaceholder } from './Dashboard.jsx';
import Practice from './Practice.jsx';
import Schedules from './Schedules.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <NavHistoryProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/leagues" element={<LeaguesDashboard />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/league-office" element={<LeagueOffice />} />
            <Route path="/practice" element={<Practice />} />
            <Route path="/tournaments" element={<TournamentsPlaceholder />} />
            <Route path="/seasons" element={<AdminApp page="seasons" />} />
            <Route path="/manage" element={<AdminApp page="manage" />} />
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
