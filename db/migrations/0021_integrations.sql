-- Phase 1 foundation, part 6 (Oct 11, 2026): the tools hub.
--
-- The tools Yaakov runs next to the dashboard (on his OVH server: Warmbly,
-- Listmonk, Miniflux, changedetection.io, Umami, ...) and the documents he works
-- from (build tracker, plan) are ROWS, not hard-coded links.
--
--   lp.integrations           one row per tool or link: name, kind, the URL to open,
--                             where its API is reachable from (the runner on OVH
--                             reaches tailnet-only URLs; Vercel cannot), which
--                             settings/secret keys hold its credentials, and the
--                             last health the runner saw.
--   lp.integration_snapshots  numbers the runner reads from each tool's API and
--                             writes through the ops API (subscribers per list,
--                             unread entries per feed category, page changes,
--                             visits by UTM ...). The dashboard only ever reads
--                             these rows; it never calls the tools directly.
--                             campaign_id ties a number to a campaign wherever the
--                             tool maps to one (Miniflux category, Listmonk list,
--                             changedetection tag, UTM campaign).

create table if not exists lp.integrations (
  id               text primary key check (id ~ '^[a-z][a-z0-9_-]{0,40}$'),
  name             text not null check (length(name) between 1 and 80),
  kind             text not null check (kind ~ '^[a-z][a-z0-9_]{0,40}$'),   -- warmbly, listmonk, miniflux, changedetection, umami, postiz, doc, sheet, link ...
  description      text check (description is null or length(description) <= 500),
  url              text check (url is null or url ~ '^https?://'),          -- what a person opens
  api_url          text check (api_url is null or api_url ~ '^https?://'),  -- what the runner calls
  reachable_from   text not null default 'public' check (reachable_from in ('public', 'tailnet', 'localhost')),
  settings_prefix  text check (settings_prefix is null or settings_prefix ~ '^[a-z][a-z0-9_.]{0,79}$'),  -- e.g. 'integrations.listmonk' → keys in lp.settings / lp.secrets
  visibility       text not null default 'owner' check (visibility in ('owner', 'team', 'hidden')),
  sort             integer not null default 100,
  active           boolean not null default true,
  health_status    text check (health_status is null or health_status in ('ok', 'degraded', 'down', 'unknown')),
  health_detail    text check (health_detail is null or length(health_detail) <= 500),
  health_checked_at timestamptz,
  created_by       text references lp.actors(id),
  updated_by       text references lp.actors(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists integrations_updated on lp.integrations;
create trigger integrations_updated before update on lp.integrations for each row execute function lp.touch_updated_at();

create table if not exists lp.integration_snapshots (
  id              bigint generated always as identity primary key,
  integration_id  text not null references lp.integrations(id) on delete cascade,
  campaign_id     bigint references lp.campaigns(id) on delete set null,
  metric          text not null check (metric ~ '^[a-z][a-z0-9_.]{0,63}$'),  -- e.g. listmonk.subscribers, miniflux.unread, changedetection.changes_24h
  value           numeric,                                                    -- null = the tool did not say (never coerce to 0)
  dims            jsonb not null default '{}'::jsonb check (jsonb_typeof(dims) = 'object'),  -- e.g. {"list":"Restaurants Q4"}
  data            jsonb,                                                      -- raw extra detail (latest items, etc.)
  taken_at        timestamptz not null default now(),
  job_run_id      bigint references lp.job_runs(id) on delete set null,
  source          text not null default 'runner'
);
create index if not exists integration_snapshots_latest_idx on lp.integration_snapshots (integration_id, metric, taken_at desc);
create index if not exists integration_snapshots_campaign_idx on lp.integration_snapshots (campaign_id, taken_at desc) where campaign_id is not null;
