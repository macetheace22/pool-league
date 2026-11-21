# Current Project Status — 2026-11-21

This document is the current development-status overlay for the Pool League App. It records the recent work completed or in progress and supersedes older status notes where they conflict. Historical documentation remains useful for implementation detail.

## Repository and deployment state

- Repository: `macetheace22/pool-league`
- Primary branch: `main`
- Stack: React 18 + Vite + Supabase + React Router + lucide-react + Vitest
- Production Vercel project: `pool-league`
- Production alias: `maces-iba-pool.vercel.app`
- Production was last confirmed READY through PR #255 at commit `cd88dfce404598fba48866bc64d935f7c7d2da77`.
- PRs #256–#259 are merged to `main`.
- A later production deployment was successfully created for PR #259's merged commit `fcbc0cc5a8f121752574afb77eb7a250cb03e1cb`; its initial state was `INITIALIZING` and must not be treated as READY until separately verified.
- Do not assume a merged PR is production-deployed merely because GitHub CI is green.

## Recent Practice work

### PR #256 — Move Practice identity management into My Profile — MERGED

Practice identity management is now centered in **Profile → Identity & Connections**.

Moved out of the Practice landing page:
- Claim-code redemption.
- Incoming/outgoing Practice identity request management.

Retained in Practice:
- Opponent-specific claim-code generation and linking.
- Opponent selection remains available from the Practice workflow.
- Redundant “Linked” text was removed from the opponent list while preserving selectable opponent rows.

Related database identity work:
- Sections 101–106 provide the Practice identity/linking foundation.
- Section 107 added `update_my_practice_opponent_name(uuid,text,text)`, allowing authenticated users to update an unlinked manual Practice opponent's first/last name and corresponding historical `practice_games.opponent_name`.
- Section 107 was applied and live access controls were verified.

### PR #257 — Expandable Recent Activity — MERGED

Recent Activity is now a single chronological feed combining:
- League match activity.
- Practice session activity.

Behavior:
- Shows the four most recent activities by default.
- Expands to show up to ten.
- Can collapse back to four.
- League activity respects home/away player perspective.
- Practice activity distinguishes Skills & Drills, general Practice, and opponent-based sessions.
- Practice rows navigate to Practice history.
- League rows navigate to Match Lookup/History.

### PR #258/#259 — Practice Game Type filter in My Stats — MERGED

My Stats now exposes **Practice Game Type** when Practice is selected.

Current design:
- Multi-select, consistent with the existing My Stats filter pattern.
- Four game types:
  - 8-Ball
  - 9-Ball
  - 10-Ball
  - Ultimate Pool
- All four are selected by default.
- There is **no “All Games” option**.
- Users can independently toggle any game type.
- If all four are deselected, Practice results should be empty rather than silently reverting to all games.
- League statistics are unaffected.
- The Practice filter applies to the relevant Practice statistics/history and related Practice views that use the filtered game set.

### PR #260 — Match Practice Game Type filter size/style to Scope — OPEN

This is a UI-only follow-up making the Practice Game Type control use the same segmented-control sizing and styling as Scope.

- No SQL.
- No behavior change.
- Branch: `style/practice-game-type-match-scope`.
- PR: #260.
- Do not treat this as merged or deployed until GitHub state confirms it.

## League Office rule-resolution work

### Team Dropout Resolution

The League Office includes a manager-only **Team Dropout Resolution** workflow for Rule 8.7.

Current intent:
- Select season, division, dropout team, and effective date.
- Preview affected completed-match records and future schedule weeks.
- Preserve completed match history.
- Record management's selected remedy and note.
- Apply the downstream standings/schedule effects through the planned follow-on workflow rather than rewriting historical match records.

### Replacement Team Resolution

The League Office also includes a manager-only **Replacement Team Resolution** workflow for Rule 8.8.

Current intent includes:
- Recording replacement-team resolution decisions.
- Recording replacement-team points/standings treatment.
- Recording makeup entitlement.
- Applying replacement teams to future scheduled matchups without changing completed matches or BYE weeks.
- Scheduling eligible makeup matches.

### PR #261 — Fix blank League Office resolution pages — OPEN

Both resolution pages were found to render as blank white pages.

Root cause:
- `shellCss` is a CSS string.
- Both components passed it to React's `style` prop, which requires a style object.
- This caused a render-time failure.

Fix:
- Both pages now follow the same shell pattern used elsewhere:
  `<div className="app"><style>{shellCss}</style>`

No SQL or resolution-business-logic changes are included.

- Branch: `fix/league-office-resolution-blank-pages`
- PR: #261.
- Do not merge or deploy until the PR checks are reviewed.

## Schedule monitoring / IBA schedule workflow

Recent schedule work has established the direction for automated monitoring and manager-approved schedule changes.

Important rules:
- Monitoring must look across **all divisions for each night/day**, not only a single division.
- It must account for all applicable IBA formats and division contexts.
- Division status is evaluated relative to the current league week and schedule data.
- Season changes are a natural lifecycle boundary: when a new season becomes active, monitoring should resume against the new season's divisions/schedule rather than carrying forward stale prior-season monitoring state.
- Schedule imports remain the source for identifying BYE weeks and schedule structure.
- BYE points/treatment should come from the imported schedule context rather than being invented independently by the monitoring layer.

### Next planned schedule step

After a manager reviews and approves a detected schedule change, the next implementation step is to **modify/apply the schedule data from the approved change**.

The monitoring workflow and the schedule-application workflow should remain separate:
1. Detect/monitor.
2. Present the change for manager review.
3. Record approval.
4. Apply the approved schedule modification.
5. Re-run/refresh affected downstream schedule-dependent views.

Do not bypass the approval step by silently changing imported schedule data.

## Stats / perspective work

Recent work also established that:
- Player-facing league match history must be shown from the player's perspective, including correct home/away interpretation.
- Manager division-wide Match Lookup/History remains neutral and home/away oriented.
- Home-team and away-team handling must remain correct for BYE/schedule-derived records.
- Practice statistics are career-wide rather than tied to a league season.

## Development and validation rules

Continue the established workflow:
- Make small, focused PRs.
- Inspect actual GitHub state before assuming work is complete.
- Do not claim a PR is merged, deployed, tested, or SQL-applied without verification.
- Automated CI and production-build results are required before merge.
- SQL migrations are manually applied by the user.
- New `public` Supabase tables require explicit Data API grants in the same migration, with RLS and least-privilege access addressed.
- Do not use the inactive/closed Supabase project.
- Do not perform unnecessary destructive database operations.

## Immediate open items

1. Review/merge PR #260 after CI validation.
2. Review/merge PR #261 after CI validation.
3. Verify the latest Vercel deployment for commit `fcbc0cc5a8f121752574afb77eb7a250cb03e1cb` reaches READY before treating PR #259 as production-live.
4. Continue the approved schedule-application work after monitoring detects and the manager approves a schedule change.
5. Keep the Practice identity, Recent Activity, and Practice Game Type behavior described above as the current product contract.
