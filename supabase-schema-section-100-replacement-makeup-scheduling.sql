-- Section 100 / Rule 8.8: schedule replacement-team makeups for post-dropout BYE weeks.
-- Captures immutable BYE/opponent eligibility, creates manager-approved makeup fixtures,
-- preserves those fixtures across future IBA schedule imports, and tracks completion.

BEGIN;

ALTER TABLE public.team_replacement_resolutions
  ADD COLUMN IF NOT EXISTS eligible_makeup_weeks jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Correct the Section 98 week_num column reference and return only actual
-- post-dropout BYE weeks established by paired before/after IBA snapshots.
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
AS $section98$
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

  IF NOT EXISTS (SELECT 1 FROM public.seasons WHERE id = p_season_id AND is_active = true) THEN
    RAISE EXCEPTION 'ACTIVE_SEASON_REQUIRED';
  END IF;

  SELECT dropout_team_id INTO v_dropout_team_id
  FROM public.team_dropout_resolutions
  WHERE id = p_dropout_resolution_id
    AND season_id = p_season_id
    AND division_id = p_division_id
    AND status = 'applied';

  IF v_dropout_team_id IS NULL THEN RAISE EXCEPTION 'DROPOUT_RESOLUTION_NOT_FOUND'; END IF;

  SELECT name INTO v_dropout_name FROM public.teams
  WHERE id = v_dropout_team_id AND division_id = p_division_id AND coalesce(is_bye,false) = false;

  SELECT name INTO v_replacement_name FROM public.teams
  WHERE id = p_replacement_team_id AND division_id = p_division_id
    AND coalesce(is_bye,false) = false AND id <> v_dropout_team_id;

  IF v_replacement_name IS NULL THEN RAISE EXCEPTION 'REPLACEMENT_TEAM_NOT_FOUND'; END IF;

  SELECT id INTO v_bye_team_id FROM public.teams
  WHERE division_id = p_division_id AND coalesce(is_bye,false) = true
  ORDER BY id LIMIT 1;

  WITH import_pairs AS (
    SELECT after_snap.id AS after_id,
      before_snap.schedule_state AS before_state,
      after_snap.schedule_state AS after_state
    FROM public.iba_schedule_import_snapshots after_snap
    JOIN public.iba_schedule_import_snapshots before_snap
      ON before_snap.import_id = after_snap.import_id AND before_snap.phase = 'before'
    WHERE after_snap.phase = 'after'
      AND after_snap.season_id = p_season_id
      AND after_snap.division_id = p_division_id
      AND after_snap.created_at >= p_effective_date::timestamptz
  ),
  before_pairings AS (
    SELECT ip.after_id, (bw->>'week')::integer AS week, bw->>'date' AS date_text, bp AS pairing
    FROM import_pairs ip
    CROSS JOIN LATERAL jsonb_array_elements(ip.before_state->'weeks') bw
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(bw->'pairings','[]'::jsonb)) bp
    WHERE coalesce((bw->>'isPlayoff')::boolean,false) = false
      AND (bp->>'homeTeamId' = v_dropout_team_id::text OR bp->>'awayTeamId' = v_dropout_team_id::text)
  ),
  after_pairings AS (
    SELECT ip.after_id, (aw->>'week')::integer AS week, ap AS pairing
    FROM import_pairs ip
    CROSS JOIN LATERAL jsonb_array_elements(ip.after_state->'weeks') aw
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(aw->'pairings','[]'::jsonb)) ap
    WHERE coalesce((aw->>'isPlayoff')::boolean,false) = false
  ),
  created_byes AS (
    SELECT DISTINCT bp.week
    FROM before_pairings bp
    JOIN after_pairings ap ON ap.after_id = bp.after_id AND ap.week = bp.week
    WHERE (
      (bp.pairing->>'homeTeamId' = v_dropout_team_id::text
       AND (ap.pairing->>'awayTeamId' = v_bye_team_id::text OR ap.pairing->>'awayTbdCode' = 'BYE')
       AND ap.pairing->>'homeTeamId' = bp.pairing->>'awayTeamId')
      OR
      (bp.pairing->>'awayTeamId' = v_dropout_team_id::text
       AND (ap.pairing->>'homeTeamId' = v_bye_team_id::text OR ap.pairing->>'homeTbdCode' = 'BYE')
       AND ap.pairing->>'awayTeamId' = bp.pairing->>'homeTeamId')
    )
  )
  SELECT coalesce(jsonb_agg(sw.id ORDER BY sw.date, sw.week_num),'[]'::jsonb), count(*)
  INTO v_week_ids, v_week_count
  FROM created_byes cb
  JOIN public.schedule_weeks sw
    ON sw.division_id = p_division_id
   AND sw.week_num = cb.week
   AND to_date(sw.date,'MM/DD/YYYY') >= p_effective_date
   AND coalesce(sw.is_playoff,false) = false
   AND COALESCE(sw.special,'') NOT LIKE 'REPLACEMENT_MAKEUP:%';

  RETURN jsonb_build_object(
    'dropoutTeamId',v_dropout_team_id,'dropoutTeamName',v_dropout_name,
    'replacementTeamId',p_replacement_team_id,'replacementTeamName',v_replacement_name,
    'effectiveDate',p_effective_date,'eligibleMakeupWeekCount',least(v_week_count,3),
    'eligibleMakeupWeekIds',coalesce(
      (SELECT jsonb_agg(value) FROM jsonb_array_elements(v_week_ids) WITH ORDINALITY AS x(value,ord) WHERE ord <= 3),
      '[]'::jsonb)
  );
