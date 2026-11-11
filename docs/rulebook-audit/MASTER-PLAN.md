# IBA Pool League App — Master Rulebook Audit & Implementation Plan

Last reconciled: 2026-11-10 (local project date; GitHub timestamps may display the following UTC date)  
Code baseline: `main` after PR #135 merge (Section 6.4–6.6 forfeit lifecycle and solo-scoring/makeup handling).  
Documentation update: PR #131, branch `docs/rulebook-audit-continuity-6-11` (merged); PR #132 implementation recorded here after merge.

This file is the single source of truth for rulebook scope, decisions, current implementation, outstanding audit, data entry/import needs, and delivery order. It is deliberately honest about what has and has not been checked: a complete inventory is not the same as a completed clause-by-clause audit.

## 1. Working agreement — how we prevent missed rules and repeated audits

1. **No rulebook clause is skipped.** Every numbered clause and material sub-rule appears in the register below. A rule may be implemented in the app, supplied by an official IBA import, or intentionally handled on paper/by league management.
2. **Audit once, track forever.** Once a clause is audited, record the evidence, decision, gaps, tests, PR/SQL, and verification state here. Do not ask the user to repeat a settled decision or re-audit a verified item without a specific new code change, contradictory evidence, failed test, or changed rule.
3. **Review before build.** Discovery and alignment happen before implementation. When a gap is found, explain what the rule requires, what the current app does, what is missing, and the proposed implementation path. Discuss and resolve the proposed behavior with the user before writing production code or opening an implementation PR.
4. **Separate the lifecycle statuses.** "Audited" does not mean implemented; "merged" does not mean verified; a table existing does not mean data has been imported; a test passing does not prove live Supabase data or manual league operations.
5. **Every gap gets a closure definition.** A rule is not closed until its implementation route (app/import/manual) is explicit, acceptance criteria are met, tests pass, required SQL is applied by the user, and live behavior is verified where applicable.
6. **No hidden assumptions.** When a rule requires a decision whether to build, import, or retain a paper/manual process, present the exact rule and practical choices when its phase is reached. Do not create unnecessary app workflows for duties the rulebook assigns to captains, referees, Tournament Directors, or the League Office.
7. **Official IBA data remains authoritative** where the user has chosen it: TruSpot ratings, official standings/MVP positions, and official playoff eligibility codes. Do not silently replace official data with locally inferred results.
8. **User's paper scoresheet decision remains in force.** Each team continues to keep its own paper scoresheet. The app supports one team's independent digital score entry; the opposing team's digital entry/comparison is optional. Paper captain signatures remain the acceptance record. Do not present app confirmations as signatures.
9. **SQL is manually applied by the user.** Any future migration creating a public table must include RLS and deliberate Data API grants in the same migration. Never claim a migration was applied unless the user confirms or a live read-only check proves the expected schema.
10. **PR discipline.** Focused PRs only; no cloning or local-computer changes. Do not merge without the user's approval. Inspect the latest PR-head CI, not a superseded run. After merge, verify the merge commit. Avoid unnecessary Vercel previews/deployments.
11. **Continuity at every new chat.** Read this file from current `main`, reread the exact rulebook clauses for the next task, reconcile main/PR/CI and the active Supabase project, then resume the earliest open item in the phase order. Never ask the user to re-provide known limits or decisions.

### Status definitions

| Status | Meaning |
|---|---|
| Verified | Implementation or agreed process checked against acceptance criteria; evidence and test/live verification recorded |
| Implemented — verification open | Code/SQL exists, but full behavior, live data, or edge cases are not yet verified |
| Partial | Some requirements are represented, but material requirements remain missing |
| Import-only | Official IBA report is the selected source; import, matching, freshness, missing-data behavior still need validation |
| Manual process — agreed | User has explicitly chosen paper, referee, Tournament Director, or League Office handling |
| Gap | A required behavior or data path is known to be missing or incomplete |
| Decision needed | Rulebook leaves an operational choice or user must choose app vs manual handling |
| Not audited | Exact clause has not yet been compared field-by-field with current code and workflow |
| Deferred | Audited and intentionally sequenced later; not complete |

## 2. Settled decisions — do not reopen without new evidence

- Formats are **Open, Advanced, Masters**.
- Section 2.7 coaching time-outs are per player, per set:
  - Open rating 30–50: 2 periods.
  - Open rating 51–150: 1 period.
  - Advanced rating 40–150: 1 period.
  - Masters rating 50–150: 0 periods.
  - NR uses the lowest time-out tier for that format.
  - Coaching period duration is one minute. The exact rulebook wording around occasional vs repeated over-one-minute periods must be implemented consistently with the user's settled one-minute rule and the warning/penalty procedure already discussed; do not ask for the rating limits again.
- Section 6.7: when both players reach their ratings in the same game, the winner of the last game wins the set. **Do not ask the scorekeeper who won.** Determine it from the recorded game result.
- Section 5.7: official IBA playoff-eligibility import is authoritative. Missing data means **Unverified with a warning**, not automatically ineligible. Do not create an independent eligibility calculator that overrides the official code.
- Eligibility thresholds previously captured for reference: Division playoffs 4 times with team + 7 IBA scores; Seasonal tournaments 5 + 8; Regional Team Championship 6 + 9. New-player exception: exactly 50% of current roster qualifies; reduces calculated-score minimums to 5/6/7 respectively, not times-played requirements. Current-year IBA membership application is required. Drop/re-add resets times with team. At most one forfeited set can count, and only if the player was present, listed on the scoresheet, and met the calculated-score requirement. The official eligibility import remains the deciding source.
- Each team keeps its own paper scoresheet; the app supports one team's independent digital entry; second-team digital entry/comparison is optional. Both captains' paper signatures remain required by the agreed process; app confirmation is not a signature.
- Section 5.11: regional ranking points reset each season under the user's explicit app-policy decision, despite the rulebook's calendar-year wording. Preserve this as an explicit policy override, not an unnoticed interpretation.
- Section 5.5 tie-break audit work does not replace official IBA standings/MVP positions. Official imported positions remain authoritative.
- Weekly Play/Win values are team-specific. In playoffs, the import supplies eligibility, not weekly Play/Win values; do not invent playoff counters.
- A player may be on multiple teams, and may be a player on one team and captain of another. Do not conflate player memberships with captain authority.
- Team numbers can contain letters (example: `76A01`); do not validate them as numeric-only.

