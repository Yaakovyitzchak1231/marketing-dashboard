-- Phase 2, slice P2-F part 1 (Oct 11, 2026): rule-based lead scoring with point expiry
-- (plan 2.8). Two kinds of score live beside the AI fit tiers (lib/rules/evaluate.ts
-- stays the Fit *gate*; this is the point-based score next to it, not a replacement):
--
--   Engagement  -- how much a lead has actually engaged (opens, clicks, replies, meetings).
--                  One default model, seeded below, used for every campaign.
--   Fit         -- how well a lead matches a campaign's ICP/buying-signal rules. A
--                  campaign with its own profile (lp.campaign_profiles / _items) gets its
--                  own Fit model built from that profile; campaign_id is null on the
--                  workspace default used until a campaign has one of its own.
--
-- lp.score_models    one row per model: entity it scores (company|contact), kind
--                    (engagement|fit), campaign_id (null = default for all campaigns),
--                    rules (jsonb array of {rule_key,label,event_type,points,expires_after_days?,
--                    props_match?}), thresholds (jsonb array of {key,label,min} e.g. "hot">=50),
--                    max_points (a soft cap; null = uncapped).
-- lp.score_points    one row per point award: which rule, how many points, when it expires
--                    (null = never). source_event_id ties it back to the lp.lead_events row
--                    that earned it, so "why did this score go up" is always answerable.
-- lp.scores          the current total per (model, lead), maintained by the engine
--                    (lib/scoring/engine.ts), not a DB trigger, because expiry needs a
--                    time-based recompute a trigger can't do on its own.
-- lp.score_history   one snapshot per (model, lead) per day a recompute ran, or whenever
--                    the score actually changed, for a simple trend line.
--
-- Campaign-agnostic: nothing here hard-codes an industry. The default Fit model's rules
-- are read at recompute time from the campaign's own lp.campaign_profiles.icp and the
-- 'signal_rule' rows in lp.campaign_profile_items (lib/scoring/rules.ts fitRulesFromProfile);
-- a campaign with no profile falls back to the workspace default Fit model (campaign_id null),
-- which starts with zero rules until the campaign gets one.

