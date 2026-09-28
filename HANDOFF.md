# IBA Pool League App — Handoff (v6)

For starting a new chat: upload every file in this package, then paste this file in as context.
This replaces v5 entirely — read this one, not the old one.

## ⚠️ Schema state — read this first

The original `supabase-schema-CONSOLIDATED-REFERENCE.sql` is **stale** — do not run it against
the live project. The real, current schema is: that original file, **plus every
section-14 through section-50 migration applied in order**. All 37 incremental files
(14 through 50) are included in this package.

**Run these in order if not already applied.** Sections 14–41 are unchanged from prior
handoffs (see v5 and earlier for what each one does, summarized briefly below). Everything
from section 42 onward was built in this session:

| # | File | What it does |
|---|------|---------------|
| 14–41 | *(see prior handoffs for detail)* | Captain team management, phone numbers, role consolidation, team identity (uuid PK), locations, makeup matches, playoff brackets, captaincy history, player linking, weekly standings/MVP accumulation, real IBA report format, location address fields, invite code labels, match corrections (full + per-set), matchnight makeup fix, concurrent live matches + scorer claims, live match RLS, practice mode, practice link search, practice game log, solo scoring, date format backfill, name/address fields, practice opponent names, playoff eligibility import. |
| 42 | `supabase-schema-section-42-manager-team-assignment.sql` | `set_own_team_id()` RPC — lets a manager who also plays in the league self-assign to a team (own `team_id`), independent of their admin role/scope. |
| 43 | `supabase-schema-section-43-lineup-planner.sql` | `lineup_plans` + `lineup_plan_players` — captain-only, team-scoped weekly lineup scheduling ("who's shooting this week"). Introduces `is_on_team()`. Purely informational, never gates live-entry draft. |
| 44 | `supabase-schema-section-44-player-unavailability.sql` | `lineup_unavailability` — self-service "I can't shoot this week" marking for players, visible to the captain while planning. |
| 45 | `supabase-schema-section-45-shot-tracking.sql` | `shot_events` — the core "Track a Rack" advanced-stats table (scratches, fouls, makes/misses by distance/cut, jump/kick/bank technique, safeties, miscues, 8-ball breaks, runouts). Polymorphic `context_type`/`context_id` (no FK) so it already supports league, practice, and future tournaments with no further migration. |
| 46 | `supabase-schema-section-46-shot-events-opponent-gametype.sql` | Adds `opponent_player_num` + `game_type` to `shot_events`, denormalized at write time — feeds head-to-head and game-type filtering. |
| 47 | `supabase-schema-section-47-shot-events-division.sql` | Adds `division_id` to `shot_events`, denormalized at write time — feeds season/division-scoped leaderboards. |
| 48 | `supabase-schema-section-48-team-only-visibility.sql` | **Narrows** `is_on_team()` to drop the blanket manager-sees-everything clause. Lineup Planner and Unavailability are now strictly team-only (captain, that team's own players, or a manager personally rostered on that specific team) — not leaguewide for managers. |
| 49 | `supabase-schema-section-49-shot-events-team-boundary.sql` | Tightens `shot_events` writes: you can only log/edit events about a player on **your own team**, or you're a manager (Option A — deliberately does not allow cross-team opponent-tracking during a live match). Adds `can_write_practice_shot_event()` for practice's team-less case, validating you're an actual participant in that specific practice session, not an arbitrary third party. |
| 50 | `supabase-schema-section-50-drop-standings-note.sql` | Drops the unused `standings_adjustments.note` column (confirmed dead — never written or read by any app code). Drops and recreates `standings_adjustments_current` since Postgres locks a `select *` view's column list at creation time, so the view would otherwise block the drop. |

**Still outstanding, not yet decided:** `mvp_adjustments.note` is a parallel dead column
(same situation as `standings_adjustments.note` before section 50) — flagged to the user,
no decision made yet on whether to drop it. If yes, it's the same pattern as section 50
(drop + recreate `mvp_adjustments_current`, since it's also a `select *` view).

## What this is

A league management + live match scoring app for an IBA pool league — Vite + React +
Supabase. Bottom tab bar: Home · Leagues · Practice · Tournaments, plus a hamburger for
account-level utility only. See prior handoffs for the full original feature set
(live scoring, match correction, playoff brackets, roster/rating imports, etc. — all
still accurate and unchanged unless noted below).

## What's new this session (sections 42–50 + supporting app code)

### Manager self-assignment to a team
A manager who also plays can link their own `team_id` (My Profile → "My Team (if you
also play)"), separate from their admin role/scope. Picker is limited to active-season
teams; shows a warning if the currently-set team's season has since gone inactive
(stays functional everywhere else in the app, just won't re-appear in the picker until
reactivated).

### Manual match entry (full rack-by-rack, not just final scores)
New manager-only flow (Match Lookup / History → Matches tab → "Manually Record a
Match"): pick teams/venue/week, then for each of 5 tables pick who played (rated
roster, sorted like live draft) and either enter full rack-by-rack detail — innings,
safeties, timeouts — via the **same `SetEntry` component Live Entry itself uses** (no
second implementation to drift), or mark it a forfeit. A player missing a rating gets
an inline fallback: enter one on the spot, with an option to also save it as their
real current rating going forward. Saves via `saveManualMatch()`; a client-generated
UUID is created *before* saving so Track a Rack events logged mid-entry still attach
correctly once the match is written. Scoresheet's "verified" badge now distinguishes
Live Entry / manual entry / imported-summary-only, instead of only recognizing "live".

### Lineup Planner (captain-only, team-scoped)
Manage My Team → "Lineup Planner": pick any of the team's real upcoming/past schedule
weeks, check off who's expected to shoot, add an optional note, save. A "Who's
Shooting" card on the Leagues dashboard shows it to the team (read-only) when a plan
exists for an upcoming week. Entirely optional, never gates live-entry draft.

### Player Unavailability
Leagues dashboard → "My Availability": any team member (including a playing manager)
can mark themselves unable to shoot a given upcoming week, with an optional reason.
Surfaces as a soft warning (not a hard block) in the captain's Lineup Planner if they
try to schedule someone who's marked themselves out.

### Track a Rack — full advanced stat tracking system
The single biggest addition this session. One shared `ShotTracker` component, plugged
into all three places a rack gets scored:
- **Live Entry** (league night) and **Manual Match Entry** — both via the shared
  `SetEntry` component, so this was one wiring point, not two.
- **Practice** — `PlayStep`, for yourself (once your player number is linked) and an
  opponent picked from search (not a manually-typed no-account opponent, since there's
  no `player_num` to attach real stats to).

Tracks: scratches, fouls, makes/misses by distance (short/medium/long) and cut
(left/right), technique (jump/kick/bank), successful/unsuccessful safeties, miscues,
8-ball breaks, and runouts. **Entirely optional, never part of the confirmed
score/dual-confirm** — a match can be fully scored with zero `shot_events` rows.

**Consuming views**, all built on one shared `computeShotStats()` aggregation:
- **My Stats** / **Player Lookup** — both now render off a single shared
  `PlayerStatsProfile` component (season/career scope picker, season record, team
  history, rating history, advanced stats with Play Type/Game Type filters,
  head-to-head, print/export).
- **Team Stats** (captain's Manage My Team, and now also **Team Lookup**, open to
  everyone) — team-wide rollup + per-player breakdown, reusing the same
  `TeamStatsPanel` component in both places.
- **Leaderboard** (new League Office page, all roles) — ranks every player by Make %,
  Total Shots, Runouts, or Safety %, with Play Type/Game Type/Division-Season filters.
  Percentage metrics have a minimum-sample floor so one lucky shot can't top the board.
- **Print/Export** — every stats view above has "Print / Save as PDF" (browser-native,
  new `@media print` stylesheet hides app chrome) and "Export CSV" (client-side Blob
  download, names resolved via `getPlayerNameMap()`).

### Player Lookup / Team Lookup — both fully built (were placeholders)
- **Player Lookup**: search any player → full `PlayerStatsProfile` (bio, season/career
  scope, team history, rating history, advanced stats, head-to-head) → optional
  **Compare to Another Player**, stacking a second full profile with a "vs" divider.
- **Team Lookup**: search/browse any team → Team Record (wins/losses/points/**rank**,
  via the same `computeStandings()` the real Standings tab uses) → Roster (with
  captain) → Upcoming → Recent Results → the advanced-stats Team Rollup. Open to
  **every role**, not manager-only — a deliberate decision (see below).
- Both are single-season/team by design: `teams.id` is a fresh row every season, never
  reused, so there's no single continuous "team" to show cross-season history *for* —
  Player Lookup's Team History list is what surfaces that continuity instead, per player.

### Unmatched team reconciliation (weekly roster import)
`bulkImportPlayers()` now returns enough detail per unmatched team number (parsed name,
player list) that the import results panel can resolve it inline — **Create as New
Team** (one click, uses the report's own parsed name) or **Map to Existing Team…**
(dropdown, for the typo/renumbering case) — instead of the old dead-end "go fix it and
re-paste the whole report" warning. Players/ratings were always saved regardless of
team match status; this only ever needed to fix the roster *linkage*.

### Tier 1 automated tests (Vitest)
`npm test` runs 30 unit tests across the four pure computation functions:
`computeMatchPoints`, `computeStandings`, `computeMvp`, `computeShotStats`. These lock
in the actual scoring/stats formulas so a future accidental edit gets caught
mechanically instead of relying on manual brace/paren + `db.*` cross-reference checks
alone (which only catch broken syntax and typo'd function names, never wrong math).
`.env.test` supplies dummy Supabase credentials so `db.js` can be imported in tests
without a real project or network access — the tested functions never call any
`supabase.*` method. **Tier 2 (RLS/policy tests) and Tier 3 (component/UI tests) are
not built** — deliberately deferred as lower priority for a project this size; revisit
if the manual click-through process starts actually missing things.

### Deliberate design decisions worth knowing (new this session)
- **Denormalize at shot-log time, always.** `shot_events.team_id` /
  `opponent_player_num` / `game_type` / `division_id` are all set by the app when an
  event is logged, never reconstructed via a join later — `context_type`/`context_id`
  is a polymorphic pointer across three differently-shaped tables (`live_match`,
  `completed_matches`, `practice_games`), so a join-based approach isn't practical.
  Same tradeoff this schema already made for `team_home_name`/`team_away_name` on
  `completed_matches`.
- **Client-generated stable UUIDs, created before the parent row exists.** Both manual
  match entry (`matchId`) and practice sessions (`session.gameId`) generate their id
  client-side via `crypto.randomUUID()` *before* anything is saved, specifically so
  Track a Rack events logged mid-session/mid-entry already have a stable id to attach
  to. That same id is passed explicitly on the final insert (Postgres accepts a
  client-supplied uuid for a `gen_random_uuid()`-default column).
- **Shared components over parallel implementations, aggressively.** `SetEntry`
  (live scoring ⇄ manual entry), `PlayerStatsProfile` (My Stats ⇄ Player Lookup),
  `TeamStatsPanel` (captain's own team ⇄ Team Lookup) are each written once and reused,
  specifically so the two consuming pages can never quietly drift into showing
  different numbers for the same underlying data.
- **Team-only visibility, not manager-sees-everything, for Lineup Planner and
  Unavailability** (section 48) — a deliberate narrowing after discussion. These are
  informal/unconfirmed captain scratch-pad tools, never referenced by any real
  dispute-resolution flow, and unavailability entries in particular can be genuinely
  personal. Manager-as-player (via `profile.team_id`) still works fine; a manager with
  no personal connection to a team can no longer browse its lineup/availability data.
- **Shot event writes: Option A team-boundary enforcement** (section 49) — you can
  log/edit events about a player on your own team, or you're a manager. The accepted
  tradeoff: no cross-team opponent-tracking during a live match. Practice's team-less
  case gets a real participant check (`can_write_practice_shot_event`) rather than a
  blanket bypass, so a random signed-in account still can't log fabricated events about
  someone else's practice session.
- **Postgres view gotcha, now documented for next time:** a view created with
  `select *` locks in its column list at *creation* time, not live. Dropping a column
  the view was built against will fail with a dependency error unless the view is
  dropped and recreated in the same migration (see section 50). Worth remembering for
  `mvp_adjustments.note` if that gets dropped later too.
- **Team Lookup is open to every role, not manager-only** — deliberate. A team's
  advanced stats/record/roster carry no more sensitivity than standings or MVP
  rankings, which are already leaguewide-visible throughout this app.
- **Guest/anonymous sign-in for Practice: still deliberately deferred**, not by
  oversight — discussed explicitly this session and decided not worth building
  speculatively (most of Practice's value is tied to a persistent account anyway;
  revisit only if real users hit the signup wall specifically for practice mode).

## Files

- **App code** (all updated or new this session):
  - `AdminApp.jsx` — largest diff this session: manual match entry, Lineup Planner UI,
    Player/Team Lookup pages, `PlayerStatsProfile`/`TeamStatsPanel`/`ShotStatsBlock`/
    `FilterChips` shared components, Leaderboard page, unmatched-team reconciliation UI,
    print CSS.
  - `Dashboard.jsx` — "Who's Shooting" and "My Availability" cards on the Leagues
    dashboard.
  - `LiveEntryApp.jsx` — `SetEntry` and its `css` now exported (shared with manual
    entry); Track a Rack wired in with `contextType`/`contextId`/`divisionId`.
  - `Practice.jsx` — `session.gameId` generated up front; Track a Rack wired into
    `PlayStep`; `DoneStep` includes that id on save.
  - `Scoresheet.jsx` — "verified" badge now distinguishes live/manual/imported.
  - `Shell.jsx` — Leaderboard added to League Office nav.
  - `ShotTracker.jsx` — **new file**, the shared shot-logging component + its CSS.
  - `db.js` — largest functional diff: every function listed under "Track a Rack" and
    "Player/Team Lookup" above, plus `setOwnTeamId`, lineup planner/unavailability
    CRUD, unmatched-team reconciliation, CSV/print utilities.
  - `main.jsx` — `/leaderboard` route added.
  - `AuthContext.jsx`, `supabaseClient.js`, `index.html` — unchanged this session.

- **Testing** (new this session):
  - `package.json` — `vitest` added as a dev dependency; `npm test` / `npm run
    test:watch` scripts.
  - `vite.config.js` — `test` block added (Vitest reads this file directly).
  - `.env.test` — dummy Supabase credentials for the test environment only.
  - `tests/computeMatchPoints.test.js`, `tests/computeStandings.test.js`,
    `tests/computeMvp.test.js`, `tests/computeShotStats.test.js` — 30 tests total, all
    verified to pass against the real function bodies (extracted and run standalone,
    since this session's sandbox had no network access to install Vitest itself — see
    Approach & patterns below).

- **`supabase-schema-section-14` through `-50.sql`** — all 37 incremental migrations,
  in order. Sections 14–41 unchanged from prior sessions; 42–50 new this session.

## Known gaps / explicitly deferred

- **Tournaments** — still fully unstarted. Same open questions as prior handoffs (real
  vs. ad-hoc rosters, scoring convention, auto-director assignment). The Track a Rack
  system's polymorphic design already supports a `context_type = 'tournament_game'`
  (or similar) with zero schema changes once tournaments themselves exist.
- **Guest/anonymous sign-in for Practice** — deliberately deferred, discussed and
  decided against building speculatively this session (see above).
- **`mvp_adjustments.note`** — parallel dead column to the one dropped in section 50.
  Flagged, not yet decided.
- **Cross-linking Player Lookup ⇄ Team Lookup** — proposed this session, not built.
  Team Lookup's roster rows should link to that player's Player Lookup profile;
  Player Lookup's Team History rows should navigate to that team's Team Lookup page
  (currently they only jump the season scope selector, not actual navigation);
  opponent names in Team Lookup's Upcoming/Recent Results should link to the
  opponent's own Team Lookup page.
- **MVP rank on Player Lookup** — proposed, not built. Team Lookup already shows a
  team's rank ("3rd of 8") via `getTeamStandingsRow()`; Player Lookup shows raw MVP
  ranking points but not where that places them within their division. Same pattern,
  just for individuals — would need a small new function alongside
  `getStatsForDivisions()`.
- **Playoff eligibility status on the player profile** — proposed, not built. The
  E/T/A/S codes already exist (`player_playoff_eligibility`, section 41) but aren't
  surfaced anywhere in Player Lookup or My Stats.
- **Team-vs-team head-to-head** — proposed, not built. Player-level head-to-head
  already exists (`computeHeadToHead`); the team-level equivalent would need its own
  aggregation over `completed_matches`, not a reuse of the existing player-scoped one.
- **Manager-side "browse any team's stats"** — resolved this session (Team Lookup is
  now open to everyone, not manager-only) — no longer a gap, listed here only to
  correct the prior handoff's outdated note.
- **Tier 2 (RLS/policy) and Tier 3 (component/UI) automated tests** — not built.
  Deliberately scoped down to Tier 1 (pure-function unit tests) only this session;
  revisit if manual validation starts missing real bugs.
- **Opponent stats surfaced live, during a match** — considered and explicitly
  decided against this session. Head-to-head/compare via Player Lookup covers the
  need well enough; a live in-match widget was judged not worth the added complexity
  and screen clutter for a mostly-empty-most-nights use case.
- **League News, Communication cluster (chat/notes/messaging), email sending
  infrastructure, Hub landing page redesign, discrepancy detection between
  self-computed and imported standings/MVP, Ultimate Pool's timed rating format** —
  all still true and unchanged from prior handoffs. No work done on any of these this
  session.

## Approach & patterns (carried forward + new this session)

- Claude authors all code; William directs as product owner. Consistently
  discussion-first for architecture-level decisions this session too — RLS visibility
  scope (section 48), shot-event write boundaries (section 49 Option A vs. a fuller
  alternative), and the standings-note column removal all went through an explicit
  back-and-forth before implementation, not straight to code.
- **Honest gap-flagging, including self-correction.** When asked to review "what's
  left," found that Player/Team Lookup had already been built earlier in the *same*
  session and the running gap-list was simply stale — corrected immediately rather
  than let a wrong status persist. Similarly, caught and corrected a `notes` vs. `note`
  column-name mismatch (and a related, previously-unflagged dead column on
  `mvp_adjustments`) by actually reading the uploaded consolidated reference rather
  than trusting the shorthand used earlier in conversation.
- **Verifying code without a live environment.** This session's sandbox had no network
  access, so `npm install vitest` wasn't possible to actually run the new test suite
  through its real runner. Rather than deliver untested-in-practice test files,
  extracted the four target functions byte-for-byte out of `db.js` into an isolated,
  dependency-free script, wrote a minimal `describe`/`it`/`expect` shim by hand, and
  executed all 30 assertions against the real extracted code — confirmed all 30 pass.
  This is a good fallback pattern for future sessions if the sandbox is similarly
  offline: don't skip verification just because the "real" tool isn't installable,
  find the closest thing that actually exercises the real logic.
- **Postgres semantics matter, not just app-layer logic.** Two real gotchas surfaced
  and were worked through this session: (1) a `select *` view locks in its column list
  at creation time, not live, which changes how a "just drop the column" migration
  needs to be written; (2) SQL `NULL` comparison semantics (`x = NULL` is never true)
  meant the naive team-boundary RLS design would have silently blocked every practice
  write with a null `team_id` — caught during design, not after deployment.
- Validation before delivery: brace/paren/bracket balance checks (diffed against each
  file's known baseline, not just checked for zero) + `db.*` cross-reference against
  real exports, every file delivery, no exceptions — same discipline as prior
  sessions, just applied across a much larger set of interdependent files this time
  (nine app files touched across the session, several edited across multiple turns).

## New in this build — automated IBA schedule import

The season workflow now treats the IBA schedule page as the initial season-structure source.

- `api/iba-schedules.js` server endpoint retrieves `https://ibapool.com/League/Schedules/m8-pool-league` server-side, discovers the Format/Night/Division controls, submits the selected season context, and parses the returned team table plus weekly schedule table.
- `src/IbaScheduleImportPanel.jsx` is shown on the expanded season card. It discovers available divisions for the season's format/night, lets the manager preview them, then imports divisions, teams, weeks, pairings, holidays, and playoff rows.
- `src/db.js` adds `findDivisionInSeason()` and `importIbaScheduleDivision()` so team numbers are scoped to the selected season/division rather than searched globally across active seasons.
- Existing manual schedule paste/import remains unchanged under Manage Season Data → Schedule and is the fallback if IBA's page structure/retrieval changes.
- Automatic schedule import intentionally refuses to replace a division's existing schedule. This avoids deleting schedule rows that may already be referenced by live scoring, lineup planning, or history. Change detection/update should be a separate follow-up.
- The automatic report importer remains separate: DIV/MVP are treated as later/weekly data sources, not required for initial season setup.

The schedule endpoint includes several request fallbacks because the IBA page's selection controls are dynamic. If IBA changes its form/AJAX mechanism, the endpoint may need one targeted adjustment; the manual importer remains available.
