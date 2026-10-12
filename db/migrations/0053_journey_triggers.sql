-- Phase 3, plan 3.2: trigger definitions and the fire log.
--
-- A trigger watches for one kind of moment (an event, a segment entry or exit,
-- a field change, a date, a schedule, or an API call) and writes one row to
-- lp.trigger_fires when it happens. The journey runner (plan 3.1, not built
-- yet) consumes that log. This file does not create journey tables and does
-- not add a journey_id column, so it cannot collide with 3.1's schema.
--
-- The seeded job is kind ops_call, which the OVH runner already knows: every
-- 15 minutes it calls scan_due_triggers. That op evaluates date triggers,
-- schedule triggers, and segment entry/exit (including dynamic segments,
-- which do not emit segment_joined themselves). Event, field-change and API
-- triggers fire in the same transaction as the write that caused them.

create table if not exists lp.triggers (
  id           bigint generated always as identity primary key,
  name         text not null check (length(name) between 1 and 120),
  kind         text not null check (kind in (
                 'event', 'segment_entry', 'segment_exit', 'field_change', 'date', 'schedule', 'api'
               )),
  campaign_id  bigint references lp.campaigns(id) on delete cascade,
  config       jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  enabled      boolean not null default true,
  token_hash   text,
  created_by   text references lp.actors(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists triggers_kind_enabled_idx on lp.triggers (kind) where enabled;

create table if not exists lp.trigger_fires (
  id          bigint generated always as identity primary key,
  trigger_id  bigint not null references lp.triggers(id) on delete cascade,
  company_id  bigint,
  contact_id  bigint,
  fired_at    timestamptz not null default now(),
  payload     jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  dedupe_key  text
);

create unique index if not exists trigger_fires_dedupe_uq on lp.trigger_fires (dedupe_key) where dedupe_key is not null;
create index if not exists trigger_fires_trigger_idx on lp.trigger_fires (trigger_id, fired_at desc);

-- Who a segment trigger last saw inside the segment. Entry fires when a member
-- appears here; exit fires when a member disappears. Re-entry works because
-- leaving deletes the row.
create table if not exists lp.trigger_watch (
  trigger_id  bigint not null references lp.triggers(id) on delete cascade,
  member_key  text not null check (member_key ~ '^(company|contact):[0-9]+$'),
  seen_at     timestamptz not null default now(),
  primary key (trigger_id, member_key)
);

drop trigger if exists triggers_updated on lp.triggers;
create trigger triggers_updated before update on lp.triggers for each row execute function lp.touch_updated_at();

insert into lp.jobs (name, kind, description, schedule_cron, timezone, enabled, timeout_s, payload, next_run_at)
values (
  'trigger_scan',
  'ops_call',
  'Plan 3.2: evaluate date, schedule, and segment entry/exit triggers. Writes lp.trigger_fires; does not send.',
  '*/15 * * * *',
  'UTC',
  true,
  300,
  '{"op":"scan_due_triggers","args":{}}'::jsonb,
  now()
)
on conflict (name) do nothing;
