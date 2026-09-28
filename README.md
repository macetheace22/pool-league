# IBA League App

Two apps, one project: the league admin panel and live dual-phone match scoring.
Backed by a real Supabase Postgres database with row-level security, not Claude's
artifact storage — no "is it published" gotchas, works identically on any device.

- `/admin` — league management (seasons, divisions, teams, schedule, rosters, ratings, accounts)
- `/live` — live match scoring (coin flip, draft, rack-by-rack scoring) — **intentionally
  has no login**, per a deliberate choice to keep it fast at the table; anyone with the
  link can score the current match. Revisit this later if you want it locked down too.

## Accounts & roles

Real accounts now (Supabase Auth — email + password), not the old username/PIN system.

- **The very first person to sign up automatically becomes the manager.** That's you —
  just register with no invite code needed the first time.
- After that, everyone else needs an invite code, generated from the Accounts tab.
- Roles: manager (full access), captain (locked to their own team, view-only on
  rosters/ratings), scorekeeper, viewer.
- A manager can deactivate a user from the Accounts tab. There's no "hard delete" from
  the app itself — that requires a privileged key that must never live in client code.
  If you ever need to permanently remove someone's account, that'd be a small Supabase
  Edge Function, not something to do from here.

## 1. One-time setup

```
npm install
cp .env.example .env
```

Fill in `.env` with your Supabase project's URL and anon/publishable key
(Project Settings → API), and make sure `supabase-schema.sql` has already been run
in the SQL Editor.

## 2. Run it locally to make sure it works

```
npm run dev
```

Open the printed URL, go to `/admin`, and register the first (manager) account.
Then try `/live` in a separate tab. Report anything that errors in the browser
console back to Claude before deploying.

## 3. Push to GitHub

```
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

## 4. Deploy on Vercel

1. vercel.com → **Sign up with GitHub**.
2. **Add New Project** → pick this repo → Vite auto-detected.
3. Add the same two env vars from `.env` under **Environment Variables** before deploying.
4. Deploy. Bookmark `/admin` and `/live` on whatever devices need them.

Every `git push` after that redeploys automatically.

## Notes

- `live_match` (the table `/live` reads/writes) is deliberately public — no RLS
  restriction beyond "you can create the match only if you're a manager." Everything
  else (seasons, teams, rosters, ratings, invite codes, profiles) is locked down by
  row-level security tied to real Supabase Auth sessions and roles.
- Live Entry polls every 3 seconds for the other phone's updates — carried over
  unchanged from the original design. Could be upgraded to Supabase Realtime
  (push instead of poll) later; not necessary for this to work correctly.
- Player ratings keep full week-by-week history (`player_ratings` table), not just a
  single current number — visible by tapping a player in the Rosters & Ratings card.


## Automatic IBA Report Sync

The admin Weekly League Data page now includes an **Automatic IBA Report Sync** panel. It generates the IBA report URLs from the selected season's format/day, retrieves the roster, division standings, and MVP PDFs server-side, treats missing reports as normal, extracts their text, and sends that text through the same parsers used by the manual paste workflow.

### New pieces
- `api/iba-reports.js` — Vercel serverless endpoint that retrieves and extracts IBA PDFs.
- `src/ibaParsers.js` — shared roster/standings/MVP parser module used by both manual and automatic imports.
- `src/ibaAutoSync.js` — automatic retrieval, preview, routing, and import orchestration.
- `src/IbaAutoSyncPanel.jsx` — manager-facing automatic sync UI.
- `src/db.js` — active-team routing helper for cross-division standings/MVP imports.

### First install after pulling this version

Because `pdf-parse` is a new dependency, run:

```bash
npm install
```

This refreshes `package-lock.json` for the environment before deploying to Vercel.

The manual PDF paste workflow remains available as the fallback.