create table if not exists lp.score_models (
  id          bigint generated always as identity primary key,
  name        text not null check (length(name) between 1 and 120),
  entity      text not null check (entity in ('company', 'contact')),
  kind        text not null check (kind in ('engagement', 'fit')),
  campaign_id bigint references lp.campaigns(id) on delete cascade,  -- null = default, used for every campaign without its own
  -- [{rule_key, label, event_type, points, expires_after_days?, props_match?: {field: value}}]
  rules       jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
  -- [{key, label, min}] e.g. [{"key":"hot","label":"Hot","min":50}]
  thresholds  jsonb not null default '[]'::jsonb check (jsonb_typeof(thresholds) = 'array'),
  max_points  integer check (max_points is null or max_points > 0),
  active      boolean not null default true,
  created_by  text references lp.actors(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- At most one default (campaign_id null) model per entity+kind, and at most one
-- per-campaign model per entity+kind+campaign.
create unique index if not exists score_models_default_uq
  on lp.score_models (entity, kind) where campaign_id is null;
create unique index if not exists score_models_campaign_uq
  on lp.score_models (entity, kind, campaign_id) where campaign_id is not null;
create index if not exists score_models_campaign_idx on lp.score_models (campaign_id) where campaign_id is not null;
drop trigger if exists score_models_updated on lp.score_models;
create trigger score_models_updated before update on lp.score_models for each row execute function lp.touch_updated_at();

create table if not exists lp.score_points (
  id              bigint generated always as identity primary key,
  model_id        bigint not null references lp.score_models(id) on delete cascade,
  company_id      bigint references lp.companies(id) on delete cascade,
  contact_id      bigint references lp.contacts(id) on delete cascade,
  rule_key        text not null check (length(rule_key) between 1 and 80),
  points          integer not null,
  source_event_id bigint references lp.lead_events(id) on delete set null,
  awarded_at      timestamptz not null default now(),
  expires_at      timestamptz,
  constraint score_points_identity_check check (company_id is not null or contact_id is not null)
);
create index if not exists score_points_company_idx on lp.score_points (model_id, company_id) where company_id is not null;
create index if not exists score_points_contact_idx on lp.score_points (model_id, contact_id) where contact_id is not null;
create index if not exists score_points_expiry_idx  on lp.score_points (expires_at) where expires_at is not null;
-- A given event awards a given rule's points at most once (recompute is idempotent:
-- re-processing the same lead_events never double-awards).
create unique index if not exists score_points_dedupe_uq
  on lp.score_points (model_id, rule_key, source_event_id) where source_event_id is not null;

create table if not exists lp.scores (
  id          bigint generated always as identity primary key,
  model_id    bigint not null references lp.score_models(id) on delete cascade,
  company_id  bigint references lp.companies(id) on delete cascade,
  contact_id  bigint references lp.contacts(id) on delete cascade,
  score       integer not null default 0,
  updated_at  timestamptz not null default now(),
  constraint scores_identity_check check (company_id is not null or contact_id is not null)
);
create unique index if not exists scores_company_uq on lp.scores (model_id, company_id) where company_id is not null and contact_id is null;
create unique index if not exists scores_contact_uq on lp.scores (model_id, contact_id) where contact_id is not null;

create table if not exists lp.score_history (
  id          bigint generated always as identity primary key,
  model_id    bigint not null references lp.score_models(id) on delete cascade,
  company_id  bigint references lp.companies(id) on delete cascade,
  contact_id  bigint references lp.contacts(id) on delete cascade,
  score       integer not null,
  recorded_at timestamptz not null default now(),
  constraint score_history_identity_check check (company_id is not null or contact_id is not null)
);
create index if not exists score_history_company_idx on lp.score_history (model_id, company_id, recorded_at desc) where company_id is not null;
create index if not exists score_history_contact_idx on lp.score_history (model_id, contact_id, recorded_at desc) where contact_id is not null;

-- A new event type: threshold crossings become a lead event, so journeys (later)
-- can trigger off them exactly like any other event.
insert into lp.event_types (key, label, category, source) values
  ('score_threshold_crossed', 'Score threshold crossed', 'signal', 'runner')
on conflict (key) do nothing;

-- Scoring UI edits (rename a model, change its rules) go through the universal
-- audit log; add the new entity type to the whitelist (drop + re-add with the
-- full list, as lib/edit/registry.ts requires).
alter table lp.status_history drop constraint if exists status_history_entity_type_check;
alter table lp.status_history add constraint status_history_entity_type_check
  check (entity_type in ('company', 'contact', 'task', 'campaign', 'campaign_lead', 'campaign_profile',
                         'actor', 'setting', 'suppression', 'job', 'pool', 'integration', 'event_type',
                         'deal', 'segment', 'journey', 'score_model'));

-- The default Engagement model (used for every campaign): +10 replied, +5 clicked,
-- +2 opened (expires in 30 days so a stale open stops counting), +15 meeting booked,
-- -20 bounced. Nothing industry-specific.
insert into lp.score_models (name, entity, kind, campaign_id, rules, thresholds, max_points)
select 'Default Engagement', 'company', 'engagement', null,
  '[
    {"rule_key":"replied",       "label":"Replied",            "event_type":"reply_received",       "points":10},
    {"rule_key":"clicked",       "label":"Clicked a link",     "event_type":"email_link_clicked",   "points":5},
    {"rule_key":"opened",        "label":"Opened an email",    "event_type":"email_opened",         "points":2, "expires_after_days":30},
    {"rule_key":"meeting",       "label":"Meeting booked",     "event_type":"meeting_booked",       "points":15},
    {"rule_key":"bounced",       "label":"Bounced",            "event_type":"email_bounced",        "points":-20}
  ]'::jsonb,
  '[{"key":"hot","label":"Hot","min":25},{"key":"warm","label":"Warm","min":10}]'::jsonb,
  null
where not exists (select 1 from lp.score_models where entity = 'company' and kind = 'engagement' and campaign_id is null);

-- The default Fit model (workspace-wide fallback): zero rules until a campaign gets
-- its own profile-derived Fit model (lib/scoring/rules.ts builds those rules from
-- lp.campaign_profiles / lp.campaign_profile_items at recompute time; see engine.ts
-- fitModelForCampaign, which creates a per-campaign row here on first use).
insert into lp.score_models (name, entity, kind, campaign_id, rules, thresholds, max_points)
select 'Default Fit', 'company', 'fit', null, '[]'::jsonb,
  '[{"key":"strong_fit","label":"Strong fit","min":20}]'::jsonb, null
where not exists (select 1 from lp.score_models where entity = 'company' and kind = 'fit' and campaign_id is null);

-- Register the nightly refresh so it shows on the Jobs screen; the external runner
-- (Yaakov's OVH box) picks up due jobs by name/kind through the existing job-runner
-- ops (claim_due_jobs) and should call recompute_scores for each row it claims here.
-- Code + seed only, per the Phase 2 brief: lib/scoring/engine.ts#recomputeAllScores
-- is the function the kind 'score_refresh' runs.
insert into lp.jobs (name, kind, description, schedule_cron, timezone, enabled, timeout_s)
select 'score_refresh', 'score_refresh', 'Recompute Engagement and Fit scores for every lead (expires stale points, re-sums, logs threshold crossings).', '0 3 * * *', 'America/New_York', true, 1800
where not exists (select 1 from lp.jobs where name = 'score_refresh');
