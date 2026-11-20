-- Section 99 / Rule 8.8: apply an approved replacement team to the
-- remaining scheduled matchups without changing historical matches or BYE weeks.

BEGIN;

CREATE TABLE IF NOT EXISTS public.team_replacement_schedule_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replacement_resolution_id uuid NOT NULL UNIQUE
    REFERENCES public.team_replacement_resolutions(id) ON DELETE RESTRICT,
  season_id uuid NOT NULL REFERENCES public.seasons(id) ON DELETE RESTRICT,
  division_id uuid NOT NULL REFERENCES public.divisions(id) ON DELETE RESTRICT,
  replacement_team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  applied_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL DEFAULT now(),
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  changed_week_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'applied',
  CONSTRAINT team_replacement_schedule_applications_status_chk
    CHECK (status IN ('applied','voided')),
  CONSTRAINT team_replacement_schedule_applications_before_object_chk
    CHECK (jsonb_typeof(before_snapshot) = 'object'),
  CONSTRAINT team_replacement_schedule_applications_after_object_chk
    CHECK (jsonb_typeof(after_snapshot) = 'object'),
  CONSTRAINT team_replacement_schedule_applications_weeks_array_chk
    CHECK (jsonb_typeof(changed_week_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_team_replacement_schedule_applications_division
  ON public.team_replacement_schedule_applications(division_id, applied_at DESC);

ALTER TABLE public.team_replacement_schedule_applications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.team_replacement_schedule_applications FROM anon, authenticated;
GRANT SELECT, INSERT ON public.team_replacement_schedule_applications TO authenticated;

DROP POLICY IF EXISTS team_replacement_schedule_applications_manager_select
  ON public.team_replacement_schedule_applications;
CREATE POLICY team_replacement_schedule_applications_manager_select
  ON public.team_replacement_schedule_applications
  FOR SELECT TO authenticated
  USING (public.current_role_name() = 'manager');

DROP POLICY IF EXISTS team_replacement_schedule_applications_manager_insert
  ON public.team_replacement_schedule_applications;
CREATE POLICY team_replacement_schedule_applications_manager_insert
  ON public.team_replacement_schedule_applications
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_role_name() = 'manager'
    AND applied_by = auth.uid()
  );

CREATE OR REPLACE FUNCTION public.apply_team_replacement_schedule(
  p_replacement_resolution_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_resolution public.team_replacement_resolutions%rowtype;
  v_existing boolean;
  v_before jsonb;
  v_after jsonb;
  v_changed jsonb := '[]'::jsonb;
  v_week public.schedule_weeks%rowtype;
  v_pairing public.schedule_pairings%rowtype;
  v_bye_team_id uuid;
  v_replacement_id uuid;
  v_opponent_id uuid;
  v_changed_count integer := 0;
BEGIN
  IF auth.uid() IS NULL OR public.current_role_name() <> 'manager' THEN
    RAISE EXCEPTION 'MANAGER_ONLY';
  END IF;

  SELECT *
    INTO v_resolution
  FROM public.team_replacement_resolutions
  WHERE id = p_replacement_resolution_id
    AND status = 'applied'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REPLACEMENT_RESOLUTION_NOT_FOUND';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.seasons
    WHERE id = v_resolution.season_id AND is_active = true
  ) THEN
    RAISE EXCEPTION 'ACTIVE_SEASON_REQUIRED';
  END IF;

  SELECT exists (
    SELECT 1
    FROM public.team_replacement_schedule_applications
    WHERE replacement_resolution_id = p_replacement_resolution_id
      AND status = 'applied'
  )
  INTO v_existing;

  IF v_existing THEN
    SELECT id INTO v_replacement_id
    FROM public.team_replacement_schedule_applications
    WHERE replacement_resolution_id = p_replacement_resolution_id
      AND status = 'applied'
    LIMIT 1;

    RETURN jsonb_build_object(
      'ok', true,
      'status', 'already_applied',
      'applicationId', v_replacement_id
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.teams
    WHERE id = v_resolution.replacement_team_id
      AND division_id = v_resolution.division_id
      AND coalesce(is_bye,false) = false
  ) THEN
    RAISE EXCEPTION 'REPLACEMENT_TEAM_NOT_FOUND';
  END IF;

  SELECT id INTO v_bye_team_id
  FROM public.teams
  WHERE division_id = v_resolution.division_id
    AND coalesce(is_bye,false) = true
  ORDER BY id
  LIMIT 1;

  SELECT jsonb_build_object(
    'weeks',
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'week', sw.week_num,
          'date', sw.date,
          'special', coalesce(sw.special, ''),
          'isPlayoff', coalesce(sw.is_playoff,false),
          'pairings',
          coalesce((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', sp.id,
                'homeTeamId', sp.home_team_id,
                'awayTeamId', sp.away_team_id,
                'homeTbdCode', sp.home_tbd_code,
                'awayTbdCode', sp.away_tbd_code
              )
              ORDER BY sp.id
            )
            FROM public.schedule_pairings sp
            WHERE sp.week_id = sw.id
          ), '[]'::jsonb)
        )
        ORDER BY sw.week_num, sw.date
      )
      FROM public.schedule_weeks sw
      WHERE sw.division_id = v_resolution.division_id
    ), '[]'::jsonb)
  )
  INTO v_before;

  FOR v_week IN
    SELECT *
    FROM public.schedule_weeks
    WHERE division_id = v_resolution.division_id
      AND coalesce(is_playoff,false) = false
      AND to_date(date, 'MM/DD/YYYY') >= v_resolution.effective_date
    ORDER BY week_num, date
    FOR UPDATE
  LOOP
    FOR v_pairing IN
      SELECT sp.*
      FROM public.schedule_pairings sp
      WHERE sp.week_id = v_week.id
        AND (
          sp.home_team_id = v_resolution.dropout_team_id
          OR sp.away_team_id = v_resolution.dropout_team_id
        )
      FOR UPDATE
    LOOP
      IF v_pairing.home_team_id = v_resolution.dropout_team_id
         AND v_pairing.away_team_id IS NOT NULL
         AND v_pairing.away_team_id <> v_bye_team_id THEN
        v_opponent_id := v_pairing.away_team_id;
        UPDATE public.schedule_pairings
        SET home_team_id = v_resolution.replacement_team_id
        WHERE id = v_pairing.id;
        v_changed := v_changed || jsonb_build_array(v_week.id);
        v_changed_count := v_changed_count + 1;
      ELSIF v_pairing.away_team_id = v_resolution.dropout_team_id
         AND v_pairing.home_team_id IS NOT NULL
         AND v_pairing.home_team_id <> v_bye_team_id THEN
        v_opponent_id := v_pairing.home_team_id;
        UPDATE public.schedule_pairings
        SET away_team_id = v_resolution.replacement_team_id
        WHERE id = v_pairing.id;
        v_changed := v_changed || jsonb_build_array(v_week.id);
        v_changed_count := v_changed_count + 1;
      END IF;
    END LOOP;
  END LOOP;

  SELECT jsonb_build_object(
    'weeks',
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'week', sw.week_num,
          'date', sw.date,
          'special', coalesce(sw.special, ''),
          'isPlayoff', coalesce(sw.is_playoff,false),
          'pairings',
          coalesce((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', sp.id,
                'homeTeamId', sp.home_team_id,
                'awayTeamId', sp.away_team_id,
                'homeTbdCode', sp.home_tbd_code,
                'awayTbdCode', sp.away_tbd_code
              )
              ORDER BY sp.id
            )
            FROM public.schedule_pairings sp
            WHERE sp.week_id = sw.id
          ), '[]'::jsonb)
        )
        ORDER BY sw.week_num, sw.date
      )
      FROM public.schedule_weeks sw
      WHERE sw.division_id = v_resolution.division_id
    ), '[]'::jsonb)
  )
  INTO v_after;

  INSERT INTO public.team_replacement_schedule_applications (
    replacement_resolution_id,
    season_id,
    division_id,
    replacement_team_id,
    applied_by,
    before_snapshot,
    after_snapshot,
    changed_week_ids
  )
  VALUES (
    v_resolution.id,
    v_resolution.season_id,
    v_resolution.division_id,
    v_resolution.replacement_team_id,
    auth.uid(),
    v_before,
    v_after,
    (
      SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
      FROM jsonb_array_elements(v_changed) AS x(value)
    )
  )
  RETURNING id INTO v_replacement_id;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'applied',
    'applicationId', v_replacement_id,
    'changedWeekCount', (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements(v_changed) AS x(value)
    ),
    'changedMatchupCount', v_changed_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_team_replacement_schedule(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_team_replacement_schedule(uuid)
  TO authenticated;

COMMIT;
