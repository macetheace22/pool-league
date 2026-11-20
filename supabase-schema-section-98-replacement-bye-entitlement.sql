-- Section 98 / Rule 8.8: calculate replacement-team makeup entitlement
-- from the weekly IBA schedule import history captured by Section 97.

BEGIN;

CREATE OR REPLACE FUNCTION public.preview_team_replacement_resolution(
  p_season_id uuid,
  p_division_id uuid,
  p_dropout_resolution_id uuid,
  p_replacement_team_id uuid,
  p_effective_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dropout_team_id uuid;
  v_week_ids jsonb := '[]'::jsonb;
  v_week_count integer := 0;
  v_dropout_name text;
  v_replacement_name text;
  v_bye_team_id uuid;
BEGIN
  IF auth.uid() IS NULL OR public.current_role_name() <> 'manager' THEN
    RAISE EXCEPTION 'MANAGER_ONLY';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.seasons
    WHERE id = p_season_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'ACTIVE_SEASON_REQUIRED';
  END IF;

  SELECT dropout_team_id
    INTO v_dropout_team_id
  FROM public.team_dropout_resolutions
  WHERE id = p_dropout_resolution_id
    AND season_id = p_season_id
    AND division_id = p_division_id
    AND status = 'applied';

  IF v_dropout_team_id IS NULL THEN
    RAISE EXCEPTION 'DROPOUT_RESOLUTION_NOT_FOUND';
  END IF;

  SELECT name INTO v_dropout_name
  FROM public.teams
  WHERE id = v_dropout_team_id
    AND division_id = p_division_id
    AND coalesce(is_bye,false) = false;

  SELECT name INTO v_replacement_name
  FROM public.teams
  WHERE id = p_replacement_team_id
    AND division_id = p_division_id
    AND coalesce(is_bye,false) = false
    AND id <> v_dropout_team_id;

  IF v_replacement_name IS NULL THEN
    RAISE EXCEPTION 'REPLACEMENT_TEAM_NOT_FOUND';
  END IF;

  SELECT id INTO v_bye_team_id
  FROM public.teams
  WHERE division_id = p_division_id
    AND coalesce(is_bye,false) = true
  ORDER BY id
  LIMIT 1;

  WITH import_pairs AS (
    SELECT
      after_snap.id AS after_id,
      before_snap.schedule_state AS before_state,
      after_snap.schedule_state AS after_state
    FROM public.iba_schedule_import_snapshots after_snap
    JOIN public.iba_schedule_import_snapshots before_snap
      ON before_snap.import_id = after_snap.import_id
     AND before_snap.phase = 'before'
    WHERE after_snap.phase = 'after'
      AND after_snap.season_id = p_season_id
      AND after_snap.division_id = p_division_id
      AND after_snap.created_at >= p_effective_date::timestamptz
  ),
  before_pairings AS (
    SELECT
      ip.after_id,
      (bw->>'week')::integer AS week,
      bw->>'date' AS date_text,
      bp AS pairing
    FROM import_pairs ip
    CROSS JOIN LATERAL jsonb_array_elements(ip.before_state->'weeks') bw
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(bw->'pairings','[]'::jsonb)) bp
    WHERE coalesce((bw->>'isPlayoff')::boolean, false) = false
      AND (
        bp->>'homeTeamId' = v_dropout_team_id::text
        OR bp->>'awayTeamId' = v_dropout_team_id::text
      )
  ),
  after_pairings AS (
    SELECT
      ip.after_id,
      (aw->>'week')::integer AS week,
      ap AS pairing
    FROM import_pairs ip
    CROSS JOIN LATERAL jsonb_array_elements(ip.after_state->'weeks') aw
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(aw->'pairings','[]'::jsonb)) ap
    WHERE coalesce((aw->>'isPlayoff')::boolean, false) = false
  ),
  created_byes AS (
    SELECT DISTINCT bp.week
    FROM before_pairings bp
    JOIN after_pairings ap
      ON ap.after_id = bp.after_id
     AND ap.week = bp.week
    WHERE
      (
        (
          bp.pairing->>'homeTeamId' = v_dropout_team_id::text
          AND ap.pairing->>'awayTeamId' = v_bye_team_id::text
          AND ap.pairing->>'homeTeamId' = bp.pairing->>'awayTeamId'
        )
        OR
        (
          bp.pairing->>'awayTeamId' = v_dropout_team_id::text
          AND ap.pairing->>'homeTeamId' = v_bye_team_id::text
          AND ap.pairing->>'awayTeamId' = bp.pairing->>'homeTeamId'
        )
        OR
        (
          bp.pairing->>'homeTeamId' = v_dropout_team_id::text
          AND ap.pairing->>'homeTbdCode' = 'BYE'
          AND ap.pairing->>'awayTeamId' = bp.pairing->>'awayTeamId'
        )
        OR
        (
          bp.pairing->>'awayTeamId' = v_dropout_team_id::text
          AND ap.pairing->>'awayTbdCode' = 'BYE'
          AND ap.pairing->>'homeTeamId' = bp.pairing->>'homeTeamId'
        )
      )
  )
  SELECT
    coalesce(jsonb_agg(sw.id ORDER BY sw.date, sw.week), '[]'::jsonb),
    count(*)
  INTO v_week_ids, v_week_count
  FROM created_byes cb
  JOIN public.schedule_weeks sw
    ON sw.division_id = p_division_id
   AND sw.week = cb.week
   AND to_date(sw.date, 'MM/DD/YYYY') >= p_effective_date
   AND coalesce(sw.is_playoff,false) = false;

  RETURN jsonb_build_object(
    'dropoutTeamId', v_dropout_team_id,
    'dropoutTeamName', v_dropout_name,
    'replacementTeamId', p_replacement_team_id,
    'replacementTeamName', v_replacement_name,
    'effectiveDate', p_effective_date,
    'eligibleMakeupWeekCount', least(v_week_count, 3),
    'eligibleMakeupWeekIds', coalesce(
      (SELECT jsonb_agg(value)
       FROM jsonb_array_elements(v_week_ids) WITH ORDINALITY AS x(value, ord)
       WHERE ord <= 3),
      '[]'::jsonb
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_team_replacement_resolution(uuid,uuid,uuid,uuid,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_team_replacement_resolution(uuid,uuid,uuid,uuid,date)
  TO authenticated;

COMMIT;
