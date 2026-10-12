-- 0061: A/B experiments for journey (campaign) steps -- plan 3.6.
--
--   lp.experiments             one experiment per campaign step: which variants
--                             exist, their traffic weights, and whether the
--                             winner is picked automatically.
--   lp.experiment_assignments one row per lead per experiment: the variant the
--                             lead was routed into (written by the ab_split
--                             journey node; deterministic, so re-runs agree).
--   lp.experiment_outcomes     per-variant counters (sends, replies) the
--                             auto-winner evaluation reads. Written by
--                             record_outcome (the journey runner / sync jobs
--                             call it); the dashboard UI can also record them
--                             by hand.
--
-- Add-only: no existing object is touched.

create table if not exists lp.experiments (
  id             bigint generated always as identity primary key,
  campaign_id    bigint not null references lp.campaigns(id) on delete cascade,
  step_number    integer not null check (step_number between 1 and 1000),
  name           text not null check (length(name) between 1 and 120),
  status         text not null default 'draft'
                   check (status in ('draft', 'running', 'paused', 'decided')),
  -- {variants: [{key, weight}], auto_winner: bool, min_sends_per_variant: int}
  config         jsonb not null default '{"variants":[{"key":"A","weight":50},{"key":"B","weight":50}],"auto_winner":true,"min_sends_per_variant":100}'::jsonb
                   check (jsonb_typeof(config) = 'object'),
  winner_variant text,
  decided_at     timestamptz,
  decided_by     text references lp.actors(id),
  created_by     text references lp.actors(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One experiment per step per campaign: the ab_split node addresses the
  -- experiment by (campaign, step), so this must be unambiguous.
  unique (campaign_id, step_number)
);
create index if not exists experiments_campaign_idx on lp.experiments (campaign_id);
create index if not exists experiments_status_idx on lp.experiments (status) where status = 'running';
drop trigger if exists experiments_updated on lp.experiments;
create trigger experiments_updated before update on lp.experiments for each row execute function lp.touch_updated_at();

create table if not exists lp.experiment_assignments (
  id            bigint generated always as identity primary key,
  experiment_id bigint not null references lp.experiments(id) on delete cascade,
  company_id    bigint not null references lp.companies(id) on delete cascade,
  contact_id    bigint references lp.contacts(id) on delete set null,
  -- company_id:contact_id, so the unique index below also covers the
  -- null-contact case (plain UNIQUE treats nulls as distinct).
  lead_key      text generated always as (company_id::text || ':' || coalesce(contact_id::text, '0')) stored,
  variant       text not null,
  assigned_at   timestamptz not null default now(),
  unique (experiment_id, lead_key)
);
create index if not exists experiment_assignments_experiment_idx on lp.experiment_assignments (experiment_id);

create table if not exists lp.experiment_outcomes (
  experiment_id bigint not null references lp.experiments(id) on delete cascade,
  variant       text not null,
  sends         bigint not null default 0 check (sends >= 0),
  replies       bigint not null default 0 check (replies >= 0 and replies <= sends),
  updated_at    timestamptz not null default now(),
  primary key (experiment_id, variant)
);
