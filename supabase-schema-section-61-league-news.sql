-- Section 61: manager-published league news.
-- Drafts are visible only to managers; published announcements are visible
-- to signed-in league members. Table access is explicitly granted because
-- new public tables are no longer automatically exposed through the Data API.

BEGIN;

CREATE TABLE IF NOT EXISTS public.league_news (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 12000),
  is_published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT league_news_published_timestamp_check
    CHECK (NOT is_published OR published_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS league_news_published_order_idx
  ON public.league_news (published_at DESC)
  WHERE is_published = true;

ALTER TABLE public.league_news ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.league_news FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.league_news TO authenticated;

CREATE POLICY "League members read published news; managers read all"
  ON public.league_news
  FOR SELECT TO authenticated
  USING (
    is_published = true
    OR public.current_role_name() = 'manager'
  );

CREATE POLICY "Managers create league news"
  ON public.league_news
  FOR INSERT TO authenticated
  WITH CHECK (public.current_role_name() = 'manager');

CREATE POLICY "Managers update league news"
  ON public.league_news
  FOR UPDATE TO authenticated
  USING (public.current_role_name() = 'manager')
  WITH CHECK (public.current_role_name() = 'manager');

CREATE POLICY "Managers delete league news"
  ON public.league_news
  FOR DELETE TO authenticated
  USING (public.current_role_name() = 'manager');

COMMIT;
