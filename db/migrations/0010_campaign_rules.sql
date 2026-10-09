-- 0010: lead rules per pool and per campaign, editable from the dashboard.
--
--   lp.rule_sets         one set of rules: the default, one per pool (segment),
--                        one per campaign that has its own, and templates.
--                        requirements = what a lead must meet to be Ready;
--                        fields       = personalization fields (merge values).
--                        Both are ordered JSON arrays, validated by the app
--                        (lib/rules/schema.ts). Every save bumps version.
--   lp.lead_evaluations  the evaluator's verdict per rule set per lead (company):
--                        ready_personalized | ready_generic | parked, with the
--                        rules that failed (park reasons) and the merge values.
--                        Rows are marked stale by trigger when the lead changes.
--   lp.rule_recompute    a full re-score of one rule set after a save: done in
--                        batches by company id, resumable, never blocking a page.
--
-- Also: the 'ai_builder' pool, and lp.enrichment.last_checked_at so freshness
-- rules ("fact checked within N days") have a real date to read.
-- Standing rules (holds never rejected, only Ready uploads, verifier order) are
-- code, not rows: nothing here can switch them off.

-- ---------------------------------------------------------------- ai_builder pool
alter table lp.companies drop constraint if exists companies_segment_check;
alter table lp.companies add constraint companies_segment_check check (segment in ('jeweler', 'ai_agency', 'ai_builder', 'other'));
alter table lp.campaign_meta drop constraint if exists campaign_meta_segment_check;
alter table lp.campaign_meta add constraint campaign_meta_segment_check check (segment in ('jeweler', 'ai_agency', 'ai_builder', 'other'));

-- ---------------------------------------------------------------- owner research exhausted
-- Yaakov, Oct 9 2026: a role inbox (role-based-hold) becomes sendable once the
-- search for the owner's own email is marked exhausted for that store. It then
-- scores Ready-generic (no-name copy) and goes out only in its own "role-inbox"
-- batches. Until this is set, role-based-hold stays parked.
alter table lp.companies add column if not exists owner_research_exhausted_at timestamptz;
alter table lp.companies add column if not exists owner_research_exhausted_by text references lp.actors(id);
alter table lp.companies add column if not exists owner_research_note text;
alter table lp.companies drop constraint if exists companies_owner_research_exhausted_complete;
alter table lp.companies add constraint companies_owner_research_exhausted_complete
  check ((owner_research_exhausted_at is null) = (owner_research_exhausted_by is null));

-- ---------------------------------------------------------------- fact freshness
-- created_at = when the fact was first found; last_checked_at = when someone last
-- confirmed it still holds (re-found by research or import, or checked by hand).
alter table lp.enrichment add column if not exists last_checked_at timestamptz;
alter table lp.enrichment add column if not exists last_checked_by text references lp.actors(id);
update lp.enrichment set last_checked_at = created_at where last_checked_at is null;
alter table lp.enrichment alter column last_checked_at set default now();
alter table lp.enrichment alter column last_checked_at set not null;
create index if not exists enrichment_company_field_idx on lp.enrichment (company_id, field);

