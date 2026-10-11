-- Phase 1 foundation, part 5 (Oct 10, 2026): campaign profiles.
--
-- Everything in the dashboard is campaign-agnostic: nothing is hard-coded to one
-- industry. Each campaign (lp.campaigns) gets a profile that tells every feature
-- what to look for: the target industry and ICP, keywords, competitors, news
-- feeds, forums, lead directories, trade shows, buying-signal rules, tech
-- fingerprints, social channels, newsletter list, UTM conventions and KPIs.
--
--   lp.campaign_profiles       one row per campaign: the scalar/JSON parts.
--   lp.campaign_profile_items  the lists (one row per competitor, feed, keyword,
--                              directory, signal rule ...), each with a status so
--                              the AI-assisted setup can SUGGEST items and a human
--                              approves or rejects them. Only 'approved' items are
--                              used by the monitors, connectors and signal jobs.
--
--   lp.pools                   pools (industries / audiences) are ROWS now, not a
--                              fixed list in CHECK constraints. The four existing
--                              values are seeded; adding a campaign for a new
--                              industry adds a pool row. lp.companies.segment,
--                              lp.campaign_meta.segment, lp.rule_sets.segment and
--                              lp.campaigns.pool all reference it.
--
-- Profile items suggested by the AI are checked before they are shown (a feed
-- returns recent items, a page loads, a subreddit exists, a directory is reachable
-- and robots.txt allows it): verify_status / verify_detail / verified_at.

