-- 0062: journey step log -- plan 3.8 (action library).
--
--   lp.step_log  one row per action execution: which journey step ran which
--               action on which lead, with the outcome. The action library
--               (lib/actions) writes here on every run, so the journey runner
--               (plan 3.1) and agents get a full audit trail of what was done
--               to each lead and when. Append-only.
--
-- Journeys are campaigns in this codebase (plan 3.1 renames nothing yet), so
-- the journey is campaign_id; step_key is the node id inside the journey
-- definition (e.g. the ab_split node id from plan 3.6).
--
-- Add-only: no existing object is touched.

create table if not exists lp.step_log (
  id          bigint generated always as identity primary key,
  campaign_id bigint references lp.campaigns(id) on delete cascade,
  step_key    text not null check (length(step_key) between 1 and 120),
  company_id  bigint references lp.companies(id) on delete set null,
  contact_id  bigint references lp.contacts(id) on delete set null,
  action      text not null check (length(action) between 1 and 80),
  status      text not null check (status in ('ok','failed','skipped')),
  input       jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  result      jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  error       text,
  actor       text references lp.actors(id),
  created_at  timestamptz not null default now()
);
create index if not exists step_log_campaign_idx on lp.step_log (campaign_id, created_at desc);
create index if not exists step_log_lead_idx on lp.step_log (company_id, contact_id, created_at desc);
create index if not exists step_log_action_idx on lp.step_log (action, created_at desc);
