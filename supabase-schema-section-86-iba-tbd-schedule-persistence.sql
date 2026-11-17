-- Section 8.4: preserve unresolved IBA TBD schedule participants without
-- creating fake rows in the real teams table.
--
-- Existing schedule rows remain unchanged: both team UUID columns are populated
-- for every current pairing. TBD imports may now store one side as a nullable
-- team UUID plus a stable external IBA TBD code.

alter table public.schedule_pairings
  alter column home_team_id drop not null,
  alter column away_team_id drop not null;

alter table public.schedule_pairings
  add column if not exists home_tbd_code text,
  add column if not exists away_tbd_code text;

alter table public.schedule_pairings
  drop constraint if exists schedule_pairings_home_participant_check,
  drop constraint if exists schedule_pairings_away_participant_check;

alter table public.schedule_pairings
  add constraint schedule_pairings_home_participant_check
  check ((home_team_id is not null) <> (home_tbd_code is not null)),
  add constraint schedule_pairings_away_participant_check
  check ((away_team_id is not null) <> (away_tbd_code is not null));