## 3. Verified implementation and delivery history

This is the known baseline from merged PRs and prior user-confirmed SQL actions. The individual rule register below identifies what remains to verify.

| Work | Current evidence/status |
|---|---|
| PR #120 — Open scoring correction (6.1) | Merged. Core Open scoring correction is in main; complete Section 6 clause audit and full-format acceptance remain. |
| PR #121 — Section 6.6 forfeit scoring coverage | Merged. Adds/extends focused forfeit-point tests; not proof that all 6.5 timed team-forfeit operations are implemented. |
| PR #122 — Sections 6.4, 6.9, 6.10 | Merged. Individual-forfeit rating treatment, pending-makeup rating adjustment behavior, and unplayed-set behavior were implemented/tested. |
| PR #123 — official IBA team/MVP positions | Merged. Section 81 adds official position storage. |
| PR #124 — official IBA snapshots as standings source | Merged. Official imported standings snapshots remain the standings source of truth. |
| PR #125 — cumulative played/won from IBA roster reports | Merged. Parser captures the counters. |
| PR #126 — persist team-specific weekly Play/Win counters | Merged. Section 82 SQL was user-applied; schema existence was verified. Population/currentness must be rechecked when eligibility workflows are validated. |
| PR #127 — Rule 5.5 team tie-break audit | Merged. Audit/reconciliation support; official published ranking is not overwritten. |
| PR #128 — Division MVP Rule 5.5 tie-break audit | Merged. Audit/reconciliation support; official published ranking is not overwritten. |
| PR #129 — Section 6.7 and pending-makeup correction | Merged. CI passed on final PR head and merge commit. Includes simultaneous-finish logic and pending-makeup rating treatment. One code-path verification item remains in the Section 6.7 register below. |
| PR #130 — initial master audit plan | Merged. Established this document. |
| PR #131 — continuity and full audit register | Merged. Documentation-only master-plan expansion is now on `main`. |

### Database / SQL baseline

- Active Supabase project: `iba-pool-league`, ref `mijhllycghzdryfvfgzv`. Never use the inactive project named `pool-league`.
- Sections 76–82 were previously confirmed applied by the user. Section 76 validation previously returned true for the cutoff function, captain permission, new-player function, trigger function, enabled roster cutoff trigger, and add/remove RPC enforcement.
- Section 81 official standings position columns and Section 82 team-specific weekly counters were previously confirmed present.
- Prior read-only audit found `league_news`, `iba_report_import_history`, `iba_player_weekly_counters`, `player_playoff_eligibility`, `standings_adjustments`, and `mvp_adjustments` with RLS enabled. At that time, `player_playoff_eligibility` and `iba_player_weekly_counters` had no rows. Recheck live rows before asserting imports are populated.
- Section 61 league news, Sections 77–80, and Sections 81–82 are historical infrastructure. They are not themselves proof of rulebook compliance.
- A schema/table existing is not proof that its import, UI, policy, RPC, data population, or user-facing warning works.

## 4. Master rule-by-rule register

The register covers every numbered clause in the supplied rulebook. "Not audited" is an intentional visible status, not a claim that the rule is unimportant. The next phase converts these entries into exact requirement/code/data/acceptance audits and then closes them.

### Section 1 — General Rules

| Clause | Rule area | Current status / next action |
|---|---|---|
| 1.1 | Playing table / start time / home advantage | Not audited. Determine which parts are enforced by schedule/venue workflow and which remain team responsibilities. |
| 1.2 | Who puts up first / coin flip / alternating order | Partial evidence: Live Entry has coin-flip and put-up sequencing. Audit exact alternating sequence, edge cases, and whether the UI clearly supports it. |
| 1.3 | Lag / first break / winner breaks next | Not audited. Likely referee/player process; decide whether any scorekeeping field is required. |
| 1.4 | Fouls and ball-in-hand penalties | Not audited. Broadly referee/opponent adjudication; identify only the digital recording/penalty behaviors the rulebook requires. |
| 1.5 | Cue ball in hand | Not audited; manual play rule unless a required scoring record is identified. |
| 1.6 | Pocket patch (Open format) | Not audited. Open-only rule; likely player process, no app workflow assumed. |
| 1.7 | Safety notification | Partial: safety counts are entered in Live Entry. Whether the app needs any separate notification/acknowledgement is not audited. |
| 1.8 | Frozen cue ball | Not audited; likely manual/referee rule. |
| 1.9 | Accidentally moved balls | Not audited; likely manual/referee rule. |
| 1.10 | Accidentally pocketed ball | Not audited; likely manual/referee rule. |
| 1.11 | Hanging ball | Not audited; likely manual/referee rule. |
| 1.12 | Jumped ball | Not audited; likely manual/referee rule. |
| 1.13 | Jump shots | Not audited; likely manual/referee rule. |
| 1.14 | Masse shots | Not audited; likely manual/referee rule. |
| 1.15 | Stalemated game | Not audited; determine if a re-rack/result entry is needed. |
| 1.16 | Accidentally shooting wrong group | Not audited; likely manual/referee rule. |
| 1.17 | Cue ball out of kitchen | Not audited; likely manual/referee rule. |
| 1.18 | Legal cue ball | Not audited; likely manual/referee rule. |
| 1.19 | Jawed balls | Not audited; likely manual/referee rule. |
| 1.20 | Interference with stroke | Not audited; likely manual/referee rule. |
| 1.21 | Final position of balls | Not audited; likely manual/referee rule. |
| 1.22 | Required warnings | Not audited. Cross-reference Section 2 coaching and Section 3 conduct; determine whether any warnings/penalties must be logged for League Office review. |

