-- Section 58: season-wide seasons with format/day attached to divisions.
-- Additive and backward-compatible: preserves existing season, division, team,
-- and schedule IDs. Existing divisions inherit their current season context.
BEGIN;

ALTER TABLE public.divisions
  ADD COLUMN IF NOT EXISTS format text,
  ADD COLUMN IF NOT EXISTS day text;

UPDATE public.divisions d
SET format = COALESCE(d.format, s.format),
    day = COALESCE(d.day, s.day)
FROM public.seasons s
WHERE s.id = d.season_id
  AND (d.format IS NULL OR d.day IS NULL);

ALTER TABLE public.divisions
  DROP CONSTRAINT IF EXISTS divisions_format_check,
  DROP CONSTRAINT IF EXISTS divisions_day_check;

ALTER TABLE public.divisions
  ADD CONSTRAINT divisions_format_check
    CHECK (format = ANY (ARRAY['Masters','Advanced','Open'])),
  ADD CONSTRAINT divisions_day_check
    CHECK (day = ANY (ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']));

ALTER TABLE public.divisions
  ALTER COLUMN format SET NOT NULL,
  ALTER COLUMN day SET NOT NULL;

-- Retain legacy fields during the transition, but permit new season records
-- to omit format/day. Updated code uses division-level context for imports.
ALTER TABLE public.seasons
  ALTER COLUMN format SET DEFAULT 'Masters',
  ALTER COLUMN day SET DEFAULT 'Wednesday';

ALTER TABLE public.seasons
  DROP CONSTRAINT IF EXISTS seasons_type_year_format_day_key,
  DROP CONSTRAINT IF EXISTS seasons_type_check;

ALTER TABLE public.seasons
  ADD CONSTRAINT seasons_type_check
    CHECK (type = ANY (ARRAY['Spring','Summer','Fall','Winter']));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'seasons_type_year_key'
      AND conrelid = 'public.seasons'::regclass
  ) THEN
    ALTER TABLE public.seasons
      ADD CONSTRAINT seasons_type_year_key UNIQUE (type, year);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.set_division_iba_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legacy_format text;
  legacy_day text;
BEGIN
  IF NEW.format IS NULL OR NEW.day IS NULL THEN
    SELECT s.format, s.day
      INTO legacy_format, legacy_day
    FROM public.seasons s
    WHERE s.id = NEW.season_id;

    NEW.format := COALESCE(NEW.format, legacy_format, 'Masters');
    NEW.day := COALESCE(NEW.day, legacy_day, 'Wednesday');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS divisions_set_iba_context ON public.divisions;
CREATE TRIGGER divisions_set_iba_context
BEFORE INSERT OR UPDATE OF season_id, format, day
ON public.divisions
FOR EACH ROW
EXECUTE FUNCTION public.set_division_iba_context();

COMMIT;
