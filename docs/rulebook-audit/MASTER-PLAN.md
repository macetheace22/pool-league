# IBA Pool League App — Master Rulebook Audit & Implementation Plan

Last reconciled: 2026-11-09  
Baseline: main at 13687803f19d61bf53c94730a6cbcdc5ffa5fcf9 (PR #130 merged)

This is the canonical cross-chat tracker and the source of continuity between audit chats. Update it whenever a rule is audited, a user decision is made, implementation begins/merges, SQL is applied, or verification changes. It is not a substitute for rereading the exact rulebook clauses.

## Scope boundary
The active project work is limited to aligning the existing app with the supplied IBA rulebook. Do not revive unrelated historical feature requests, redesigns, communication features, or general backlog items. A rulebook requirement may be implemented in the app, supported by an import, or intentionally left as a documented manual/paper process after discussing it with the user. Do not build software merely because a rule describes an operational process.

## Continuity and closure rules
- Treat **Settled user decisions** as durable; do not ask the user to repeat them. Reopen a decision only if the exact rulebook text, a newly discovered conflict, or a material code change makes it necessary.
- Treat **Verified implementation baseline** and rule-table statuses as closed only to the extent their evidence says. Do not re-audit a verified item without a concrete reason.
- Every audited rule must end with one explicit state: Verified in app; Import-only; Manual/paper process by user decision; Gap requiring implementation; or Decision needed. Keep partial audits marked partial.
- When a gap is fixed, update the relevant rule row and evidence after merge/SQL/test verification. Do not keep listing the same closed gap as outstanding.
- Continue at the earliest unresolved rulebook item in the phase order. Ask only for a genuinely unresolved rule interpretation or build-vs-manual decision.

## Working agreement
1. Audit every rulebook section and subsection; do not silently omit clauses.
2. For each rule record: applicability (Open/Advanced/Masters/event), requirement, current UI/code/DB behavior, required player/captain/manager/import data, gap, user decision, implementation status, tests/acceptance criteria, related PR/SQL.
3. Distinguish audited from implemented and verified.
4. Sportsmanship, dropped/replacement teams, finance, and similar operational topics are decision points. Explain each rule and options, ask the user, then record build/defer/import-only/manual process. Do not assume they must become software.
5. Official IBA imports remain authoritative where the user has chosen that source. App calculations may audit/reconcile but must not silently replace official results.
6. Do not merge with a failing latest PR-head required CI check. Inspect failures; never dismiss all-failed emails without checking the run and commit SHA.
7. SQL is manually applied by user. New public Supabase tables need RLS and deliberate Data API grants in the same migration.
8. Never claim SQL, tests, or deployment verified without evidence.
9. Every new audit chat starts by reading this file from current main and reconciling repo, PR/CI, and active Supabase state.

## Settled user decisions
- Formats: Open, Advanced, Masters.
- Official IBA imports are source of truth for published standings/MVP positions, TruSpot ratings, and official playoff eligibility codes. Do not recreate TruSpot's proprietary algorithm.
- Section 5.7: rely on official IBA eligibility import. Missing data = Unverified/warning, not automatically ineligible. App-side calculations are reconciliation only.
- Eligibility thresholds discussed: Division playoffs 4 times with team + 7 IBA scores; Seasonal tournaments 5 + 8; Regional Team Championship 6 + 9.
- New-player exception: exactly 50% qualifies, based on current roster; lowers calculated-score minimums to 5/6/7 respectively, not times-played requirements.
- Current-year IBA membership application required. Dropping/re-adding resets times-with-team. At most one forfeited set may count if player was present, listed on scoresheet, and meets calculated-score requirement.
- Each team keeps its paper scoresheet. App supports independent digital entry for one team; second team's digital entry/comparison is optional.
- Section 6.7: if both players reach ratings in the same game, winner of that last game wins the set. Never prompt scorekeeper to select winner.
- Section 2.7 timeouts are per player, per set: Open rating 30–50 = 2; Open 51–150 = 1; Advanced 40–150 = 1; Masters = 0. NR uses the lowest timeout tier for the format. This was supplied/settled in an earlier chat; do not ask the user to provide it again.
- Regional ranking resets each season per user's explicit app-policy decision, despite Section 5.11 calendar-year wording.
- Discuss sportsmanship, dropped/replacement teams, finance and other admin rules when reached; user decides build vs manual.

## Verified implementation baseline
| Area | Evidence / status |
|---|---|
| Sections 6.1–6.3 core scoring | Existing implementation/tests; PR #120 includes Open scoring correction. Full clause audit remains. |
| Sections 6.4–6.6 forfeits | PRs #121/#122; scoring implemented. Timing/notice/emergency exception still require audit. |
| Section 6.7 simultaneous finish | PR #129 merged; CI passed on PR head and merge commit. |
| Section 6.9 pending makeup rating treatment | PR #129 merged; CI passed. |
| Section 6.10 unplayed sets | PR #122 implemented/tested. |
| Section 5.5 team tie-break audit | PR #127, audit-only; official rankings unchanged. |
| Section 5.5 Division MVP tie-break audit | PR #128, audit-only; official rankings unchanged. |
| Section 5.6 MVP formula/imported positions | PRs #123/#124; official imported positions preserved. |
| Weekly IBA Play/Win parser | PR #125. |
| Persist team-specific weekly Play/Win | PR #126; Section 82 SQL user-applied. Schema exists; populated data still to verify. |
| Official standings positions | PR #123; Section 81 SQL user-applied; columns exist. |
| Roster cutoff foundation | Section 76 validation previously all true; partial Section 8.1 coverage only. |
| Sections 77–80 | User confirmed applied; PR #117 merged. |
| League news | Section 61 SQL previously applied; table/RLS exist. |

## Latest baseline and Supabase observations
- PR #129 merged to main at b5faa9a.
- CI run #540 on merge commit passed; run #539 on final PR head passed.
- Active Supabase project: iba-pool-league, ref mijhllycghzdryfvfgzv. Do not use inactive project named pool-league.
- Read-only check 2026-11-10: iba_report_import_history, iba_player_weekly_counters, league_news, player_playoff_eligibility, standings_adjustments, mvp_adjustments exist with RLS enabled; Section 81 columns exist; Section 82 counter table exists; roster cutoff trigger enforce_roster_change_cutoff exists/enabled.
- At that check player_playoff_eligibility and iba_player_weekly_counters had no rows. This is a time-specific data observation, not proof imports are broken.
- Schema existence alone does not prove all policies, RPCs, UI or data completeness.

## Master rule-by-rule checklist
Status vocabulary: Not audited; Audited—no gap; Gap identified; Decision needed; Planned; PR open; Merged—not verified; Verified; Manual process; Deferred; Import-only.

| Rule | Requirement / audit target | Finding / next work | Status |
|---|---|---|---|
| Sections 1–2 | General league play, coaching, timeout limits/duration | User-provided Section 2.7 limits are settled (see decisions); current Live Entry records timeout markers for Open/Advanced but does not enforce per-player/per-set allowance. Continue remaining exact-clause audit and implement count enforcement against rating/format, including NR tier. | Gap |
| Section 3 | Sportsmanship, warnings, escalating penalties, appeals | Discuss build vs manual when reached | Decision needed |
| Section 4 | Formats/league operations | Re-read exact clauses against code | Not audited |
| 5.5 team tie-break | Official tie resolution | PR #127 audit implemented; verify exact edge cases | Verify scope |
| 5.5 MVP tie-break | Head-to-head and subsequent criteria | PR #128 audit implemented; verify incomplete-data behavior | Verify scope |
| 5.6 MVP | Formula and official ranking | Formula implemented; official import authoritative | Implemented |
| 5.7 eligibility | Official code, thresholds, 50% exception, membership, team history, forfeited-set credit | Import path; audit/reconciliation + Unverified warning remain | Gap |
| 5.8 multi-team | Same-player conflicts, set order, delayed sets, Director ruling | Membership model exists; tournament enforcement incomplete | Gap |
| 5.9 certification | Returned certification, rating thresholds, investigation/appeal | No complete workflow identified | Gap |
| 5.10 | Tournament rules | Audit exact clauses | Not audited |
| 5.11 regional team | Seasonal rosters, common players, ranking points, playoff points, points/set average | Regional ledger/workflow absent; season-reset policy override recorded | Gap |
| 5.12 regional singles | Membership, Fall roster, score/match thresholds, season count, flight seeding | No complete workflow identified | Gap |
| 5.13–5.14 | Tournament administration, decisions, appeals, practice/warnings | Re-read exact clauses; discuss build vs manual | Not audited |
| 6.1–6.3 | Format scoring | Core code exists; finish clause audit | Audit remaining |
| 6.4–6.6 | Forfeits, timing, emergency exception | Scoring exists; operational behavior needs audit | Gap |
| 6.7 | Rack/game/set completion | PR #129; verify normal, correction and historical paths | Verify |
| 6.8 | Team rating total/325 cap | Implemented; finish exact clause audit | Audit remaining |
| 6.9 | Makeup pending/resume | PR #129; verify all paths; deadlines under 8.5 | Verify |
| 6.10 | Unplayed sets | PR #122 implemented/tested | Implemented |
| 6.11 | Scoresheet fields, signatures, confirmations | Partial code audit: ratings, rack/game points, innings, safeties, set totals, win bonus and player/team point totals are represented. Player numbers are stored on selected set players but are not displayed on the Scoresheet; team numbers are not displayed there. Table size and League Office message fields are not identified in the live scoring/scoresheet UI. Both-captain signatures remain on each team's paper scoresheet by user decision; digital team confirmations are not treated as signatures. Finish checking all data paths and classify each field as app, import, or paper/manual. | Gap — partial audit |
| 7.1 | TruSpot ratings | Import only; don't recreate algorithm | Import-only |
| 8.1 | Weeks 1–5 normal; Week 6 to four weeks before end survival-only/max six; final four weeks closed; no postseason changes; extreme manager exception | Cutoff foundation exists; full restrictions/exception remain | Gap |
| 8.2–8.4 | Match/roster administration | Exact clause review | Not audited |
| 8.5 | Makeup deadline 7 days before season end; 5-day office notice | Enforcement/notice not identified | Gap |
| 8.6 | Weather/holiday rescheduling | Audit exact rules and decide workflow | Not audited |
| 8.7 | Dropped teams | Discuss software vs manual when reached | Decision needed |
| 8.8 | Replacement teams inherit points / makeup rights | Discuss software vs manual when reached | Decision needed |
| Section 9 | Dues, deposits, fees, arrears, returned checks, prize holds | Discuss software vs manual when reached | Decision needed |

## Data-entry / import inventory
- Weekly scoring: players, ratings, player numbers, team numbers, per-game points, innings, safeties, timeouts, set winner, match confirmation; table size and League Office messages need an explicit app-vs-paper decision when the exact clause is reached.
- Eligibility: official IBA code, team membership history, times with team, score history, current roster, membership application.
- Forfeit eligibility credit: presence, scoresheet listing, forfeited set, calculated-score requirement.
- Certification: return status/date, postseason starting ratings, subsequent rating changes, investigation/appeal.
- Multi-team tournament: eligible teams, event/time slot, set order, delayed match, Director ruling.
- Regional Team: seasonal rosters, common players, participation, points, playoff wins, points/set average.
- Regional Singles: Fall roster, scores, matches, seasons, membership, flight rating.
- Makeup: agreement, scheduled date, notice, completed/outstanding sets, weather/holiday exception.
- Roster: effective date/week, reason, roster size, survival-only qualification, manager exception.
- Conduct/coaching: player, incident, warning, repeat offense, penalty, decision-maker, appeal.
- Finance: dues, renewals, deposit, weekly fees, sanction fees, unpaid balances, returned payment, prize hold.

## Recommended phase order
1. Scoring/scorekeeping compliance: finish the Section 6.11 field-by-field audit; then implement Section 2.7 timeout-count enforcement and any confirmed Section 6.11 digital gaps; verify all affected formats.
2. Eligibility/postseason readiness: 5.7 reconciliation/warnings; 5.8 multi-team rules; 5.9 certification.
3. Roster/match administration: complete 8.1; makeup deadlines/notices; forfeits; weather/holiday; discuss dropped/replacement-team workflows.
4. Regional/tournament: Regional Team ledger; Regional Singles; remaining postseason rules.
5. Coaching/conduct/finance: discuss each rule with user and build only where agreed.
Phases are sequencing guidance; individual features remain subject to exact rule audit and user decision.

## CI / merge policy
- Never ignore an "All jobs have failed" email without inspection.
- Recent PRs had genuine failures on intermediate commits while edits were in progress. Example: PR #129 earlier run 537 failed tests/setWinner.test.js; later PR-head run 539 passed and merge run 540 passed.
- Merge readiness is based on latest PR-head SHA and required checks, not every superseded run and not merely the fact the PR was merged.
- If latest PR-head run fails, stop and fix. If an earlier commit failed but latest head passed, older run is superseded for merge readiness but remains a historical failure.
- After merge, verify CI on merge commit. Successful main CI confirms merged snapshot passed configured workflow; it does not excuse bypassing a failed required PR check.
- Before merge verify PR head SHA, latest CI for that SHA, tests, production build, SQL access check when applicable; verify merge commit CI afterward.
- Preserve failure visibility; do not disable checks/notifications to hide genuine regressions.

## Cross-chat continuation
At the start of every new Pool App audit chat:
1. Read this file from current main and carry forward its settled decisions/statuses without asking the user to repeat them.
2. Read exact rulebook source; this summary is not a substitute for the rule text.
3. Check main SHA, open PRs, recent merges, latest CI, and relevant active Supabase schema/data.
4. Reconcile drift in this file.
5. Resume earliest unresolved item in phase order.
6. Ask only for decisions genuinely needed to interpret/scope the next rule.
7. Update this file through a focused PR when a decision/status/phase changes.

Suggested new-chat prompt:

> Continue the IBA Pool League App rulebook audit. First read docs/rulebook-audit/MASTER-PLAN.md from current main, then reconcile it with the exact rulebook source, current GitHub PR/CI state, and active Supabase project. Do not repeat completed work or assume unverified items are complete. Resume at the earliest unresolved item in the phase plan, and ask me rule-specific build-vs-manual questions as we reach those sections.
