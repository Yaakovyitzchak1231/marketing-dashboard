-- Lead platform, Phase 2 (additive to 0001-0003).
--
--   lp.campaign_meta     which segment and angle each Instantly campaign is, set
--                        by a human on the Costs / Runway screens. Nothing is
--                        guessed into this table; a campaign without a row is
--                        shown as "angle not set".
--   lp.monthly_costs     the editable monthly cost table (inboxes, tools,
--                        verification, data ...). A row with a campaign_id is
--                        that campaign's cost; a row without one is shared and is
--                        split across campaigns by emails sent (shown as such).
--   lp.instantly_actions every write the dashboard makes to Instantly on a
--                        human's click (add leads, pause, resume): the preview,
--                        who confirmed it, and Instantly's answer. A confirmed
--                        row is never sent twice.
--   lp.exports           each run of the read-only Lead Master copy (CSV or a new
--                        Sheet tab): when, how many rows, where it went.

create table if not exists lp.campaign_meta (
  campaign_id    text primary key,
  campaign_name  text,
  segment        text check (segment in ('jeweler', 'ai_agency', 'other')),
  angle          text check (angle is null or length(angle) between 1 and 80),
  updated_by     text references lp.actors(id),
  updated_at     timestamptz not null default now()
);

create table if not exists lp.monthly_costs (
  id           bigint generated always as identity primary key,
  month        date not null check (extract(day from month) = 1),   -- first day of the month
  category     text not null check (category in ('inboxes', 'tools', 'verification', 'data', 'other')),
  label        text not null check (length(label) between 1 and 120),
  amount_usd   numeric(10, 2) not null check (amount_usd >= 0),
  campaign_id  text,                       -- null = shared across campaigns
  notes        text,
  created_by   text references lp.actors(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists monthly_costs_uq on lp.monthly_costs (month, category, label, coalesce(campaign_id, ''));
create index if not exists monthly_costs_month_idx on lp.monthly_costs (month);
drop trigger if exists monthly_costs_updated on lp.monthly_costs;
create trigger monthly_costs_updated before update on lp.monthly_costs for each row execute function lp.touch_updated_at();

create table if not exists lp.instantly_actions (
  id             bigint generated always as identity primary key,
  kind           text not null check (kind in ('add_leads', 'pause', 'resume')),
  campaign_id    text not null,
  campaign_name  text,
  contact_ids    bigint[] not null default '{}',
  status         text not null default 'preview' check (status in ('preview', 'sending', 'done', 'failed', 'unknown', 'cancelled')),
  preview        jsonb,                    -- what the human saw before confirming
  result         jsonb,                    -- Instantly's answer, as returned (no key)
  error          text,
  created_by     text references lp.actors(id),
  confirmed_by   text references lp.actors(id),
  created_at     timestamptz not null default now(),
  confirmed_at   timestamptz,
  finished_at    timestamptz
);
create index if not exists instantly_actions_campaign_idx on lp.instantly_actions (campaign_id, created_at desc);

create table if not exists lp.exports (
  id           bigint generated always as identity primary key,
  kind         text not null default 'lead_master_copy',
  target       text not null check (target in ('csv', 'sheet')),
  destination  text,                       -- file path, or "<sheet id> / <tab>"
  row_count    integer,
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),
  error        text,
  created_by   text references lp.actors(id),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
