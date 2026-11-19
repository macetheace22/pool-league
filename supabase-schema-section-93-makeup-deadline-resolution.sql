-- Section 93 / Rule 8.5: manager-controlled makeup deadline outcomes.
-- The seven-day cutoff is enforced server-side. The application supplies the
-- already-computed match state/score for a manager-approved team-responsible
-- full-match forfeit, using the same existing scoring functions used by live
-- full-match forfeits. The database never infers responsibility or scoring.

BEGIN;

ALTER TABLE public.completed_matches
  ADD COLUMN IF NOT EXISTS makeup_deadline_resolution jsonb;

COMMENT ON COLUMN public.completed_matches.makeup_deadline_resolution IS
  'League Management decision for Rule 8.5 makeup deadline. Values record outcome, responsible side when applicable, actor, timestamp, and final regular-season date used for the cutoff.';

CREATE OR REPLACE FUNCTION public.resolve_makeup_deadline(
  p_match_id uuid,
  p_outcome text,
  p_responsible_side text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_state jsonb DEFAULT NULL,
  p_home_total integer DEFAULT NULL,
  p_away_total integer DEFAULT NULL,
  p_home_points integer DEFAULT NULL,
  p_away_points integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match public.completed_matches%ROWTYPE;
  v_last_regular_date date;
  v_cutoff date;
  v_resolution jsonb;
  v_state jsonb;
  v_home_total integer;
  v_away_total integer;
  v_home_points integer;
  v_away_points integer;
BEGIN
  IF auth.uid() IS NULL OR public.current_role_name() <> 'manager' THEN
    RAISE EXCEPTION 'MANAGER_ONLY';
  END IF;

  IF p_outcome NOT IN ('no_agreement', 'team_responsible') THEN
    RAISE EXCEPTION 'INVALID_OUTCOME';
  END IF;

  IF p_outcome = 'team_responsible' AND p_responsible_side NOT IN ('home', 'away') THEN
    RAISE EXCEPTION 'RESPONSIBLE_SIDE_REQUIRED';
  END IF;

  SELECT * INTO v_match
  FROM public.completed_matches
  WHERE id = p_match_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;

  IF NOT v_match.is_makeup_pending THEN
    RAISE EXCEPTION 'MAKEUP_NOT_PENDING';
  END IF;

  SELECT max(to_date(sw.date, 'MM/DD/YYYY'))
    INTO v_last_regular_date
  FROM public.schedule_weeks sw
  WHERE sw.division_id = v_match.division_id
    AND coalesce(sw.is_playoff, false) = false
    AND sw.date IS NOT NULL
    AND sw.date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$';

  IF v_last_regular_date IS NULL THEN
    RAISE EXCEPTION 'FINAL_REGULAR_SEASON_DATE_UNAVAILABLE';
  END IF;

  v_cutoff := v_last_regular_date - 7;

  IF (now() AT TIME ZONE 'America/Chicago')::date < v_cutoff THEN
    RAISE EXCEPTION 'MAKEUP_DEADLINE_NOT_REACHED';
  END IF;

  IF p_outcome = 'no_agreement' THEN
    v_state := coalesce(v_match.state, '{}'::jsonb);
    v_home_total := coalesce(v_match.team_home_total, 0);
    v_away_total := coalesce(v_match.team_away_total, 0);
    v_home_points := 0;
    v_away_points := 0;
  ELSE
    IF p_state IS NULL
       OR p_home_total IS NULL
       OR p_away_total IS NULL
       OR p_home_points IS NULL
       OR p_away_points IS NULL THEN
      RAISE EXCEPTION 'FORFEIT_RESULT_REQUIRED';
    END IF;

    IF p_state->'fullMatchForfeit'->>'forfeitingSide' <> p_responsible_side THEN
      RAISE EXCEPTION 'FORFEIT_STATE_MISMATCH';
    END IF;

    IF jsonb_array_length(coalesce(p_state->'sets', '[]'::jsonb)) <> 5 THEN
      RAISE EXCEPTION 'FULL_MATCH_FORFEIT_REQUIRES_FIVE_SETS';
    END IF;

    v_state := p_state;
    v_home_total := p_home_total;
    v_away_total := p_away_total;
    v_home_points := p_home_points;
    v_away_points := p_away_points;
  END IF;

  v_resolution := jsonb_build_object(
    'outcome', p_outcome,
    'responsibleSide', CASE WHEN p_outcome = 'team_responsible' THEN p_responsible_side ELSE NULL END,
    'note', nullif(trim(coalesce(p_note, '')), ''),
    'resolvedAt', now(),
    'resolvedBy', auth.uid(),
    'finalRegularSeasonDate', v_last_regular_date,
    'cutoffDate', v_cutoff
  );

  v_state := jsonb_set(
    v_state,
    '{makeupDeadlineResolution}',
    v_resolution,
    true
  );

  UPDATE public.completed_matches
  SET state = v_state,
      team_home_total = v_home_total,
      team_away_total = v_away_total,
      team_home_points = v_home_points,
      team_away_points = v_away_points,
      is_makeup_pending = false,
      makeup_deadline_resolution = v_resolution,
      correction_history = coalesce(correction_history, '[]'::jsonb) || jsonb_build_array(v_resolution)
  WHERE id = p_match_id;

  RETURN jsonb_build_object(
    'ok', true,
    'matchId', p_match_id,
    'outcome', p_outcome,
    'responsibleSide', CASE WHEN p_outcome = 'team_responsible' THEN p_responsible_side ELSE NULL END,
    'finalRegularSeasonDate', v_last_regular_date,
    'cutoffDate', v_cutoff,
    'homePoints', v_home_points,
    'awayPoints', v_away_points,
    'homeTotal', v_home_total,
    'awayTotal', v_away_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_makeup_deadline(uuid, text, text, text, jsonb, integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_makeup_deadline(uuid, text, text, text, jsonb, integer, integer, integer, integer)
  TO authenticated;

COMMIT;