END;
$section98$;

REVOKE ALL ON FUNCTION public.preview_team_replacement_resolution(uuid,uuid,uuid,uuid,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_team_replacement_resolution(uuid,uuid,uuid,uuid,date)
  TO authenticated;

-- Backfill eligible week details for existing resolutions while their original
-- schedule-week rows are still available. The stored week IDs remain the audit
-- source; these details make the entitlement resilient to later IBA re-imports.
UPDATE public.team_replacement_resolutions r
SET eligible_makeup_weeks = COALESCE((
  SELECT jsonb_agg(
    jsonb_build_object(
      'sourceByeWeekId', sw.id,
      'sourceWeekNum', sw.week_num,
      'sourceWeekDate', sw.date,
      'opponentTeamId', opponent.id,
      'opponentName', opponent.name,
      'opponentWasHome', NOT (
        sp.home_team_id = bye.id
        OR upper(COALESCE(sp.home_tbd_code, '')) = 'BYE'
      )
    )
    ORDER BY sw.week_num, sw.date
  )
  FROM jsonb_array_elements_text(r.eligible_makeup_week_ids) AS ids(week_id)
  JOIN public.schedule_weeks sw
    ON sw.id = ids.week_id::uuid
   AND sw.division_id = r.division_id
  JOIN public.schedule_pairings sp ON sp.week_id = sw.id
  LEFT JOIN LATERAL (
    SELECT t.id
    FROM public.teams t
    WHERE t.division_id = r.division_id AND COALESCE(t.is_bye,false) = true
    ORDER BY t.id
    LIMIT 1
  ) bye ON true
  JOIN public.teams opponent
    ON opponent.id = CASE
      WHEN sp.home_team_id = bye.id OR upper(COALESCE(sp.home_tbd_code,'')) = 'BYE'
        THEN sp.away_team_id
      ELSE sp.home_team_id
    END
  WHERE (
    sp.home_team_id = bye.id
    OR sp.away_team_id = bye.id
    OR upper(COALESCE(sp.home_tbd_code,'')) = 'BYE'
    OR upper(COALESCE(sp.away_tbd_code,'')) = 'BYE'
  )
), '[]'::jsonb)
WHERE r.eligible_makeup_weeks = '[]'::jsonb
  AND jsonb_array_length(r.eligible_makeup_week_ids) > 0;

ALTER TABLE public.team_replacement_resolutions
  DROP CONSTRAINT IF EXISTS team_replacement_resolutions_eligible_makeup_weeks_array_chk;
ALTER TABLE public.team_replacement_resolutions
  ADD CONSTRAINT team_replacement_resolutions_eligible_makeup_weeks_array_chk
  CHECK (jsonb_typeof(eligible_makeup_weeks) = 'array');

-- New replacement resolutions capture the actual opponent and BYE-side orientation
-- at decision time, rather than depending on mutable schedule-week IDs later.
CREATE OR REPLACE FUNCTION public.capture_replacement_makeup_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_weeks jsonb;
  v_expected integer;
BEGIN
  v_expected := jsonb_array_length(COALESCE(NEW.eligible_makeup_week_ids, '[]'::jsonb));

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'sourceByeWeekId', sw.id,
      'sourceWeekNum', sw.week_num,
      'sourceWeekDate', sw.date,
      'opponentTeamId', opponent.id,
      'opponentName', opponent.name,
      'opponentWasHome', NOT (
        sp.home_team_id = bye.id
        OR upper(COALESCE(sp.home_tbd_code, '')) = 'BYE'
      )
    )
    ORDER BY sw.week_num, sw.date
  ), '[]'::jsonb)
  INTO v_weeks
  FROM jsonb_array_elements_text(COALESCE(NEW.eligible_makeup_week_ids, '[]'::jsonb)) AS ids(week_id)
  JOIN public.schedule_weeks sw
    ON sw.id = ids.week_id::uuid
   AND sw.division_id = NEW.division_id
  JOIN public.schedule_pairings sp ON sp.week_id = sw.id
  LEFT JOIN LATERAL (
    SELECT t.id
    FROM public.teams t
    WHERE t.division_id = NEW.division_id AND COALESCE(t.is_bye,false) = true
    ORDER BY t.id
    LIMIT 1
  ) bye ON true
  JOIN public.teams opponent
    ON opponent.id = CASE
      WHEN sp.home_team_id = bye.id OR upper(COALESCE(sp.home_tbd_code,'')) = 'BYE'
        THEN sp.away_team_id
      ELSE sp.home_team_id
    END
  WHERE (
    sp.home_team_id = bye.id
    OR sp.away_team_id = bye.id
    OR upper(COALESCE(sp.home_tbd_code,'')) = 'BYE'
    OR upper(COALESCE(sp.away_tbd_code,'')) = 'BYE'
  );

  IF jsonb_array_length(v_weeks) <> v_expected THEN
    RAISE EXCEPTION 'REPLACEMENT_MAKEUP_ELIGIBILITY_SNAPSHOT_MISSING';
  END IF;

  UPDATE public.team_replacement_resolutions
  SET eligible_makeup_weeks = v_weeks
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_replacement_makeup_eligibility()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS capture_replacement_makeup_eligibility
  ON public.team_replacement_resolutions;
