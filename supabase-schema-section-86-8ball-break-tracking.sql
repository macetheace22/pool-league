-- Section 86: Track a Rack 8-ball break details
-- Adds durable fields to shot_events so 8-ball break type and balls made
-- survive reloads and are available to league/practice stats.
alter table public.shot_events
  add column if not exists is_eight_ball_break boolean not null default false,
  add column if not exists balls_made_on_break integer;

alter table public.shot_events
  drop constraint if exists shot_events_balls_made_on_break_check;

alter table public.shot_events
  add constraint shot_events_balls_made_on_break_check
  check (
    balls_made_on_break is null
    or (balls_made_on_break >= 0 and balls_made_on_break <= 8)
  );

comment on column public.shot_events.is_eight_ball_break is
  'Whether a break event was an 8-ball break.';
comment on column public.shot_events.balls_made_on_break is
  'Number of object balls made on an 8-ball break; null for non-8-ball breaks.';

-- Keep the same explicit Data API access convention used by this project.
grant select, insert, update, delete on table public.shot_events to authenticated;
