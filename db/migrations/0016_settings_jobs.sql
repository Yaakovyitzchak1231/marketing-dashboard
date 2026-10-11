-- Phase 1 foundation, part 1 (Oct 10, 2026): settings, secrets, agent kinds, jobs.
--
--   lp.settings   non-secret workspace settings (timezone, quiet-hours defaults,
--                 sheet ids, feature switches ...). One row per key; value is JSON.
--                 Agents may read these over the ops API with their own key.
--   lp.secrets    API keys and webhook secrets, encrypted by the app with
--                 AES-256-GCM (node:crypto) under one env key, SETTINGS_KEY.
--                 Only ciphertext + the last 4 characters are stored; nothing
--                 here is ever readable over the ops API or sent to a browser.
--   lp.actors.takes_kinds  which task kinds an agent picks up (empty = any).
--   lp.jobs       the background runner's job list (on the OVH box): what runs,
--                 on what cron schedule, optionally for one campaign.
--   lp.job_runs   one row per run: when, who ran it, how it ended.
--
-- Additive only: nothing existing is altered except one new column on lp.actors.

create table if not exists lp.settings (
  key         text primary key check (key ~ '^[a-z][a-z0-9_.]{0,79}$'),
  value       jsonb not null,
  description text check (description is null or length(description) <= 500),
  updated_by  text references lp.actors(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists settings_updated on lp.settings;
create trigger settings_updated before update on lp.settings for each row execute function lp.touch_updated_at();

create table if not exists lp.secrets (
  key         text primary key check (key ~ '^[a-z][a-z0-9_.]{0,79}$'),
  ciphertext  text not null,                 -- base64, AES-256-GCM
  iv          text not null,                 -- base64, 12 bytes
  tag         text not null,                 -- base64, 16-byte auth tag
  last4       text check (last4 is null or length(last4) <= 4),
  updated_by  text references lp.actors(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists secrets_updated on lp.secrets;
create trigger secrets_updated before update on lp.secrets for each row execute function lp.touch_updated_at();

alter table lp.actors add column if not exists takes_kinds text[] not null default '{}';

create table if not exists lp.jobs (
  name           text primary key check (name ~ '^[a-z][a-z0-9_.:-]{0,79}$'),
  kind           text not null check (kind ~ '^[a-z][a-z0-9_]{0,60}$'),  -- handler name in the runner
  description    text check (description is null or length(description) <= 500),
  schedule_cron  text check (schedule_cron is null or length(schedule_cron) <= 100), -- null = run on demand only
  timezone       text not null default 'America/New_York',
  campaign_id    bigint references lp.campaigns(id) on delete cascade,   -- null = workspace-wide
  payload        jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  enabled        boolean not null default true,
  timeout_s      integer not null default 600 check (timeout_s between 1 and 86400),
  next_run_at    timestamptz,
  last_run_at    timestamptz,
  last_status    text check (last_status is null or last_status in ('running', 'ok', 'failed', 'skipped', 'timeout')),
  last_error     text,
  locked_by      text,                        -- runner instance id holding the job
  locked_until   timestamptz,
  created_by     text references lp.actors(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists jobs_due_idx on lp.jobs (next_run_at) where enabled;
create index if not exists jobs_campaign_idx on lp.jobs (campaign_id) where campaign_id is not null;
drop trigger if exists jobs_updated on lp.jobs;
create trigger jobs_updated before update on lp.jobs for each row execute function lp.touch_updated_at();

create table if not exists lp.job_runs (
  id           bigint generated always as identity primary key,
  job_name     text not null references lp.jobs(name) on delete cascade,
  campaign_id  bigint references lp.campaigns(id) on delete set null,
  runner       text,                          -- runner instance id (host:pid)
  actor        text references lp.actors(id), -- the actor the runner authenticated as ('system')
  status       text not null default 'running' check (status in ('running', 'ok', 'failed', 'skipped', 'timeout')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  output       jsonb,                         -- counts / summary the handler returned
  error        text
);
create index if not exists job_runs_job_idx on lp.job_runs (job_name, started_at desc);
create index if not exists job_runs_status_idx on lp.job_runs (status, started_at desc);