### Section 2 — Coaching

| Clause | Rule area | Current status / next action |
|---|---|---|
| 2.1 | Definition of coaching | Not audited. Define the app's role; likely incident/referee process rather than live shot adjudication. |
| 2.2 | Player chooses own coach at start of set | Gap. Live Entry has no coach selection field or persisted coach identity. |
| 2.3 | Changing coach only for two-table conflict exception | Gap. No coach assignment/change workflow identified. |
| 2.4 | Coach roster membership, conduct, position, no touching balls | Not audited; mostly manual enforcement. Determine whether incident record is needed. |
| 2.5 | When coaching is in effect | Not audited; manual enforcement. |
| 2.6 | Coaching period start/end and one-minute guidance | Gap. No period timer, duration, or warning/penalty workflow identified. Apply the settled one-minute user decision consistently with the rulebook's occasional-vs-habitual wording. |
| 2.7 | Timeout reasons, allowance, opponent acknowledgement, over-limit warning/foul | **Deferred, not implemented.** Live Entry currently records Open/Advanced timeout markers only; Masters has no timeout controls, consistent with zero allowance. No per-player/per-set count, NR tier, remaining count/status-check, timeout reason, acknowledgement, selected coach, warning, violation, or ball-in-hand enforcement. Implement after Section 6.11 in Phase 1. Limits are settled above; do not ask again. |
| 2.8 | Coaching violations | Gap. No structured violation/penalty record identified. |
| 2.9 | Sportsmanship in coaching | Not audited; connect to Section 3 incident handling. |

### Section 3 — Sportsmanship

| Clause | Rule area | Current status / next action |
|---|---|---|
| 3.1 | Good sportsmanship / honest answers / roster disclosure | Not audited; likely manual. Check if captain roster changes need a record/notice. |
| 3.2 | Poor sportsmanship examples, sharking, slow play, verbal/physical abuse | Not audited; likely League Office incident process. |
| 3.3 | Penalties (warning through expulsion, rating/points/captain role/postseason) | Decision needed. Ask which parts need app support versus manager-maintained records. |
| 3.4 | Right of appeal / neutral committee | Decision needed; likely manual governance. |
| 3.5 | Bad behavior of opponent / protest documentation | Decision needed. Scoresheet's League Office message area is paper today; determine whether a digital incident/protest record is wanted. |
| 3.6 | Tournament sportsmanship violations | Manual/TD rules are the likely path; verify tournament rules sheet and record-keeping expectations. |

### Section 4 — League Structure

| Clause | Rule area | Current status / next action |
|---|---|---|
| 4.1 | Divisions (4–16 teams, day/time, geography, special divisions) | Partial: seasons/divisions/schedules are represented. Audit minimum/maximum team count, special-division exceptions, and schedule constraints. |
| 4.2 | Teams (1–8 roster members; 2–6 play per match) | Partial: team rosters and five-set lineup workflow exist. Audit 1–8 roster boundaries and match participation exceptions. |
| 4.3 | Captain duties | Partial: captain identity, team management, roster, and schedule tools exist. Audit contact/communication, roster responsibility, and manager escalation duties. |
| 4.4 | Coach role | Gap with Section 2: no selected coach data path identified. |
| 4.5 | Player membership, amateur/age, identity, multiple teams/divisions, one set per match | Partial: player identity linking and multiple team memberships exist; PR #113 addressed identity-linking and multi-team role cases. Audit division-season exclusivity, tournament limits, proof-of-identity handling, and one-set restriction. |

### Section 5 — Regular and Post-Season Play