-- ---------------------------------------------------------------- rule sets
create table if not exists lp.rule_sets (
  id             bigint generated always as identity primary key,
  name           text not null check (length(name) between 1 and 120),
  scope          text not null check (scope in ('default', 'pool', 'campaign', 'template')),
  segment        text check (segment in ('jeweler', 'ai_agency', 'ai_builder', 'other')),
  campaign_id    text,
  campaign_name  text,
  requirements   jsonb not null default '[]'::jsonb check (jsonb_typeof(requirements) = 'array'),
  fields         jsonb not null default '[]'::jsonb check (jsonb_typeof(fields) = 'array'),
  version        integer not null default 1,
  based_on       bigint references lp.rule_sets(id) on delete set null,
  archived       boolean not null default false,
  created_by     text references lp.actors(id),
  updated_by     text references lp.actors(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (scope <> 'pool' or segment is not null),
  -- campaign_id: an Instantly campaign id (or other text key). Optional: a dashboard
  -- campaign (lp.campaigns, 0011) owns its set through lp.campaigns.rule_set_id instead.
  check (scope = 'campaign' or campaign_id is null)
);
create unique index if not exists rule_sets_default_uq  on lp.rule_sets (scope) where scope = 'default';
create unique index if not exists rule_sets_pool_uq     on lp.rule_sets (segment) where scope = 'pool';
create unique index if not exists rule_sets_campaign_uq on lp.rule_sets (campaign_id) where scope = 'campaign' and not archived;
drop trigger if exists rule_sets_updated on lp.rule_sets;
create trigger rule_sets_updated before update on lp.rule_sets for each row execute function lp.touch_updated_at();

-- Only a human changes rules. Agents propose through Needs your OK (lp.approvals);
-- the human who applies a proposal is the one recorded here.
create or replace function lp.rule_sets_by_human_only() returns trigger language plpgsql as $$
begin
  if new.updated_by is null or not exists (select 1 from lp.actors h where h.id = new.updated_by and h.kind = 'human') then
    raise exception 'only a human can change lead rules (updated_by = %)', new.updated_by;
  end if;
  return new;
end $$;
drop trigger if exists rule_sets_human on lp.rule_sets;
create trigger rule_sets_human before insert or update on lp.rule_sets
  for each row when (pg_trigger_depth() = 0 and current_setting('lp.seeding', true) is distinct from 'on')
  execute function lp.rule_sets_by_human_only();

-- ---------------------------------------------------------------- evaluations
create table if not exists lp.lead_evaluations (
  rule_set_id    bigint not null references lp.rule_sets(id) on delete cascade,
  company_id     bigint not null references lp.companies(id) on delete cascade,
  contact_id     bigint references lp.contacts(id) on delete set null,
  tier           text not null check (tier in ('ready_personalized', 'ready_generic', 'parked')),
  reasons        jsonb not null default '[]'::jsonb,   -- [{rule, label, detail, standing}]
  merge          jsonb not null default '{}'::jsonb,   -- personalization values that would be sent
  missing        jsonb not null default '[]'::jsonb,   -- required fields with no real value (why generic)
  batch          text not null default 'standard' check (batch in ('standard', 'role-inbox')),
  version        integer not null,                     -- rule_sets.version it was scored against
  stale          boolean not null default false,       -- the lead changed since
  evaluated_at   timestamptz not null default now(),
  primary key (rule_set_id, company_id)
);
create index if not exists lead_evaluations_tier_idx    on lp.lead_evaluations (rule_set_id, tier);
create index if not exists lead_evaluations_company_idx on lp.lead_evaluations (company_id);
create index if not exists lead_evaluations_stale_idx   on lp.lead_evaluations (rule_set_id) where stale;

create table if not exists lp.rule_recompute (
  rule_set_id    bigint primary key references lp.rule_sets(id) on delete cascade,
  version        integer not null,
  status         text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  cursor         bigint not null default 0,            -- last company id scored
  processed      integer not null default 0,
  total          integer,
  requested_by   text references lp.actors(id),
  requested_at   timestamptz not null default now(),
  heartbeat_at   timestamptz,
  finished_at    timestamptz,
  error          text
);

-- A change to a lead marks its scores stale; the next recompute pass re-scores it.
create or replace function lp.mark_lead_evaluations_stale() returns trigger language plpgsql as $$
declare cid bigint;
begin
  if tg_table_name = 'companies' then
    cid := coalesce(new.id, old.id);
  elsif tg_op = 'DELETE' then
    cid := old.company_id;
  else
    cid := new.company_id;
    if tg_op = 'UPDATE' and old.company_id is distinct from new.company_id and old.company_id is not null then
      update lp.lead_evaluations set stale = true where company_id = old.company_id and not stale;
    end if;
  end if;
  if cid is not null then
    update lp.lead_evaluations set stale = true where company_id = cid and not stale;
  end if;
  return null;
end $$;
drop trigger if exists companies_eval_stale on lp.companies;
create trigger companies_eval_stale after update on lp.companies for each row
  when (old.* is distinct from new.*) execute function lp.mark_lead_evaluations_stale();
drop trigger if exists contacts_eval_stale on lp.contacts;
create trigger contacts_eval_stale after insert or update or delete on lp.contacts for each row execute function lp.mark_lead_evaluations_stale();
drop trigger if exists enrichment_eval_stale on lp.enrichment;
create trigger enrichment_eval_stale after insert or update or delete on lp.enrichment for each row execute function lp.mark_lead_evaluations_stale();

-- ---------------------------------------------------------------- seed
-- The default set reproduces today's Ready (verified valid email, not on hold,
-- not do-not-contact, not already sent), plus three personalization fields.
-- Each pool starts as a copy of it; a human edits from there.
select set_config('lp.seeding', 'on', false);

insert into lp.rule_sets (name, scope, requirements, fields)
select 'Default (any campaign without a pool)', 'default',
  '[{"id":"r-email-valid","label":"Email verified valid","enabled":true,"field":"contact.verification_status","op":"in","value":["valid"]}]'::jsonb,
  '[{"id":"f-first-name","name":"firstName","source":"contact.first_name","required":false,"fallback":null,"min_confidence":"medium","enabled":true},
    {"id":"f-company","name":"companyName","source":"company.name","required":false,"fallback":null,"enabled":true},
    {"id":"f-opener","name":"personalization","source":"contact.personalization","required":true,"fallback":null,"enabled":true}]'::jsonb
where not exists (select 1 from lp.rule_sets where scope = 'default');

insert into lp.rule_sets (name, scope, segment, requirements, fields, based_on)
select x.name, 'pool', x.segment, d.requirements, d.fields, d.id
  from (values ('Jewelers', 'jeweler'), ('AI agencies', 'ai_agency'), ('AI builders', 'ai_builder'), ('Other', 'other')) as x(name, segment)
  cross join (select id, requirements, fields from lp.rule_sets where scope = 'default') d
 where not exists (select 1 from lp.rule_sets r where r.scope = 'pool' and r.segment = x.segment);

insert into lp.rule_sets (name, scope, requirements, fields, based_on)
select 'Template: today''s rules', 'template', d.requirements, d.fields, d.id
  from lp.rule_sets d
 where d.scope = 'default' and not exists (select 1 from lp.rule_sets where scope = 'template');

-- Score everything once after deploy (the app runs these in batches).
insert into lp.rule_recompute (rule_set_id, version)
select id, version from lp.rule_sets where scope in ('default', 'pool')
on conflict (rule_set_id) do nothing;

select set_config('lp.seeding', 'off', false);
