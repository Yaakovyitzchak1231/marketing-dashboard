-- 0061: A/B experiments for journey (campaign) steps -- plan 3.6.
--
--   lp.experiments             one experiment per campaign step: which variants
--                             exist, their traffic weights, and whether the
--                             winner is picked automatically.
--   lp.experiment_assignments one row per LEAD per experiment: the variant the
--                             lead was routed into (written by the ab_split
--                             journey node; deterministic, so re-runs agree).
--                             A lead is a company (the same identity the
--                             campaign lead list uses: lp.campaign_leads is keyed
--                             (campaign_id, company_id), a contact is only the
--                             person we write to), so one company has exactly one
--                             assignment per experiment however many contacts it
--                             has.
--   lp.experiment_outcomes     per-variant counters (sends, positive replies) the
--                             auto-winner evaluation reads. Written by
--                             record_outcome; the dashboard owner can also record
--                             them by hand.
--   lp.experiment_outcome_keys idempotency keys for outcome posts. The primary
--                             key makes "has this key been applied?" and "apply
--                             it" one atomic insert, so concurrent retries of the
--                             same post cannot double-count.
--
-- Add-only: no existing object is touched.

create table if not exists lp.experiments (
  id             bigint generated always as identity primary key,
  campaign_id    bigint not null references lp.campaigns(id) on delete cascade,
  step_number    integer not null check (step_number between 1 and 1000),
  name           text not null check (length(name) between 1 and 120),
  -- Allowed moves (enforced in lib/experiments/store.ts, compare-and-set):
  --   draft -> running, running <-> paused, running|paused -> decided.
  -- A decided experiment is final. Config (variants, weights) can only change
  -- while the experiment is a draft: once leads are assigned, changing it would
  -- orphan their assignments and outcomes.
  status         text not null default 'draft'
                   check (status in ('draft', 'running', 'paused', 'decided')),
  -- {variants: [{key, weight}], auto_winner: bool, min_sends_per_variant: int}
  -- Variant keys match ^[A-Za-z0-9_-]{1,32}$ (no ':' or spaces; the dashboard
  -- form writes them as key:weight).
  config         jsonb not null default '{"variants":[{"key":"A","weight":50},{"key":"B","weight":50}],"auto_winner":true,"min_sends_per_variant":100}'::jsonb
                   check (jsonb_typeof(config) = 'object'),
  winner_variant text,
  decided_at     timestamptz,
  decided_by     text references lp.actors(id),
  -- Peeking control for the auto-winner: how many sample-size "looks" the
  -- evaluation has already taken (see lib/experiments/winner.ts). A look is
  -- only taken when the smallest variant doubles its sample, and each look is
  -- Bonferroni-corrected for the maximum number of looks.
  evaluated_looks integer not null default 0 check (evaluated_looks between 0 and 20),
  created_by     text references lp.actors(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- INTENDED: one experiment per step per campaign. The ab_split node, the
  -- steps page and the winner logic all address an experiment by
  -- (campaign, step), and a step with two live experiments would have no single
  -- "which copy did this lead get" answer. To test something new on the same
  -- step, decide (or delete) the old experiment first.
  unique (campaign_id, step_number)
);
create index if not exists experiments_campaign_idx on lp.experiments (campaign_id);
create index if not exists experiments_status_idx on lp.experiments (status) where status = 'running';
drop trigger if exists experiments_updated on lp.experiments;
create trigger experiments_updated before update on lp.experiments for each row execute function lp.touch_updated_at();

create table if not exists lp.experiment_assignments (
  id            bigint generated always as identity primary key,
  experiment_id bigint not null references lp.experiments(id) on delete cascade,
  -- The lead identity: the (surviving) company. See the header note.
  company_id    bigint not null references lp.companies(id) on delete cascade,
  -- The contact the lead was first assigned through, for the record only.
  contact_id    bigint references lp.contacts(id) on delete set null,
  variant       text not null,
  assigned_at   timestamptz not null default now(),
  unique (experiment_id, company_id)
);
create index if not exists experiment_assignments_experiment_idx on lp.experiment_assignments (experiment_id);

create table if not exists lp.experiment_outcomes (
  experiment_id    bigint not null references lp.experiments(id) on delete cascade,
  variant          text not null,
  sends            bigint not null default 0 check (sends >= 0),
  -- POSITIVE replies only. Auto-replies, unsubscribes and negative replies are
  -- not wins and must never be counted here (the winner logic treats every
  -- counted reply as a win). Cumulative: positive_replies can never exceed sends.
  positive_replies bigint not null default 0 check (positive_replies >= 0),
  updated_at       timestamptz not null default now(),
  primary key (experiment_id, variant),
  constraint experiment_outcomes_replies_le_sends check (positive_replies <= sends)
);

create table if not exists lp.experiment_outcome_keys (
  experiment_id bigint not null references lp.experiments(id) on delete cascade,
  variant       text not null,
  key           text not null check (length(key) between 1 and 200),
  created_at    timestamptz not null default now(),
  primary key (experiment_id, variant, key)
);
