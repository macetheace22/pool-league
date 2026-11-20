-- Section 96 / Rule 8.8: manager-controlled replacement team resolution.
-- Records the replacement team, inherited dropout standings snapshot, and the
-- three-makeup entitlement without rewriting the dropout team's history.

BEGIN;

CREATE TABLE IF NOT EXISTS public.team_replacement_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dropout_resolution_id uuid NOT NULL UNIQUE
    REFERENCES public.team_dropout_resolutions(id) ON DELETE RESTRICT,
  season_id uuid NOT NULL REFERENCES public.seasons(id) ON DELETE RESTRICT,
  division_id uuid NOT NULL REFERENCES public.divisions(id) ON DELETE RESTRICT,
  dropout_team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  replacement_team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  effective_date date NOT NULL,
  inherited_standings jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligible_makeup_week_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  makeup_matches_allowed integer NOT NULL DEFAULT 3,
  makeup_matches_used integer NOT NULL DEFAULT 0,
  note text,
  resolved_by uuid NOT NULL REFERENCES auth.users(id),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'applied',
  CONSTRAINT team_replacement_resolutions_status_chk
    CHECK (status IN ('applied','voided')),
  CONSTRAINT team_replacement_resolutions_standings_object_chk
    CHECK (jsonb_typeof(inherited_standings) = 'object'),
  CONSTRAINT team_replacement_resolutions_weeks_array_chk
    CHECK (jsonb_typeof(eligible_makeup_week_ids) = 'array'),
  CONSTRAINT team_replacement_resolutions_allowed_chk
    CHECK (makeup_matches_allowed BETWEEN 0 AND 3),
  CONSTRAINT team_replacement_resolutions_used_chk
    CHECK (makeup_matches_used BETWEEN 0 AND makeup_matches_allowed),
  CONSTRAINT team_replacement_resolutions_distinct_teams_chk
    CHECK (dropout_team_id <> replacement_team_id)
);

CREATE INDEX IF NOT EXISTS idx_team_replacement_resolutions_division
  ON public.team_replacement_resolutions(division_id, resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_replacement_resolutions_replacement
  ON public.team_replacement_resolutions(replacement_team_id, resolved_at DESC);

ALTER TABLE public.team_replacement_resolutions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.team_replacement_resolutions FROM anon, authenticated;
GRANT SELECT, INSERT ON public.team_replacement_resolutions TO authenticated;

DROP POLICY IF EXISTS team_replacement_resolutions_manager_select
  ON public.team_replacement_resolutions;
CREATE POLICY team_replacement_resolutions_manager_select
  ON public.team_replacement_resolutions
  FOR SELECT TO authenticated
  USING (public.current_role_name() = 'manager');

DROP POLICY IF EXISTS team_replacement_resolutions_manager_insert
  ON public.team_replacement_resolutions;
CREATE POLICY team_replacement_resolutions_manager_insert
  ON public.team_replacement_resolutions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_role_name() = 'manager'
    AND resolved_by = auth.uid()
  );

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
  v_week_ids jsonb;
  v_week_count integer;
  v_dropout_name text;
  v_replacement_name text;
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

  SELECT coalesce(jsonb_agg(sw.id ORDER BY sw.date, sw.week), '[]'::jsonb), count(*)
    INTO v_week_ids, v_week_count
  FROM public.schedule_weeks sw
  JOIN public.schedule_pairings sp ON sp.week_id = sw.id
  WHERE sw.division_id = p_division_id
    AND coalesce(sw.is_playoff,false) = false
    AND to_date(sw.date, 'MM/DD/YYYY') >= p_effective_date
    AND (sp.home_team_id = v_dropout_team_id OR sp.away_team_id = v_dropout_team_id);

  RETURN jsonb_build_object(
    'dropoutTeamId', v_dropout_team_id,
    'dropoutTeamName', v_dropout_name,
    'replacementTeamId', p_replacement_team_id,
    'replacementTeamName', v_replacement_name,
    'effectiveDate', p_effective_date,
    'eligibleMakeupWeekCount', least(v_week_count, 3),
    'eligibleMakeupWeekIds', v_week_ids
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_team_replacement_resolution(uuid,uuid,uuid,uuid,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_team_replacement_resolution(uuid,uuid,uuid,uuid,date)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.record_team_replacement_resolution(
  p_dropout_resolution_id uuid,
  p_season_id uuid,
  p_division_id uuid,
  p_dropout_team_id uuid,
  p_replacement_team_id uuid,
  p_effective_date date,
  p_inherited_standings jsonb,
  p_eligible_makeup_week_ids jsonb,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_allowed integer;
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

  IF NOT EXISTS (
    SELECT 1 FROM public.team_dropout_resolutions
    WHERE id = p_dropout_resolution_id
      AND season_id = p_season_id
      AND division_id = p_division_id
      AND dropout_team_id = p_dropout_team_id
      AND status = 'applied'
  ) THEN
    RAISE EXCEPTION 'DROPOUT_RESOLUTION_NOT_FOUND';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.teams
    WHERE id = p_dropout_team_id
      AND division_id = p_division_id
      AND coalesce(is_bye,false) = false
  ) THEN
    RAISE EXCEPTION 'DROPOUT_TEAM_NOT_FOUND';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.teams
    WHERE id = p_replacement_team_id
      AND division_id = p_division_id
      AND coalesce(is_bye,false) = false
  ) OR p_replacement_team_id = p_dropout_team_id THEN
    RAISE EXCEPTION 'REPLACEMENT_TEAM_NOT_FOUND';
  END IF;

  IF jsonb_typeof(p_inherited_standings) <> 'object'
     OR jsonb_typeof(p_eligible_makeup_week_ids) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_REPLACEMENT_SNAPSHOT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.team_replacement_resolutions
    WHERE dropout_resolution_id = p_dropout_resolution_id
      AND status = 'applied'
  ) THEN
    RAISE EXCEPTION 'REPLACEMENT_ALREADY_RECORDED';
  END IF;

  v_allowed := least(jsonb_array_length(p_eligible_makeup_week_ids), 3);

  INSERT INTO public.team_replacement_resolutions (
    dropout_resolution_id, season_id, division_id,
    dropout_team_id, replacement_team_id, effective_date,
    inherited_standings, eligible_makeup_week_ids,
    makeup_matches_allowed, note, resolved_by
  )
  VALUES (
    p_dropout_resolution_id, p_season_id, p_division_id,
    p_dropout_team_id, p_replacement_team_id, p_effective_date,
    p_inherited_standings, p_eligible_makeup_week_ids,
    v_allowed, nullif(trim(coalesce(p_note,'')), ''), auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'ok', true,
    'replacementResolutionId', v_id,
    'makeupMatchesAllowed', v_allowed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_team_replacement_resolution(uuid,uuid,uuid,uuid,uuid,date,jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_team_replacement_resolution(uuid,uuid,uuid,uuid,uuid,date,jsonb,jsonb,text)
  TO authenticated;

COMMIT;
