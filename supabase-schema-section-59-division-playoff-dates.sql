-- Section 59: playoff start dates belong to divisions, not seasons.
-- Additive migration: keeps the legacy seasons.playoffs_start_date column
-- for compatibility, while current app behavior reads/writes this field.
BEGIN;

ALTER TABLE public.divisions
  ADD COLUMN IF NOT EXISTS playoffs_start_date date;

COMMENT ON COLUMN public.divisions.playoffs_start_date IS
  'First playoff date for this specific division; used to calculate its makeup-match deadline.';

COMMIT;
