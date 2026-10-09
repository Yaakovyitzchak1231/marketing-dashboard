-- Campaigns workspace (Oct 9, 2026). A campaign is a first-class object in the
-- lead database: you can start one, give it a pool and rules, build its lead
-- list and work it from the dashboard or the ops API. Whether it ever reaches
-- Instantly is a separate, human-approved step; nothing in here talks to Instantly.
--
--   lp.campaign_statuses  the status list (draft / active / paused / archived), a
--                         config table so a status can be added without a deploy
--   lp.campaigns          one row per campaign
--   lp.campaign_leads     a campaign's lead list (companies), with per-lead
--                         personalization overrides (key -> value)
--   lp.companies.tags     free tags on a lead, so lead lists can be built by tag
--
-- rule_set_id points at lp.rule_sets (migration 0010, the rules PR). NULL means
-- "use the pool's rule set". Merge order is 0010 -> 0011, and then the foreign
-- key is added below. If this ran first anyway, the column stays unchecked and
-- the app treats an id it can't find as "use the pool's rule set".

create table if not exists lp.campaign_statuses (
  id          text primary key check (id ~ '^[a-z][a-z0-9_]{0,30}$'),
  label       text not null check (length(label) between 1 and 40),
  sort        integer not null default 100,
  is_archived boolean not null default false,  -- campaigns in this status are hidden from the default list
  active      boolean not null default true,   -- false = no longer pickable (rows that use it keep it)
  created_by  text references lp.actors(id),
  created_at  timestamptz not null default now()
);
insert into lp.campaign_statuses (id, label, sort, is_archived) values
  ('draft',    'Draft',    10, false),
  ('active',   'Active',   20, false),
  ('paused',   'Paused',   30, false),
  ('archived', 'Archived', 90, true)
on conflict (id) do nothing;

create table if not exists lp.campaigns (
  id           bigint generated always as identity primary key,
  name         text not null check (length(name) between 1 and 120),
  pool         text not null default 'jeweler' check (pool in ('jeweler', 'ai_agency', 'ai_builder', 'other')),
  goal         text check (goal is null or length(goal) <= 500),
  notes        text check (notes is null or length(notes) <= 5000),
  owner        text references lp.actors(id),
  status       text not null default 'draft' references lp.campaign_statuses(id),
  rule_set_id  bigint,                         -- lp.rule_sets(id); null = the pool's rule set
  based_on     bigint references lp.campaigns(id) on delete set null,
  is_template  boolean not null default false,
  created_by   text references lp.actors(id),
  updated_by   text references lp.actors(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists campaigns_status_idx on lp.campaigns (status, updated_at desc);
create index if not exists campaigns_pool_idx on lp.campaigns (pool);
drop trigger if exists campaigns_updated on lp.campaigns;
create trigger campaigns_updated before update on lp.campaigns for each row execute function lp.touch_updated_at();

create table if not exists lp.campaign_leads (
  campaign_id  bigint not null references lp.campaigns(id) on delete cascade,
  company_id   bigint not null references lp.companies(id) on delete cascade,
  contact_id   bigint references lp.contacts(id) on delete set null,  -- pinned contact; null = the rules' pick
  overrides    jsonb not null default '{}'::jsonb check (jsonb_typeof(overrides) = 'object'),
  note         text check (note is null or length(note) <= 2000),
  added_via    text not null default 'hand' check (added_via in ('filter', 'hand', 'copy', 'api')),
  added_by     text references lp.actors(id),
  added_at     timestamptz not null default now(),
  updated_by   text references lp.actors(id),
  updated_at   timestamptz not null default now(),
  primary key (campaign_id, company_id)
);
create index if not exists campaign_leads_company_idx on lp.campaign_leads (company_id);
drop trigger if exists campaign_leads_updated on lp.campaign_leads;
create trigger campaign_leads_updated before update on lp.campaign_leads for each row execute function lp.touch_updated_at();

alter table lp.companies add column if not exists tags text[] not null default '{}';
create index if not exists companies_tags_idx on lp.companies using gin (tags);

-- Link to the rules PR's rule sets when they exist (see the header).
do $$
begin
  if to_regclass('lp.rule_sets') is not null
     and not exists (select 1 from pg_constraint where conname = 'campaigns_rule_set_fk') then
    alter table lp.campaigns add constraint campaigns_rule_set_fk
      foreign key (rule_set_id) references lp.rule_sets(id) on delete set null;
  end if;
end $$;