| Clause | Rule area | Current status / next action |
|---|---|---|
| 5.1 | Regular-season standings determine seeding; championship/consolation brackets | Partial/import-led: official IBA standings are authoritative (PRs #123/#124). Audit bracket qualification, consolation cross-division brackets/byes, and trophy eligibility. |
| 5.2 | Division playoff pairings and home advantage | Not audited end-to-end. Verify playoff schedule generation, seed pairing, and home-field assignment. |
| 5.3 | Seasonal Championship/Consolation qualification | Not audited end-to-end. Verify first-place automatic qualification and division champion/consolation champion routes. |
| 5.4 | Seasonal tournament seeding/byes | Not audited. Audit seeding categories and bye assignment. |
| 5.5 — Team | Head-to-head points, sets won, points lost, record vs immediately lower team | PR #127 merged; audit helper exists. Official standings position remains authoritative. Verify exact tie-data completeness and display only; do not replace official position. |
| 5.5 — Division MVP | Head-to-head points, opponent average rating difference of 5, single-set playoff | PR #128 merged; audit helper exists. Official IBA MVP position remains authoritative. Verify exact tie-data completeness and display only; no independent ranking override. |
| 5.5 — Gladiator match | Postseason sudden-death exception allowing already-played player | Not audited; requires tournament match/TD process. |
| 5.5 — Dead heat | Regular-season tie stands; postseason tie resolved by three of five set wins | Not audited. Confirm team match result handling in playoff mode. |
| 5.6 | Division MVP formula, forfeit win 125 without 200 set-win bonus, top-15 invitations | Partial/import-led: official MVP positions are captured and preserved (PRs #123/#124); imported MVP report parser exists. Audit formula and eligibility/invitation edge cases without overriding official ranking. |
| 5.7 | Postseason eligibility, times with team, scores history, membership, 50% new-player exception, forfeit credit | Import-only with a gap. Parser and storage path for official playoff eligibility codes exist; roster launch attaches imported `eligCode`. Missing code currently does not block the player, consistent with not auto-blocking, but an explicit **Unverified warning** in the lineup/manager workflow remains to verify/implement. Do not independently calculate or override official eligibility. Verify import matching, report freshness, code mapping, membership application status if the official report covers it, and one-forfeit credit semantics. Section 82 weekly counters are supporting imported data, not a substitute for the official eligibility code. |
| 5.8 | Multi-team tournament eligibility, self-match restriction, first/second/third set, delayed set, TD decision, anti-stalling | Gap. Multi-team membership exists; tournament time-slot conflict, set-order restrictions, delay queue, TD decision, and stall warning are not implemented/verified. |
| 5.9 | Team Rating Certification, potential/automatic disqualification, appeal | Gap. No certification return, baseline rating snapshot, postseason change tracking, or appeal workflow identified. |
| 5.10 | Sudden-death match end, postseason forfeit points, tournament referee exceptions, game formats, stopwatch, TD rules sheet, coaching/sportsmanship | Partial/manual. Forfeit point code exists. Tournament-only referee/stopwatch/TD authority and 8/9/10-ball tournament scoring are not a live app workflow; decide what needs recording and what remains manual. App's current match scoring is 8-ball. |
| 5.11 | Regional Team Championship eligibility, Fall roster, common players, seasons, ranking points, points/set average tiebreak | Gap. No complete regional team ledger/workflow identified. Preserve user's explicit season-reset override; do not revert to calendar-year rule. |
| 5.12 | Regional Singles eligibility, membership, Fall roster, scores, matches/seasons, flight seeding | Gap. No complete eligibility ledger/seeding workflow identified. |
| 5.13 | Tournament Directors / referee / appeals | Manual process candidate. Confirm whether TD assignment/contact and decisions need app records. |
| 5.14 | Tournament practice prohibition and escalating penalties | Gap/manual decision. No tournament practice-warning/penalty tracking identified. |

### Section 6 — Scoring Rules

| Clause | Rule area | Current status / next action |
|---|---|---|
| 6.1 | Winning shooter points by format | Implemented in core scoring; PR #120 corrected Open scoring. Finish exact clause tests across Open/Advanced/Masters, including normal and NR sets. |
| 6.2 | Losing shooter points by format | Implemented in core scoring; verify Open/Advanced retain scored points and Masters receives zero across all paths. |
| 6.3 | Margin of victory; race-to-points/games; NR exception | Partial. Current scoring implements points-based margin and fixed NR target behavior. Audit whether race-to-games is applicable to any IBA event in this app and confirm exact NR/established-player loser calculation. |
| 6.4 | Individual forfeit player selection, rating totals, no bonus to forfeiting team, last-set ordering | Implemented — verification open. PR #122 provides the core path; this pass adds enforcement that a forfeit after play has begun must be trailing, preserves unused/present player selection, and covers late/make-up resolution. Full acceptance still requires regression testing and manual verification. |
| 6.5 | Team match timed forfeits at 15/30/45 minutes; emergency 15-minute allowance; no-show/lone shooter options | Manual process — agreed for 15/30/45-minute and emergency timing; the app records resulting forfeits rather than enforcing a clock. The app now supports an explicit full-match forfeit path plus individual trailing forfeits and make-up resolution; verify lone-shooter/no-show edge cases and final Scoresheet persistence. |
| 6.6 | Forfeit point values, regular vs postseason | Implemented — verification open. Values are regular Open 125, Advanced 150, Masters 100; postseason Open 100 + receiving player's rating, Advanced 250, Masters 200. Shared scoring is used by live and administrative make-up forfeits. Final closure requires focused tests/manual verification across all formats and postseason status. |
| 6.7 | Game completion, same-game simultaneous rating finish, last-game winner | PR #129 merged; user decision is explicit: last game's winner wins, no prompt. Verify the stored per-game score representation always identifies the winner. Current `detectSetWinner` returns a side when game points differ, but has a `tiebreak` fallback when the last game's recorded points are equal; confirm whether equal totals are possible in valid 8-ball scoring and add a regression test so no scorekeeper winner prompt is ever needed. |
| 6.8 | Team match totals and 325 rating limit; NR rating values | Core team scoring and 325 bonus/5x penalty exist in `db.js` and Scoresheet. Verify all five played/forfeited set combinations, NR=45 Open / 50 Advanced-Masters, Round Robin NR=75 exception, and that Masters is excluded from team rating adjustment. |
| 6.9 | Make-up agreement/date; suspend bonus/penalty; ratings at time played | PR #129 passes pending-makeup state into rating adjustment; PR #122 related behavior. App records makeup reason/confirmation and pending status. Gap: score sheet's required makeup date and League Office notice are not digitally captured (paper decision may satisfy); audit deadline/notice rules under 8.5 separately. |
| 6.10 | Unplayed sets when neither team has enough players; each gets points to date; no rating bonus | Implemented/tested in PR #122. Verify historical display and completed-vs-pending standings treatment. |
| 6.11 | Independent team scorekeeping; required player/set fields; table size, League Office messages, signatures | Implemented — verification open. PR #132 is merged. Team numbers are copied into new live-match state and displayed on the completed Scoresheet; player numbers are displayed there as well. No team/player identifier controls were added to live scoring. Older archived matches without a stored team number show unavailable rather than guessing. The remaining required digital score fields are represented by the existing match/Scoresheet path. Table size and League Office messages remain paper-back-of-sheet fields. Both captains' signatures remain paper/manual by user decision; digital confirmations are not signatures. Remaining Phase 1 work is the full field-by-field acceptance check, not another live-scoring UI change. |

### Section 7 — Rating System

| Clause | Rule area | Current status / next action |
|---|---|---|
| 7.1 | TruSpot player ratings / rating percentage | Import-only for official ratings; do not recreate TruSpot. Verify current rating import, historical rating snapshots on each played set, and rating percentage/match scoring behavior. |
| 7.2 | Team rating limit | Implemented in scoring: 325 limit, positive difference bonus and 5x over-limit penalty for Open/Advanced. Cross-check against Section 6.8; no duplicate implementation. |

### Section 8 — Miscellaneous Rules

| Clause | Rule area | Current status / next action |
|---|---|---|
| 8.1 | Roster windows: Weeks 1–5; survival-only through four weeks before end; max six; final four weeks closed; no postseason changes; extreme manager exception | Partial. Section 76 enforces captain Week 6 cutoff foundation and manager authority. Remaining survival-only qualification, max-six rule, final-four-week cutoff, postseason freeze, and extreme-circumstance manager override need full audit/implementation. |
| 8.2 | Home team's table choice; one/two-table demand at one hour; no delay/harassment | Not audited. Determine whether scheduling/live match needs table count/choice/time records or whether this remains captain/referee process. |
| 8.3 | Illegal substitution / false identity / match points and postseason disqualification | Partial. PR #113 hardened player-number identity linking; it does not by itself implement investigation, match-point reversal, postseason disqualification, suspension, or captain consequences. |
| 8.4 | Schedule publication, odd-team BYE, first five weeks provisional, rotating byes, incomplete-cycle average points | Partial: schedule import/management exists. Audit BYE rotation, incomplete-cycle average-point treatment, and conversion of provisional TBA matches into makeups/byes. |
| 8.5 | Make-up scheduling responsibility, 7-day cutoff, 5-day League Office notice, failure-to-agree consequences, suspend during regular play | Gap. No complete deadline/notice/exception enforcement verified. |
| 8.6 | Official weather emergency and holiday reschedule rights/notice | Not audited. Likely manager/manual workflow; decide if app needs reason, notice timestamp, and approval record. |
| 8.7 | Dropped team standings remedies | Decision needed. Rule grants management discretion among wiping results, averages, byes, or other methods. Ask user whether to build manager adjustment tools or keep manual League Office action. |
| 8.8 | Replacement team inherits points and up to three makeups | Decision needed. Determine whether current season/team replacement data model can represent inheritance and makeup entitlement or if manager records it manually. |
| 8.9 | No smoke breaks during a set | Manual process candidate; no app enforcement assumed. |
| 8.10 | Rack templates allowed if both players have option | Manual process candidate; no app enforcement assumed. |
| 8.11 | Personal balls allowed if regulation and both agree | Manual process candidate; no app enforcement assumed. |

### Section 9 — Financial Rules

| Clause | Rule area | Current status / next action |
|---|---|---|
| 9.1 | $20 annual membership; $10 qualifying Fall-to-Winter renewal | Decision needed: determine whether app should track dues/payment eligibility or whether League Office/payment records remain external. |
| 9.2 | Other sanction fees | Decision needed; likely external/manual unless user requests fee ledger. |
| 9.3 | Team responsibility; hold prize money for arrears/returned checks | Decision needed; determine whether app needs account balances/prize holds or manager-only notes. |
| 9.4 | Unpaid roster players through Week 5; team assumes fees thereafter | Gap/decision needed. Related to 8.1 roster window; decide if membership-paid status is tracked in app. |
| 9.5 | $30 refundable team deposit / forfeiture conditions | Decision needed; likely manager finance ledger. |
| 9.6 | $40 weekly fees; both teams pay despite forfeits; bye and tournament exceptions | Decision needed; determine whether fees are tracked in app or remain external. |
| 9.7 | Split game cost / special pocketed-ball retrieval situations | Manual process candidate. |
| 9.8 | Check payee, returned-check amount + $20 within 30 days, team liability | Decision needed; likely external accounting process. |
| 9.9 | Dropout team full-season fees if roster not withdrawn 7 days before season; captain/member liability | Decision needed; align with Section 8.7; likely League Office finance process. |

## 5. Priority audit/implementation queue — the order we will follow

This order closes scoring, forfeits, eligibility, and scorekeeping before moving to less central rulebook areas. Within each phase, finish the audit, list every gap, implement focused PRs, apply any SQL, verify, then mark closed here. Do not jump ahead merely because a later feature is easier.

### Phase 0 — Establish the baseline and keep this tracker authoritative
1. Merge PR #131 after reviewing the expanded plan.
2. At the start of each work block, refresh main SHA, open PRs, latest CI, and relevant live Supabase facts.
3. Update this plan in the same PR as each material audit decision/status change, or a focused docs PR if implementation is separate.

### Phase 1 — Complete scoring, forfeits, coaching time-outs, and scorekeeping (Sections 6.1–6.11, then 2.7)
1. Complete the 6.11 acceptance check: verify player number and team number persistence/display on completed Scoresheet, plus existing ratings, safeties, points/game, innings/game, totals, winner bonus, and player totals. No live-scoring identifier UI is required. Table size, League Office messages, and captain signatures remain paper/manual by settled decision.
2. **Section 6.4–6.6 implementation is complete and merged (PR #135).** The app supports explicit full-match forfeits before play, individual trailing forfeits after play begins, receiving/forfeiting player attribution and unused/present-player restrictions, started → makeup → later-forfeit lifecycle handling, the applicable makeup/forfeit deadline, and Section 6.6 point values. The app intentionally does **not** automate the rulebook's 15/30/45-minute clock or emergency allowance; those remain Manual process — agreed. Single-scorer match entry is also accounted for in makeup confirmation: an unavailable/non-participating side does not deadlock the workflow, while the available scorer explicitly reviews/acknowledges the makeup submission. Remaining verification is limited to the focused Phase 1 acceptance checks, including live Scoresheet persistence and the exact Section 6.6 source-table confirmation.
3. Close remaining 6.1–6.3 and 6.8 scoring edge cases across Open, Advanced, and Masters, including NR, rating percentage, margin, all forfeit combinations, and team-rating cap.
4. Verify Section 6.7 simultaneous finish end-to-end. The last-game winner must be derived automatically; add coverage for any valid score representation edge case. No winner-selection prompt.
5. Verify 6.9/6.10 makeup and unplayed-set lifecycle, including pending standings, resumed match, finalization, and historical Scoresheet.
6. Implement Section 2.7 and the connected 2.1–2.6/2.8 fields needed for enforcement: coach selection, per-player/per-set allowance, NR tier, remaining count/status check, timeout reason, opponent acknowledgement, one-minute period, warning, repeat violation, and ball-in-hand penalty. Masters remains zero. Do not ask the user for settled limits.
7. Run focused tests plus full Vitest/build/SQL-access CI. Perform an end-to-end acceptance pass for all three formats and normal/forfeit/makeup match paths. Only then mark the scoring/forfeit/scorekeeping phase Verified.

**Phase 1 acceptance gate:** A match can be scored correctly in all three formats; regular and postseason forfeits produce exact rulebook points; team-match timing/forfeit exceptions are accounted for; all required scoresheet fields are available through the app or the explicitly retained paper process; no simultaneous-finish winner prompt exists; makeup/unplayed-set points and rating adjustments are correct; timeout allowances and penalties are enforced.

### Phase 2 — Postseason eligibility and multi-team/certification (Sections 5.7–5.9, related 4.5)
1. Verify the official playoff eligibility report parser, week/date matching, player-number linking, import history, duplicate handling, and roster attachment.
2. Make missing/unmatched/stale eligibility visibly **Unverified** with a warning; do not silently treat it as confirmed eligible and do not automatically block it. Known official ineligible codes continue to gate selection.
3. Validate the official code mapping and the user's settled thresholds/new-player/forfeit-credit decisions against the source report. Do not calculate a competing eligibility result.
4. Audit Section 5.8 tournament time-slot conflicts, player-versus-self restriction, first/second/third-set rule, delayed-set queue, no-withdrawal-after-matchup, TD decision, and stalling warning.
5. Audit/build Section 5.9 certification return, baseline rating snapshot, post-season rating movement thresholds (+15/+40 potential; +20/+60 automatic), potential-DQ investigation/neutral appeal, and automatic-DQ behavior.
6. Verify Section 4.5 one-team-per-division/season restriction and tournament two-team/two-event limit against multi-team memberships.
7. Verify live data population and freshness for `player_playoff_eligibility` and Section 82 counters; no rows means no eligibility data can be claimed as loaded.

**Phase 2 acceptance gate:** Official import is the only eligibility authority; unknown data is visibly Unverified; known ineligible players cannot be selected; multi-team tournament conflicts and certification rules are either implemented or explicitly assigned to a documented manual/TD process.

### Phase 3 — Roster, schedule, makeup, and match administration (Sections 4.1–4.3, 8.1–8.8)
1. Complete Section 8.1 beyond the Week 6 cutoff: survival-only changes, six-player cap, final four-week freeze, postseason freeze, and manager extreme-circumstance exception.
2. Audit Section 8.3 illegal substitution consequences and the evidence/manager workflow beyond identity-link security.
3. Audit Sections 8.2/8.4 table choice, one/two-table timing, schedule publication, TBA conversion, BYE rotation, and incomplete-cycle average points.
4. Implement or explicitly manualize Section 8.5 deadlines, five-day office notice, no-agreement consequences, and makeup suspension/resumption.
5. Audit Section 8.6 weather emergency and holiday notice requirements.
6. Ask the user for build-vs-manual decisions on dropped teams (8.7) and replacement teams (8.8), then record and implement only the agreed path.
7. Reconcile team/division limits and captain responsibilities in Sections 4.1–4.3 with current season/schedule/roster workflows.

**Phase 3 acceptance gate:** Captains/managers cannot make prohibited roster changes; permitted exceptions are manager-controlled; schedule/byes and table-choice requirements are correctly represented; makeups and team changes follow deadlines and approval rules.

### Phase 4 — Standings, playoffs, MVP, and regional/tournament administration (Sections 5.1–5.6, 5.10–5.14, 5.11–5.12)
1. Verify regular standings, playoff seeding, division brackets, consolation cross-division brackets, seasonal tournament qualification, seeding, and byes.
2. Verify official standings/MVP imports and positions; retain the completed 5.5 tie-break audit support without overriding IBA's published positions.
3. Finish Section 5.6 formula/forfeit-win handling and top-15 invitation eligibility audit.
4. Audit sudden-death match completion, postseason forfeit scoring, TD-specific scoring/shot calls/stopwatch, tournament rules sheet, and practice penalties.
5. Decide whether to build regional team ranking/prize eligibility and regional singles eligibility/flight seeding. Preserve the user's season-reset override for regional ranking.
6. Decide which TD decisions, appeals, and tournament incidents are stored in the app versus kept in official paper/League Office records.

**Phase 4 acceptance gate:** Official standings and MVP positions remain authoritative; all qualification/seeding calculations are reproducible and testable; tournament-only exceptions are either supported or documented as manual with an accountable role.

### Phase 5 — Coaching, general play, and sportsmanship (remaining Sections 1–3, 4.4)
1. Audit Sections 1.1–1.22 clause by clause. Classify each as app support, referee/player process, or manual; only build digital behavior when it improves required scoring, warning, or evidence capture.
2. Complete coaching rules 2.1–2.9 not already closed in Phase 1, including selected coach restrictions and coaching-violation handling.
3. Review sportsmanship 3.1–3.6 and ask the user for decisions on incident logs, evidence, penalties, and appeals. Preserve League Office/neutral committee authority.
4. Close the Section 4.4 coach role and its relationship to roster membership.

**Phase 5 acceptance gate:** Every general-play/coaching/sportsmanship clause has an explicit app/import/manual disposition; any required warning or incident data is captured without trying to automate subjective referee/management judgment.

### Phase 6 — Financial rules (Section 9)
1. Review each fee/dues/deposit/returned-check/prize-hold requirement with the user.
2. Decide which financial facts, if any, should be tracked in the app versus external accounting/League Office records.
3. Implement only the agreed scope with role protection and auditable history.

**Phase 6 acceptance gate:** Each financial clause has an explicit owner and record location; no fee or payment workflow is assumed or built without user approval.

### Final completion gate — whole rulebook
- Every clause in Sections 1–9 has a final status of Verified, Import-only, or Manual process — agreed (or a clearly documented exception/decision).
- No clause remains Not audited, Gap, Partial, Deferred, or Decision needed.
- Every implementation has tests and a merged PR; every required SQL migration is confirmed applied; live data/import checks are recorded; manual responsibilities are documented.
- The user receives a final rulebook-to-app coverage report with remaining operational limitations, not just a list of merged PRs.

## 6. Data-entry and import inventory

| Rule area | Required information / source | Current position and remaining work |
|---|---|---|
| Match setup / 1.1–1.3 | Scheduled time, home/away, table selection, coin flip, lag/break order, put-up sequence | Schedule and coin-flip/put-up code exist; audit the remaining rule fields and whether table/lag are manual. |
| Scoring / 6.1–6.8 | Format, player identity/number, rating, per-game points, innings, safeties, set winner, ratings used, forfeit status/points | Core live state and scoring exist; finish full validation and Section 6.11 identifier display/persistence audit. |
| Coaching / 2.1–2.9 | Coach identity, roster membership, time-out reason, count, duration, acknowledgement, warnings, violations, BIH penalty | Timeout marker only today; fields/workflow are a Phase 1 gap. |
| Forfeits / 6.4–6.6 | Forfeiting side, both listed players, player present/unused status, match start time, forfeit points, makeup deadline, trailing-set lifecycle | Individual and full-match forfeits, player attribution, trailing-set enforcement, makeup/deferred-set lifecycle, deadline handling, and solo-scoring makeup confirmation are implemented; 15/30/45-minute and emergency timing remains manual by agreement. |
| Makeup / 6.9–6.10 and 8.5 | Agreement, reason, date, office notice date, sets completed/unplayed, ratings at play time | Pending/resume/confirm flow exists; deadline and office-notice capture remain open or paper/manual by decision. |
| Eligibility / 5.7 | Official code, player number, report week/date, membership application status, team history, calculated-score evidence, special forfeit credit | Official import parser/storage/attachment exists; missing/unmatched warning and live population/freshness verification remain. |
| Multi-team / 4.5, 5.8 | Active team/event memberships, division/season, event/time slot, set order, delayed set, TD ruling | Membership model exists; tournament conflict enforcement remains. |
| Certification / 5.9 | Certification returned/signed/date, baseline ratings, later ratings, team total, investigation, appeal | No complete workflow identified. |
| Standings/MVP / 5.1–5.6 | Official positions, team points, sets, opponent totals, MVP points/wins/losses, tie-break evidence | Official positions and audit helpers exist; finish data completeness/edge-case audit. |
| Regional / 5.11–5.12 | Seasonal rosters, common players, match counts, ranking points, points/set average, singles score/match/season thresholds, flight rating | No complete ledger/workflow identified; user decision required. |
| Roster / 8.1 | Effective week/date, add/drop, reason, roster size, survival eligibility, manager exception, postseason freeze | Week 6 cutoff foundation exists; remaining restrictions/exception open. |
| Scheduling / 8.2, 8.4–8.6 | Table choice, one/two-table request time, schedule version, BYE cycle, makeup date, notice, weather declaration, holiday notice | Schedule infrastructure exists; clause audit and workflow gaps remain. |
| Dropped/replacement teams / 8.7–8.8 | Manager adjustment decision, affected match history/points, replacement team, inherited points, makeup entitlement | User decision needed; do not assume a calculation. |
| Conduct / 1.22, 2, 3, 5.10, 5.13–5.14 | Warning, player/team, incident, time, referee/TD, penalty, evidence, appeal | No complete workflow identified; decide app vs League Office/manual. |
| Finance / 9.1–9.9 | Membership dues, renewal exception, sanction fees, team deposit, weekly fees, unpaid roster members, returned checks, prize holds | No app scope assumed; user decision needed. |
| Paper scorekeeping / 6.11 | Table size, League Office message, both captain signatures, independent team scoresheet | Retained on paper by user decision; digital confirmation is not a signature. |

## 7. Specific verification cautions

- **Section 6.6 source table:** the available extracted text of the supplied rulebook has a blank after the Section 6.6 heading, likely because the values are in a table/image. The current code/tests contain values listed above. Do not mark 6.6 fully verified until the original page/table is checked.
- **Section 6.7 winner inference:** PR #129's stated intent is automatic last-game winner. Current helper code compares recorded per-game point totals and has a `tiebreak` fallback for equal totals. Verify valid game scoring always differentiates the winner; if not, use the correct existing game-result data to determine it without asking the scorekeeper.
- **Section 5.7 live data:** the eligibility parser and table exist, but a previous read-only check found no rows. Recheck imports before testing eligibility UI.
- **Section 6.11 identifiers:** PR #132 is merged. Player and team numbers are now carried into the completed Scoresheet path. Do not add identifier controls to live scoring. Verify the merged behavior in the Phase 1 acceptance pass.
- **Section 6.4–6.6 forfeits:** PR #135 is merged. The implementation covers the agreed full-match and individual trailing-forfeit lifecycle, makeup deadline handling, Section 6.6 scoring, and solo-scorer makeup confirmation. The 15/30/45-minute team-forfeit clock and emergency allowance remain intentionally manual; do not add automatic timers unless the user later chooses that behavior.
- **Single-scorer workflow:** When one team is marked unavailable/not participating in-app, workflows that normally require both sides to confirm must use the existing solo-scoring pattern: the available scorer explicitly reviews and acknowledges the result rather than waiting indefinitely for an unavailable captain. This applies to makeup confirmation and should be preserved for future similar workflows.
- **Section 2.7:** Open/Advanced timeout chips are data markers only; Masters has no chips. This is partial support, not enforcement.
- **Section 8.1:** Section 76's Week 6 cutoff is a foundation, not proof of full Section 8.1 compliance.
- **Section 5.5:** tie-break audit tools are not the authoritative standings/MVP result; imported IBA positions are.
- **CI:** a passing CI run verifies the tested commit, not interactive production behavior, SQL application, imported row population, or paper responsibilities.

## 8. CI, SQL, and closure checklist

For every implementation PR:
- [ ] PR is focused on the current phase and references the exact rule clauses.
- [ ] Acceptance criteria cover each rulebook requirement and relevant formats/roles/edge cases.
- [ ] Automated tests cover normal, boundary, missing-data, and regression scenarios.
- [ ] Latest PR-head required CI checks pass: tests, production build, Supabase SQL-access guard.
- [ ] Any SQL file is included in the PR; new public tables include RLS and least-privilege grants.
- [ ] User applies SQL manually and confirms; verify expected live schema/data read-only when appropriate.
- [ ] User reviews and merges; do not merge on the user's behalf.
- [ ] Merge commit CI is checked.
- [ ] Live workflow/role verification is performed where possible; limitations are stated.
- [ ] This master plan is updated with PR, SQL, test, data, and verification evidence.

## 9. Cross-chat continuation prompt

> Continue the IBA Pool League App rulebook audit and implementation using `docs/rulebook-audit/MASTER-PLAN.md` from current `main` as the single source of truth. This is an ongoing, complete rulebook-to-app effort; do not assume a particular phase or restart the audit from the beginning.
>
> **First reconcile the actual current state:** read the master plan from current `main`; inspect the latest main SHA, merged/open PRs and branches, relevant CI/build status, current app code/tests, the exact rulebook text for the next task, and the active Supabase project/data/schema/policies/functions when relevant. Do not rely on stale conversation summaries when current repository evidence is available.
>
> **Core operating process:** audit → discuss/alignment → build → test → review/merge → verify → update master plan → continue.
>
> 1. Identify the earliest unfinished item in the master plan's priority queue.
> 2. Audit that rulebook requirement against the current code, data model, imports, UI/workflow, tests, and manual responsibilities. Identify the exact gap(s), including edge cases and affected formats/roles.
> 3. **Before implementing anything that changes product behavior, stop at the review/alignment gate.** Explain:
>    - what the rulebook requires;
>    - what the app currently does;
>    - what is actually missing;
>    - what should remain manual/import-only/audit-only;
>    - the proposed implementation, including data, UI, workflow, validation, edge cases, and acceptance criteria.
>    Discuss this with me and incorporate my decisions. Do not create production code or an implementation PR until we are aligned on the proposed behavior.
> 4. Once aligned, implement the agreed solution in a focused PR. Do not create unnecessary branches, clone the repo, or bundle unrelated work.
> 5. Include tests as part of the implementation. Do not claim tests, builds, SQL application, live data, or production behavior passed unless actually verified.
> 6. If SQL is required, include the migration in the focused PR. New public Supabase tables must include explicit RLS and least-privilege Data API grants in the same migration. I will apply SQL manually; never claim it is applied until I confirm or a live read-only verification proves it.
> 7. Do not merge PRs on my behalf. After I merge, verify the merged main state and relevant CI, then update the master plan with the actual evidence.
> 8. Continue automatically to the next unfinished task after verification. Do not stop at phase boundaries or ask me whether to proceed when the next task is already defined by the master plan.
> 9. Preserve all settled decisions in the master plan. Do not reopen them unless new rulebook evidence, code evidence, or a genuine contradiction requires discussion.
> 10. If the correct disposition is **Manual process — agreed**, **Import-only**, or **Audit/reconciliation only**, do not build unnecessary app functionality merely to make the clause look implemented. Document the responsible person/process and acceptance evidence.
> 11. If a genuine unresolved business decision is required, present the rulebook requirement and concrete options, explain the consequences, and wait for my decision before implementation.
>
> **Completion goal:** Continue this process until the entire rulebook Sections 1–9 has been audited and every clause has a final disposition of Verified, Import-only, or Manual process — agreed (or a clearly documented exception/decision), with required implementation/data persistence/import behavior/manual responsibilities, SQL, tests, and verification completed. Do not declare the audit complete merely because the PR queue is empty.
