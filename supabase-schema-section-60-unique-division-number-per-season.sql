-- Section 60: prevent duplicate IBA divisions within a season.
-- IBA division numbers identify divisions within a season; format/day are
-- editable attributes and must not permit a second row for the same number.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.divisions
    GROUP BY season_id, num
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add the division uniqueness index: duplicate (season_id, num) rows exist. Resolve those duplicates first.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS divisions_season_id_num_unique_idx
  ON public.divisions (season_id, num);
