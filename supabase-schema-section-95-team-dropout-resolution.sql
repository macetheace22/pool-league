-- Section 95 / Rule 8.7: manager-controlled team dropout resolution framework.
-- This records management's chosen remedy without rewriting completed match history.
-- Standings treatment is layered on top of the preserved source records in the
-- follow-on standings integration work.

BEGIN;

CREATE TABLE IF NOT EXISTS public.team_dropout_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES public.seasons(id) ON DELETE RESTRICT,
  division_id uuid NOT NULL REFERENCES public.divisions(id) ON DELETE RESTRICT,
  dropout_team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  effective_date date NOT NULL,
  remedies jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_match_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_schedule_week_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text,
  resolved_by uuid NOT NULL REFERENCES auth.users(id),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'applied',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_dropout_resolutions_status_chk CHECK (status IN ('applied','voided')),
  CONSTRAINT team_dropout_resolutions_remedies_array_chk CHECK (jsonb_typeof(remedies) = 'array'),
  CONSTRAINT team_dropout_resolutions_matches_array_chk CHECK (jsonb_typeof(affected_match_ids) = 'array'),
  CONSTRAINT team_dropout_resolutions_weeks_array_chk CHECK (jsonb_typeof(affected_schedule_week_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_team_dropout_resolutions_division
  ON public.team_dropout_resolutions(division_id, resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_dropout_resolutions_team
  ON public.team_dropout_resolutions(dropout_team_id, resolved_at DESC);

ALTER TABLE public.team_dropout_resolutions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.team_dropout_resolutions FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.team_dropout_resolutions TO authenticated;

DROP POLICY IF EXISTS team_dropout_resolutions_manager_select
  ON public.team_dropout_resolutions;
CREATE POLICY team_dropout_resolutions_manager_select
  ON public.team_dropout_resolutions
  FOR SELECT TO authenticated
  USING (public.current_role_name() = 'manager');

DROP POLICY IF EXISTS team_dropout_resolutions_manager_insert
  ON public.team_dropout_resolutions;
CREATE POLICY team_dropout_resolutions_manager_insert
  ON public.team_dropout_resolutions
  FOR INSERT TO authenticated
  WITH CHECK (public.current_role_name() = 'manager' AND resolved_by = auth.uid());

CREATE OR REPLACE FUNCTION public.preview_team_dropout_resolution(
  p_season_id uuid,
  p_division_id uuid,
  p_dropout_team_id uuid,
  p_effective_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_match_ids jsonb;
  v_week_ids jsonb;
  v_match_count integer;
  v_future_week_count integer;
  v_team_name text;
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
    SELECT 1 FROM public.divisions
    WHERE id = p_division_id AND season_id = p_season_id
  ) THEN
    RAISE EXCEPTION 'DIVISION_SEASON_MISMATCH';
  END IF;

  SELECT name INTO v_team_name
  FROM public.teams
  WHERE id = p_dropout_team_id AND division_id = p_division_id AND coalesce(is_bye,false) = false;

  IF v_team_name IS NULL THEN
    RAISE EXCEPTION 'DROPOUT_TEAM_NOT_FOUND';
  END IF;

  SELECT coalesce(jsonb_agg(m.id ORDER BY m.id), '[]'::jsonb), count(*)
    INTO v_match_ids, v_match_count
  FROM public.completed_matches m
  WHERE m.division_id = p_division_id
    AND (m.team_home_id = p_dropout_team_id OR m.team_away_id = p_dropout_team_id);

  SELECT coalesce(jsonb_agg(sw.id ORDER BY sw.date, sw.week), '[]'::jsonb), count(*)
    INTO v_week_ids, v_future_week_count
  FROM public.schedule_weeks sw
  JOIN public.schedule_pairings sp ON sp.week_id = sw.id
  WHERE sw.division_id = p_division_id
    AND coalesce(sw.is_playoff,false) = false
    AND to_date(sw.date, 'MM/DD/YYYY') >= p_effective_date
    AND (sp.home_team_id = p_dropout_team_id OR sp.away_team_id = p_dropout_team_id);

  RETURN jsonb_build_object(
    'teamId', p_dropout_team_id,
    'teamName', v_team_name,
    'effectiveDate', p_effective_date,
    'completedMatchCount', v_match_count,
    'futureScheduleWeekCount', v_future_week_count,
    'affectedMatchIds', v_match_ids,
    'affectedScheduleWeekIds', v_week_ids
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_team_dropout_resolution(uuid,uuid,uuid,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_team_dropout_resolution(uuid,uuid,uuid,date)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.record_team_dropout_resolution(
  p_season_id uuid,
  p_division_id uuid,
  p_dropout_team_id uuid,
  p_effective_date date,
  p_remedies jsonb,
  p_affected_match_ids jsonb,
  p_affected_schedule_week_ids jsonb,
  p_preview jsonb,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
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
    SELECT 1 FROM public.divisions
    WHERE id = p_division_id AND season_id = p_season_id
  ) THEN
    RAISE EXCEPTION 'DIVISION_SEASON_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.teams
    WHERE id = p_dropout_team_id
      AND division_id = p_division_id
      AND coalesce(is_bye,false) = false
  ) THEN
    RAISE EXCEPTION 'DROPOUT_TEAM_NOT_FOUND';
  END IF;

  IF jsonb_typeof(p_remedies) <> 'array' OR jsonb_array_length(p_remedies) = 0 THEN
    RAISE EXCEPTION 'REMEDY_REQUIRED';
  END IF;

  IF jsonb_typeof(p_affected_match_ids) <> 'array'
     OR jsonb_typeof(p_affected_schedule_week_ids) <> 'array' THEN
    RAISE EXCEPTION 'AFFECTED_IDS_MUST_BE_ARRAYS';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.team_dropout_resolutions
    WHERE division_id = p_division_id
      AND dropout_team_id = p_dropout_team_id
      AND status = 'applied'
  ) THEN
    RAISE EXCEPTION 'DROPOUT_ALREADY_RESOLVED';
  END IF;

  INSERT INTO public.team_dropout_resolutions (
    season_id, division_id, dropout_team_id, effective_date,
    remedies, affected_match_ids, affected_schedule_week_ids,
    preview, note, resolved_by
  )
  VALUES (
    p_season_id, p_division_id, p_dropout_team_id, p_effective_date,
    p_remedies, p_affected_match_ids, p_affected_schedule_week_ids,
    coalesce(p_preview,'{}'::jsonb), nullif(trim(coalesce(p_note,'')), ''),
    auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'resolutionId', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_team_dropout_resolution(uuid,uuid,uuid,date,jsonb,jsonb,jsonb,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_team_dropout_resolution(uuid,uuid,uuid,date,jsonb,jsonb,jsonb,jsonb,text)
  TO authenticated;

COMMIT;