create table if not exists lp.pools (
  id          text primary key check (id ~ '^[a-z][a-z0-9_]{0,40}$'),
  label       text not null check (length(label) between 1 and 80),
  description text check (description is null or length(description) <= 1000),
  sort        integer not null default 100,
  active      boolean not null default true,   -- false = not offered for new campaigns; rows keep it
  created_by  text references lp.actors(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists pools_updated on lp.pools;
create trigger pools_updated before update on lp.pools for each row execute function lp.touch_updated_at();
insert into lp.pools (id, label, sort) values
  ('jeweler',    'Jewelers',    10),
  ('ai_agency',  'AI agencies', 20),
  ('ai_builder', 'AI builders', 30),
  ('other',      'Other',       90)
on conflict (id) do nothing;
-- Any value already stored (in case one slipped past an old constraint) gets a row.
insert into lp.pools (id, label)
select distinct v, initcap(replace(v, '_', ' ')) from (
  select pool as v from lp.campaigns
  union select segment from lp.companies
  union select segment from lp.campaign_meta
  union select segment from lp.rule_sets
) x where v is not null and v ~ '^[a-z][a-z0-9_]{0,40}$'
on conflict (id) do nothing;

alter table lp.campaigns     drop constraint if exists campaigns_pool_check;
alter table lp.companies     drop constraint if exists companies_segment_check;
alter table lp.campaign_meta drop constraint if exists campaign_meta_segment_check;
alter table lp.rule_sets     drop constraint if exists rule_sets_segment_check;
alter table lp.campaigns     drop constraint if exists campaigns_pool_fk;
alter table lp.companies     drop constraint if exists companies_segment_fk;
alter table lp.campaign_meta drop constraint if exists campaign_meta_segment_fk;
alter table lp.rule_sets     drop constraint if exists rule_sets_segment_fk;
alter table lp.campaigns     add constraint campaigns_pool_fk      foreign key (pool)    references lp.pools(id) on update cascade;
alter table lp.companies     add constraint companies_segment_fk   foreign key (segment) references lp.pools(id) on update cascade;
alter table lp.campaign_meta add constraint campaign_meta_segment_fk foreign key (segment) references lp.pools(id) on update cascade;
alter table lp.rule_sets     add constraint rule_sets_segment_fk   foreign key (segment) references lp.pools(id) on update cascade;

create table if not exists lp.campaign_profiles (
  campaign_id      bigint primary key references lp.campaigns(id) on delete cascade,
  industry         text check (industry is null or length(industry) between 1 and 120),
  vertical         text check (vertical is null or length(vertical) between 1 and 120),
  description      text check (description is null or length(description) <= 4000),
  -- Ideal customer profile: {"business_types":[], "size":{"employees_min":..,"employees_max":..,
  -- "revenue_min":..}, "geographies":[], "roles":[], "exclude":[]}
  icp              jsonb not null default '{}'::jsonb check (jsonb_typeof(icp) = 'object'),
  value_prop       text check (value_prop is null or length(value_prop) <= 2000),
  newsletter_list  text check (newsletter_list is null or length(newsletter_list) <= 200),  -- Listmonk list id/name
  -- UTM conventions: {"source":"...", "medium":"...", "campaign":"...", "content_rule":"..."}
  utm              jsonb not null default '{}'::jsonb check (jsonb_typeof(utm) = 'object'),
  -- KPIs and goals: [{"metric":"reply_rate","target":0.05,"period":"month"}, ...]
  kpis             jsonb not null default '[]'::jsonb check (jsonb_typeof(kpis) = 'array'),
  setup_status     text not null default 'draft' check (setup_status in ('draft', 'suggested', 'reviewed', 'active')),
  ai_last_suggested_at timestamptz,
  ai_model         text,                    -- which free model made the last suggestions
  created_by       text references lp.actors(id),
  updated_by       text references lp.actors(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists campaign_profiles_updated on lp.campaign_profiles;
create trigger campaign_profiles_updated before update on lp.campaign_profiles for each row execute function lp.touch_updated_at();

create table if not exists lp.campaign_profile_items (
  id           bigint generated always as identity primary key,
  campaign_id  bigint not null references lp.campaigns(id) on delete cascade,
  kind         text not null check (kind in (
                 'keyword',          -- search/trend keywords
                 'topic',            -- broader topics for news/trends
                 'competitor',       -- name + domain; config: {"newsroom_url","changelog_url","pricing_url","ads_library_url"}
                 'feed',             -- RSS/Atom/news search feed; value = feed URL
                 'forum',            -- subreddit / forum / community; value = URL or r/name
                 'directory',        -- lead-source directory or association; config = connector settings
                 'trade_show',       -- event / exhibitor list; config: {"dates","exhibitor_list_url"}
                 'signal_rule',      -- buying-signal rule; config: {"type":"tech_change|hiring|filing|page_change|review|funding|new_location", ...}
                 'fingerprint',      -- tech fingerprint to detect on a lead's site; config: {"patterns":[...]}
                 'social_channel',   -- e.g. LinkedIn page, X handle; config: {"network","handle"}
                 'negative_keyword', -- words that exclude a lead or article
                 'search_phrase',    -- find-leads search query (maps/web), e.g. "independent jeweler"
                 'place_category'    -- business category for map/directory searches
               )),
  name         text not null check (length(name) between 1 and 200),
  value        text check (value is null or length(value) <= 2000),     -- URL, domain, query ... per kind
  config       jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  status       text not null default 'approved' check (status in ('suggested', 'approved', 'rejected', 'archived')),
  source       text not null default 'human' check (source in ('human', 'ai', 'agent', 'import', 'copied')),
  rationale    text check (rationale is null or length(rationale) <= 1000),  -- why the AI suggested it
  verify_status text not null default 'unchecked' check (verify_status in ('unchecked', 'ok', 'failed', 'not_applicable')),
  verify_detail text check (verify_detail is null or length(verify_detail) <= 1000), -- e.g. "12 items, newest Oct 9" / "robots.txt disallows /members"
  verified_at  timestamptz,
  sort         integer not null default 100,
  created_by   text references lp.actors(id),
  updated_by   text references lp.actors(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists campaign_profile_items_uq
  on lp.campaign_profile_items (campaign_id, kind, lower(name)) where status <> 'archived';
create index if not exists campaign_profile_items_kind_idx
  on lp.campaign_profile_items (kind, status, campaign_id);
drop trigger if exists campaign_profile_items_updated on lp.campaign_profile_items;
create trigger campaign_profile_items_updated before update on lp.campaign_profile_items for each row execute function lp.touch_updated_at();
