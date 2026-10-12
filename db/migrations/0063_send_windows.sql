-- 0063: per-lead send-time optimisation -- plan 3.11.
--
--   lp.lead_send_windows  each lead's optimal send window, learned from its
--                        engagement history (opens, clicks, replies in
--                        lp.lead_events): the hour of day (lead-local) and day
--                        of week the lead engages most, plus how much evidence
--                        backs it. The journey scheduler (plan 3.1) calls
--                        lib/sendtime resolveSendTime when dispatching timed
--                        steps, so a step due Tuesday 9am for a night-owl lead
--                        goes out in that lead's best window instead.
--
-- Lead keys follow the existing convention (see 0053 trigger_watch and 0061
-- experiment_assignments): 'company:<id>' or 'contact:<id>'.
--
-- Add-only: no existing object is touched.

create table if not exists lp.lead_send_windows (
  lead_key    text primary key check (lead_key ~ '^(company|contact):[0-9]+$'),
  -- Hour of day in the lead's own timezone when engagement peaks (0-23).
  best_hour   smallint not null check (best_hour between 0 and 23),
  -- Day of week with the most engagement, 0 = Sunday (null = no clear day).
  best_dow    smallint check (best_dow is null or best_dow between 0 and 6),
  timezone    text not null default 'America/New_York',
  -- How many engagement events the window was learned from.
  sample_size integer not null check (sample_size >= 0),
  updated_at  timestamptz not null default now()
);
