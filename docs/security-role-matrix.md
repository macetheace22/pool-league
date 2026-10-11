# Security role regression matrix

This checklist complements the fast Vitest security-contract tests. The Vitest tests guard important SQL authorization invariants against accidental removal; they do **not** prove PostgreSQL RLS behavior. An executable, rollback-only smoke harness is provided at `tests/security-role-matrix.integration.sql`; it covers membership removal, live scoring, scheduled-team integrity, and match reopening. Run it only in a staging Supabase project with dedicated test accounts and disposable match/team fixtures. The captain/player/non-member cases require those role fixtures to exist before running.

## Test identities and fixtures

Create separate active accounts for:
- **Manager** — role `manager`, with an active membership in Team A.
- **Captain A** — role `captain`, active membership and captain assignment for Team A.
- **Player A** — role `player`, active membership or roster entry on Team A, not a captain.
- **Player B** — role `player`, active membership on Team B only.
- **Non-member** — authenticated player with no membership/roster entry on Team A or Team B.
- **Anonymous** — no authenticated session.

Use a scheduled pairing between Team A and Team B and one completed match whose match date is not today. Reset fixtures after each test.

## Profile → My Teams removal

| Actor | Attempt | Expected result |
|---|---|---|
| Manager | Remove their own active Team A membership | Success; membership row gets `ended_at`; row/history remains |
| Manager | Remove a team they do not actively belong to | `MEMBERSHIP_NOT_FOUND`; no other profile's membership changes |
| Captain A | Call `remove_own_team_membership(Team A)` | `MANAGER_ONLY`; membership unchanged |
| Player A | Call `remove_own_team_membership(Team A)` | `MANAGER_ONLY`; membership unchanged |
| Player B / non-member | Call removal for Team A | `MANAGER_ONLY`; membership unchanged |
| Anonymous | Call removal RPC | `AUTH_REQUIRED` or RPC execute denied; no data changes |

The RPC must never delete a roster row, update a captain assignment, demote a profile, or delete membership history. The UI must show the Remove control only for managers and require confirmation.

## Live scoring authorization

Use the deployed `write_live_match_state(p_pairing_id, p_state, p_expected_revision)` RPC and a real scheduled pairing. Build `p_state` with `teamHome.id` and `teamAway.id` exactly matching the pairing.

| Actor | Attempt | Expected result |
|---|---|---|
| Manager | Create/update the pairing's live state | Allowed |
| Captain A / Player A | Create live state for a pairing involving their team | Allowed when the RPC's membership/roster rules are met |
| Player B / non-member | Create live state for a pairing involving neither of their teams | Returns false; no live row is created |
| Any authenticated actor | Supply home/away team IDs different from the scheduled pairing | Returns false; pairing cannot be changed through the payload |
| Non-manager who does not own either scorer claim | Update an existing live state | Returns false |
| Anonymous | Call write RPC | Returns false or execution denied; no live state changes |

Also test stale `p_expected_revision` against an existing live row: it must return false and leave state/revision unchanged.

## Reopen completed match

Use a completed match with a date that is not today and no confirmation date of today.

| Actor | Attempt | Expected result |
|---|---|---|
| Manager | Reopen the match | Allowed |
| Captain A | Reopen a match involving Team A on a non-match night | Returns `NOT_ALLOWED` |
| Player A / Player B / non-member | Reopen the match | Returns `NOT_ALLOWED` |
| Captain A | Reopen a Team A match on the match night | Allowed only if the captain assignment and date conditions are met |
| Anonymous | Call reopen RPC | Execution denied or no mutation |

## How to record the result

For each attempt, record the actor role, RPC, returned result/error, and before/after database state. Verify unauthorized attempts leave `profile_team_memberships`, `teams.captain_profile_id`, `live_match`, and `completed_matches.reopened_at` unchanged. Do not use production accounts or production matches for negative tests.
