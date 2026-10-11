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
-- lp.campaigns.pool also stops being a fixed list (it was jeweler / ai_agency /
-- ai_builder / other): any lowercase slug is accepted now. Existing values are
-- unchanged.

alter table lp.campaigns drop constraint if exists campaigns_pool_check;
alter table lp.campaigns add constraint campaigns_pool_check check (pool ~ '^[a-z][a-z0-9_]{0,40}$');

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
                 'negative_keyword'  -- words that exclude a lead or article
               )),
  name         text not null check (length(name) between 1 and 200),
  value        text check (value is null or length(value) <= 2000),     -- URL, domain, query ... per kind
  config       jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  status       text not null default 'approved' check (status in ('suggested', 'approved', 'rejected', 'archived')),
  source       text not null default 'human' check (source in ('human', 'ai', 'agent', 'import', 'copied')),
  rationale    text check (rationale is null or length(rationale) <= 1000),  -- why the AI suggested it
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
