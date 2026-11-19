-- Section 94: league-wide weather emergency makeup declaration.
-- A manager declares an official weather emergency for a scheduled regular-season
-- date. Every real team-vs-team pairing on that date becomes makeup-pending.
-- Already completed matches are intentionally left untouched.

BEGIN;

CREATE TABLE IF NOT EXISTS public.league_weather_emergencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id uuid NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  scheduled_date text NOT NULL,
  note text,
  declared_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  declared_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, scheduled_date)
);

ALTER TABLE public.league_weather_emergencies ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.league_weather_emergencies FROM anon, authenticated;

CREATE POLICY league_weather_emergencies_manager_select
  ON public.league_weather_emergencies
  FOR SELECT TO authenticated
  USING ((select public.current_role_name()) = 'manager');

CREATE POLICY league_weather_emergencies_manager_insert
  ON public.league_weather_emergencies
  FOR INSERT TO authenticated
  WITH CHECK ((select public.current_role_name()) = 'manager' AND (select auth.uid()) = declared_by);

GRANT SELECT, INSERT ON public.league_weather_emergencies TO authenticated;

CREATE OR REPLACE FUNCTION public.declare_weather_emergency(
  p_season_id uuid,
  p_scheduled_date text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_user uuid;
  v_emergency_id uuid;
  v_created integer := 0;
  v_existing integer := 0;
  v_week record;
  v_pair record;
  v_state jsonb;
BEGIN
  v_role := public.current_role_name();
  v_user := (select auth.uid());

  IF v_role IS DISTINCT FROM 'manager' THEN
    RAISE EXCEPTION 'MANAGER_ONLY';
  END IF;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.seasons s
    WHERE s.id = p_season_id
      AND s.is_active = true
  ) THEN
    RAISE EXCEPTION 'ACTIVE_SEASON_REQUIRED';
  END IF;

  IF p_scheduled_date IS NULL OR trim(p_scheduled_date) = '' THEN
    RAISE EXCEPTION 'SCHEDULED_DATE_REQUIRED';
  END IF;

  INSERT INTO public.league_weather_emergencies (
    season_id, scheduled_date, note, declared_by
  )
  VALUES (
    p_season_id, trim(p_scheduled_date), nullif(trim(p_note), ''), v_user
  )
  ON CONFLICT (season_id, scheduled_date) DO NOTHING
  RETURNING id INTO v_emergency_id;

  IF v_emergency_id IS NULL THEN
    SELECT id INTO v_emergency_id
    FROM public.league_weather_emergencies
    WHERE season_id = p_season_id
      AND scheduled_date = trim(p_scheduled_date);
  END IF;

  FOR v_week IN
    SELECT sw.id, sw.division_id, sw.week_num, sw.date, sw.special,
           d.season_id, d.format, d.name AS division_name,
           s.label AS season_label
    FROM public.schedule_weeks sw
    JOIN public.divisions d ON d.id = sw.division_id
    JOIN public.seasons s ON s.id = d.season_id
    WHERE d.season_id = p_season_id
      AND sw.date = trim(p_scheduled_date)
      AND coalesce(sw.is_playoff, false) = false
  LOOP
    FOR v_pair IN
      SELECT sp.id, sp.home_team_id, sp.away_team_id,
             ht.name AS home_name, at.name AS away_name,
             ht.is_bye AS home_bye, at.is_bye AS away_bye
      FROM public.schedule_pairings sp
      LEFT JOIN public.teams ht ON ht.id = sp.home_team_id
      LEFT JOIN public.teams at ON at.id = sp.away_team_id
      WHERE sp.week_id = v_week.id
        AND sp.home_team_id IS NOT NULL
        AND sp.away_team_id IS NOT NULL
        AND coalesce(ht.is_bye, false) = false
        AND coalesce(at.is_bye, false) = false
    LOOP
      IF EXISTS (
        SELECT 1
        FROM public.completed_matches cm
        WHERE cm.division_id = v_week.division_id
          AND cm.week_num = v_week.week_num
          AND cm.week_date = v_week.date
          AND cm.team_home_id = v_pair.home_team_id
          AND cm.team_away_id = v_pair.away_team_id
      ) THEN
        v_existing := v_existing + 1;
        CONTINUE;
      END IF;

      v_state := jsonb_build_object(
        'schedulePairingId', v_pair.id,
        'seasonId', p_season_id,
        'seasonLabel', v_week.season_label,
        'weekNum', v_week.week_num,
        'weekDate', v_week.date,
        'format', v_week.format,
        'teamHome', jsonb_build_object('id', v_pair.home_team_id, 'name', v_pair.home_name, 'roster', jsonb_build_array()),
        'teamAway', jsonb_build_object('id', v_pair.away_team_id, 'name', v_pair.away_name, 'roster', jsonb_build_array()),
        'sets', jsonb_build_array(
          jsonb_build_object('setNum', 1, 'complete', false, 'playerHome', null, 'playerAway', null, 'racks', array_to_json(ARRAY[]::text[])::jsonb),
          jsonb_build_object('setNum', 2, 'complete', false, 'playerHome', null, 'playerAway', null, 'racks', array_to_json(ARRAY[]::text[])::jsonb),
          jsonb_build_object('setNum', 3, 'complete', false, 'playerHome', null, 'playerAway', null, 'racks', array_to_json(ARRAY[]::text[])::jsonb),
          jsonb_build_object('setNum', 4, 'complete', false, 'playerHome', null, 'playerAway', null, 'racks', array_to_json(ARRAY[]::text[])::jsonb),
          jsonb_build_object('setNum', 5, 'complete', false, 'playerHome', null, 'playerAway', null, 'racks', array_to_json(ARRAY[]::text[])::jsonb)
        ),
        'makeup', jsonb_build_object(
          'confirmedHome', true,
          'confirmedAway', true,
          'reason', 'weather_emergency',
          'weatherEmergencyId', v_emergency_id
        ),
        'weatherEmergencyId', v_emergency_id
      );

      INSERT INTO public.completed_matches (
        division_id, season_id, season_label, week_num, week_date,
        venue, format, team_home_id, team_away_id,
        team_home_name, team_away_name,
        team_home_total, team_away_total,
        team_home_points, team_away_points,
        state, source, is_makeup_pending
      )
      VALUES (
        v_week.division_id, p_season_id, v_week.season_label, v_week.week_num, v_week.date,
        NULL, v_week.format, v_pair.home_team_id, v_pair.away_team_id,
        coalesce(v_pair.home_name, ''), coalesce(v_pair.away_name, ''),
        NULL, NULL, NULL, NULL,
        v_state, 'live', true
      );

      v_created := v_created + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'emergency_id', v_emergency_id,
    'scheduled_date', trim(p_scheduled_date),
    'created_makeups', v_created,
    'already_present', v_existing
  );
END;
$$;

REVOKE ALL ON FUNCTION public.declare_weather_emergency(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.declare_weather_emergency(uuid, text, text) TO authenticated;

COMMENT ON TABLE public.league_weather_emergencies IS
  'League-wide manager declarations that make all real regular-season matches on a scheduled date makeup-pending.';

COMMENT ON FUNCTION public.declare_weather_emergency(uuid, text, text) IS
  'Manager-only declaration of a league-wide weather emergency; creates makeup-pending records for scheduled real-team matches on the date.';

COMMIT;
