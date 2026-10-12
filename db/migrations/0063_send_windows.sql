-- 0063: per-lead send-time optimisation -- plan 3.11. Full description: docs/SEND_TIME.md.
--
--   lp.lead_send_windows      each lead's optimal send window, learned from its
--                             engagement history in lp.lead_events: the hour of
--                             day (lead-local) and the weekday (Mon-Fri) it
--                             engages most. Only replies and clicks count,
--                             weighted (reply 3, click 2); opens are excluded.
--   lp.campaign_send_windows  the same learned over all of a campaign's leads:
--                             the fallback for a lead without a window.
--   lp.jobs 'sendtime_recompute'  the nightly relearn (generic ops_call job).
--
-- Lead keys: 'company:<id>' or 'contact:<id>', the shape main already uses for
-- lp.trigger_watch.member_key (0053). lib/sendtime/lead-key.ts is the one
-- helper that builds and parses them.
--
-- Both tables are derived caches (rebuilt by the nightly job), so an earlier
-- draft of this migration that already ran somewhere is simply dropped and
-- recreated below.
--
-- Add-only otherwise: no existing object is touched.

do $$
begin
  if to_regclass('lp.lead_send_windows') is not null
     and not exists (select 1 from information_schema.columns
                      where table_schema = 'lp' and table_name = 'lead_send_windows' and column_name = 'last_engagement') then
    drop table lp.lead_send_windows;
  end if;
end
$$;

create table if not exists lp.lead_send_windows (
  lead_key        text primary key check (lead_key ~ '^(company|contact):[0-9]+$'),
  -- Hour of day in `timezone` when engagement peaks (0-23). The scheduler
  -- clamps it into 8:00-18:00 before using it.
  best_hour       smallint not null check (best_hour between 0 and 23),
  -- Weekday with the most engagement: 1 = Monday .. 5 = Friday. Never a
  -- weekend day (business outreach); null = no weekday clearly wins.
  best_dow        smallint check (best_dow is null or best_dow between 1 and 5),
  timezone        text not null default 'America/New_York',
  -- 'default' = America/New_York was assumed (no lead timezone is known);
  -- 'lead' = a real timezone was supplied for this lead.
  timezone_source text not null default 'default' check (timezone_source in ('default', 'lead')),
  -- Engagement events (replies + clicks) the window was learned from.
  sample_size     integer not null check (sample_size >= 0),
  -- occurred_at of the newest event used. A window whose newest evidence is
  -- older than 180 days is treated as absent.
  last_engagement timestamptz not null,
  -- 'own' = the lead's own events; 'company' = a contact with too little of
  -- its own evidence, learned from its company's events.
  basis           text not null default 'own' check (basis in ('own', 'company')),
  updated_at      timestamptz not null default now()
);

create table if not exists lp.campaign_send_windows (
  campaign_id     bigint primary key references lp.campaigns(id) on delete cascade,
  best_hour       smallint not null check (best_hour between 0 and 23),
  best_dow        smallint check (best_dow is null or best_dow between 1 and 5),
  timezone        text not null default 'America/New_York',
  timezone_source text not null default 'default' check (timezone_source in ('default', 'lead')),
  sample_size     integer not null check (sample_size >= 0),
  last_engagement timestamptz not null,
  updated_at      timestamptz not null default now()
);

-- Nightly relearn. The generic ops_call handler (runner/handlers/ops_call.mjs)
-- runs the sendtime_recompute op as the 'system' actor. next_run_at is set
-- because lp.jobs only claims rows that have one: the next 03:17 UTC.
-- Idempotent: on conflict (name) do nothing.
delete from lp.jobs where name = 'sendtime_relearn' and kind = 'sendtime_recompute'; -- stray draft seed: kind had no runner handler

insert into lp.jobs (name, kind, description, schedule_cron, timezone, enabled, timeout_s, payload, next_run_at)
values (
  'sendtime_recompute',
  'ops_call',
  'Plan 3.11: nightly relearn of per-lead and per-campaign send windows from replies and clicks. Writes lp.lead_send_windows and lp.campaign_send_windows; does not send.',
  '17 3 * * *',
  'UTC',
  true,
  900,
  '{"op":"sendtime_recompute","args":{}}'::jsonb,
  ((case when (now() at time zone 'UTC')::time < time '03:17'
         then date_trunc('day', now() at time zone 'UTC') + interval '3 hours 17 minutes'
         else date_trunc('day', now() at time zone 'UTC') + interval '1 day 3 hours 17 minutes' end) at time zone 'UTC')
)
on conflict (name) do nothing;