CREATE TRIGGER capture_replacement_makeup_eligibility
  AFTER INSERT ON public.team_replacement_resolutions
  FOR EACH ROW
  EXECUTE FUNCTION public.capture_replacement_makeup_eligibility();

CREATE TABLE IF NOT EXISTS public.team_replacement_makeup_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replacement_resolution_id uuid NOT NULL
    REFERENCES public.team_replacement_resolutions(id) ON DELETE RESTRICT,
  source_bye_week_id uuid NOT NULL,
  source_week_num integer,
  source_week_date text NOT NULL,
  opponent_team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  scheduled_date date NOT NULL,
  schedule_week_id uuid NOT NULL REFERENCES public.schedule_weeks(id) ON DELETE RESTRICT,
  schedule_pairing_id uuid NOT NULL UNIQUE REFERENCES public.schedule_pairings(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'scheduled',
  scheduled_by uuid NOT NULL REFERENCES auth.users(id),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_replacement_makeup_matches_status_chk
    CHECK (status IN ('scheduled','completed','voided')),
  CONSTRAINT team_replacement_makeup_matches_source_unique
    UNIQUE (replacement_resolution_id, source_bye_week_id)
);

CREATE INDEX IF NOT EXISTS idx_team_replacement_makeup_matches_resolution
  ON public.team_replacement_makeup_matches(replacement_resolution_id, scheduled_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_weeks_replacement_makeup_date_unique
  ON public.schedule_weeks(division_id, date)
  WHERE special LIKE 'REPLACEMENT_MAKEUP:%';

ALTER TABLE public.team_replacement_makeup_matches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.team_replacement_makeup_matches FROM anon, authenticated;
GRANT SELECT ON public.team_replacement_makeup_matches TO authenticated;

DROP POLICY IF EXISTS team_replacement_makeup_matches_manager_select
  ON public.team_replacement_makeup_matches;
CREATE POLICY team_replacement_makeup_matches_manager_select
  ON public.team_replacement_makeup_matches
  FOR SELECT TO authenticated
  USING (public.current_role_name() = 'manager');

CREATE OR REPLACE FUNCTION public.schedule_team_replacement_makeup(
  p_replacement_resolution_id uuid,
  p_source_bye_week_id uuid,
  p_scheduled_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_resolution public.team_replacement_resolutions%rowtype;
  v_slot jsonb;
  v_opponent_id uuid;
  v_opponent_was_home boolean;
  v_date_text text;
  v_final_regular_date date;
  v_week_id uuid;
  v_week_num integer;
  v_pairing_id uuid;
  v_makeup_id uuid;
  v_existing public.team_replacement_makeup_matches%rowtype;
  v_used integer;
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

  IF NOT EXISTS (
    SELECT 1 FROM public.team_replacement_schedule_applications
    WHERE replacement_resolution_id = v_resolution.id
      AND status = 'applied'
  ) THEN
    RAISE EXCEPTION 'REPLACEMENT_SCHEDULE_MUST_BE_APPLIED_FIRST';
  END IF;

  SELECT value
    INTO v_slot
  FROM jsonb_array_elements(COALESCE(v_resolution.eligible_makeup_weeks, '[]'::jsonb)) AS slots(value)
  WHERE value->>'sourceByeWeekId' = p_source_bye_week_id::text
  LIMIT 1;

  IF v_slot IS NULL THEN
    RAISE EXCEPTION 'MAKEUP_WEEK_NOT_ELIGIBLE';
  END IF;

  SELECT *
    INTO v_existing
  FROM public.team_replacement_makeup_matches
  WHERE replacement_resolution_id = v_resolution.id
    AND source_bye_week_id = p_source_bye_week_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'already_scheduled',
      'makeupMatchId', v_existing.id,
      'schedulePairingId', v_existing.schedule_pairing_id
    );
  END IF;

  SELECT count(*)
    INTO v_used
  FROM public.team_replacement_makeup_matches
  WHERE replacement_resolution_id = v_resolution.id
    AND status <> 'voided';

  IF v_used >= LEAST(v_resolution.makeup_matches_allowed, 3) THEN
    RAISE EXCEPTION 'THREE_MAKEUP_LIMIT_REACHED';
  END IF;

  IF p_scheduled_date IS NULL OR p_scheduled_date < current_date THEN
    RAISE EXCEPTION 'MAKEUP_DATE_MUST_NOT_BE_IN_THE_PAST';
  END IF;

  SELECT max(to_date(sw.date, 'MM/DD/YYYY'))
    INTO v_final_regular_date
  FROM public.schedule_weeks sw
  WHERE sw.division_id = v_resolution.division_id
    AND COALESCE(sw.is_playoff,false) = false
    AND COALESCE(sw.special,'') NOT LIKE 'REPLACEMENT_MAKEUP:%';

  IF v_final_regular_date IS NULL THEN
    RAISE EXCEPTION 'FINAL_REGULAR_SEASON_DATE_UNAVAILABLE';
  END IF;

  IF p_scheduled_date > (v_final_regular_date - 7) THEN
    RAISE EXCEPTION 'MAKEUP_CUTOFF_WITHIN_SEVEN_DAYS_OF_FINAL_REGULAR_SEASON';
  END IF;

  v_date_text := to_char(p_scheduled_date, 'FMMM/FMDD/YYYY');

  IF EXISTS (
    SELECT 1
    FROM public.schedule_weeks sw
    WHERE sw.division_id = v_resolution.division_id
      AND to_date(sw.date, 'MM/DD/YYYY') = p_scheduled_date
      AND COALESCE(sw.special,'') NOT LIKE 'REPLACEMENT_MAKEUP:%'
  ) THEN
    RAISE EXCEPTION 'MAKEUP_DATE_CONFLICTS_WITH_REGULAR_SCHEDULE';
  END IF;

  v_opponent_id := (v_slot->>'opponentTeamId')::uuid;
  v_opponent_was_home := COALESCE((v_slot->>'opponentWasHome')::boolean, true);

  IF NOT EXISTS (
    SELECT 1 FROM public.teams
    WHERE id = v_opponent_id
      AND division_id = v_resolution.division_id
      AND COALESCE(is_bye,false) = false
  ) THEN
    RAISE EXCEPTION 'MAKEUP_OPPONENT_NOT_FOUND';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.schedule_weeks sw
    JOIN public.schedule_pairings sp ON sp.week_id = sw.id
    WHERE sw.division_id = v_resolution.division_id
      AND to_date(sw.date, 'MM/DD/YYYY') = p_scheduled_date
      AND (
        sp.home_team_id IN (v_resolution.replacement_team_id, v_opponent_id)
        OR sp.away_team_id IN (v_resolution.replacement_team_id, v_opponent_id)
      )
  ) THEN
    RAISE EXCEPTION 'MAKEUP_TEAM_ALREADY_SCHEDULED_ON_DATE';
  END IF;

  SELECT id
    INTO v_week_id
  FROM public.schedule_weeks
  WHERE division_id = v_resolution.division_id
    AND date = v_date_text
    AND special LIKE 'REPLACEMENT_MAKEUP:%'
  ORDER BY id
  LIMIT 1
  FOR UPDATE;

  IF v_week_id IS NULL THEN
    SELECT COALESCE(max(week_num),0) + 1
      INTO v_week_num
    FROM public.schedule_weeks
    WHERE division_id = v_resolution.division_id
      AND COALESCE(is_playoff,false) = false
      AND COALESCE(special,'') NOT LIKE 'REPLACEMENT_MAKEUP:%';

    INSERT INTO public.schedule_weeks (
      division_id, week_num, date, special, is_playoff, playoff_label
    )
    VALUES (
      v_resolution.division_id,
      v_week_num,
      v_date_text,
      'REPLACEMENT_MAKEUP: Replacement-team makeups',
      false,
      NULL
    )
    RETURNING id INTO v_week_id;
  END IF;

  INSERT INTO public.schedule_pairings (week_id, home_team_id, away_team_id)
  VALUES (
    v_week_id,
    CASE WHEN v_opponent_was_home THEN v_opponent_id ELSE v_resolution.replacement_team_id END,
    CASE WHEN v_opponent_was_home THEN v_resolution.replacement_team_id ELSE v_opponent_id END
  )
  RETURNING id INTO v_pairing_id;

  INSERT INTO public.team_replacement_makeup_matches (
    replacement_resolution_id, source_bye_week_id, source_week_num,
    source_week_date, opponent_team_id, scheduled_date,
    schedule_week_id, schedule_pairing_id, scheduled_by
  )
  VALUES (
    v_resolution.id,
    p_source_bye_week_id,
    NULLIF(v_slot->>'sourceWeekNum','')::integer,
    v_slot->>'sourceWeekDate',
    v_opponent_id,
    p_scheduled_date,
    v_week_id,
    v_pairing_id,
    auth.uid()
  )
  RETURNING id INTO v_makeup_id;

  UPDATE public.team_replacement_resolutions
  SET makeup_matches_used = v_used + 1
  WHERE id = v_resolution.id;

  RETURN jsonb_build_object(
    'ok', true,
    'status', 'scheduled',
    'makeupMatchId', v_makeup_id,
    'schedulePairingId', v_pairing_id,
    'scheduleWeekId', v_week_id,
    'scheduledDate', p_scheduled_date,
    'sourceWeekNum', NULLIF(v_slot->>'sourceWeekNum','')::integer,
    'opponentTeamId', v_opponent_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_team_replacement_makeup(uuid,uuid,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_team_replacement_makeup(uuid,uuid,date)
  TO authenticated;

-- Keep the manager's separately scheduled makeup fixtures when an IBA schedule
-- is re-imported. Completed matches continue to reference their original pairing.
CREATE OR REPLACE FUNCTION public.sync_team_replacement_makeup_match_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pairing_id text;
BEGIN
  v_pairing_id := NEW.state->>'schedulePairingId';
  IF v_pairing_id IS NULL
     OR v_pairing_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}

  UPDATE public.team_replacement_makeup_matches
  SET status = CASE WHEN NEW.is_makeup_pending THEN 'scheduled' ELSE 'completed' END
  WHERE schedule_pairing_id = v_pairing_id::uuid
    AND status <> 'voided';

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_team_replacement_makeup_match_status()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_team_replacement_makeup_match_status
  ON public.completed_matches;
CREATE TRIGGER sync_team_replacement_makeup_match_status
  AFTER INSERT OR UPDATE OF state, is_makeup_pending
  ON public.completed_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_team_replacement_makeup_match_status();

COMMIT;
 THEN
    RETURN NEW;
  END IF;

  UPDATE public.team_replacement_makeup_matches
  SET status = CASE WHEN NEW.is_makeup_pending THEN 'scheduled' ELSE 'completed' END
  WHERE schedule_pairing_id = v_pairing_id::uuid
    AND status <> 'voided';

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_team_replacement_makeup_match_status()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_team_replacement_makeup_match_status
  ON public.completed_matches;
CREATE TRIGGER sync_team_replacement_makeup_match_status
  AFTER INSERT OR UPDATE OF state, is_makeup_pending
  ON public.completed_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_team_replacement_makeup_match_status();

COMMIT;
