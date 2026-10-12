-- Phase 3, plan 3.1: the journey model, its versions, runs, and the step log.
--
-- A journey is a versioned graph (lib/journeys/graph.ts validates it). Editing
-- a live journey publishes a new row in lp.journey_versions; runs already in
-- flight keep the version they entered on. Each lead in a journey is one row in
-- lp.journey_runs with its current node and the time it is next due. The
-- runner (lib/journeys/runner.ts, op run_journeys) advances due runs with
-- FOR UPDATE SKIP LOCKED and writes every step to lp.journey_steps_log.
--
-- Add-only and idempotent: every statement is safe to run twice. Nothing here
-- sends email; send steps arrive with plan 3.9.

create table if not exists lp.journeys (
  id               bigint generated always as identity primary key,
  name             text not null check (length(name) between 1 and 120),
  status           text not null default 'draft'
                     check (status in ('draft', 'testing', 'live', 'paused', 'sunset')),
  campaign_id      bigint references lp.campaigns(id) on delete set null,
  -- Optional 3.2 trigger that enrols leads. The runner reads lp.trigger_fires
  -- past trigger_cursor (the last fire id it consumed for this journey).
  trigger_id       bigint references lp.triggers(id) on delete set null,
  trigger_cursor   bigint not null default 0,
  -- 'once': a lead enters at most once ever. 'multiple': again after the last run ends.
  entry_mode       text not null default 'once' check (entry_mode in ('once', 'multiple')),
  goal             jsonb not null default '{}'::jsonb check (jsonb_typeof(goal) = 'object'),
  settings         jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  current_version  integer,
  created_by       text references lp.actors(id),
  updated_by       text references lp.actors(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists journeys_trigger_idx on lp.journeys (trigger_id) where trigger_id is not null;

-- Owner approval. A send-capable node kind will not run until the run's version
-- is approved (journey_approve, owner only). Approval is per version: publishing
-- a new version needs a new approval.
alter table lp.journeys add column if not exists approved_version integer;
alter table lp.journeys add column if not exists approved_by     text references lp.actors(id);
alter table lp.journeys add column if not exists approved_at    timestamptz;

drop trigger if exists journeys_updated on lp.journeys;
create trigger journeys_updated before update on lp.journeys for each row execute function lp.touch_updated_at();

create table if not exists lp.journey_versions (
  journey_id    bigint not null references lp.journeys(id) on delete cascade,
  version       integer not null check (version >= 1),
  graph         jsonb not null check (jsonb_typeof(graph) = 'object'),
  note          text check (note is null or length(note) <= 500),
  published_by  text references lp.actors(id),
  published_at  timestamptz not null default now(),
  primary key (journey_id, version)
);

create table if not exists lp.journey_runs (
  id               bigint generated always as identity primary key,
  journey_id       bigint not null references lp.journeys(id) on delete cascade,
  version          integer not null,
  company_id       bigint,
  contact_id       bigint,
  node_id          text not null check (length(node_id) between 1 and 64),
  node_entered_at  timestamptz not null default now(),
  status           text not null default 'active'
                     check (status in ('active', 'waiting', 'done', 'exited', 'goal', 'error')),
  next_run_at      timestamptz,
  entered_at       timestamptz not null default now(),
  finished_at      timestamptz,
  source           text not null default 'manual' check (source in ('manual', 'segment', 'trigger', 'api')),
  trigger_fire_id  bigint,
  context          jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  last_error       text check (last_error is null or length(last_error) <= 1000),
  created_by       text references lp.actors(id),
  updated_at       timestamptz not null default now(),
  constraint journey_runs_lead_check check (company_id is not null or contact_id is not null),
  constraint journey_runs_version_fk foreign key (journey_id, version)
    references lp.journey_versions (journey_id, version)
);

-- How many times a handler has thrown on this run in a row. The runner retries
-- up to three times (lib/journeys/runner.ts), then the run goes to 'error'.
alter table lp.journey_runs add column if not exists attempts integer not null default 0 check (attempts >= 0);

-- The runner's queue: open runs by due time.
create index if not exists journey_runs_due_idx on lp.journey_runs (next_run_at)
  where status in ('active', 'waiting');
create index if not exists journey_runs_journey_idx on lp.journey_runs (journey_id, status);
create index if not exists journey_runs_company_idx on lp.journey_runs (company_id) where company_id is not null;
create index if not exists journey_runs_contact_idx on lp.journey_runs (contact_id) where contact_id is not null;
-- One open run per lead per journey, and one run per trigger fire.
create unique index if not exists journey_runs_open_lead_uq
  on lp.journey_runs (journey_id, coalesce(company_id, 0), coalesce(contact_id, 0))
  where status in ('active', 'waiting');
create unique index if not exists journey_runs_fire_uq
  on lp.journey_runs (journey_id, trigger_fire_id) where trigger_fire_id is not null;

drop trigger if exists journey_runs_updated on lp.journey_runs;
create trigger journey_runs_updated before update on lp.journey_runs for each row execute function lp.touch_updated_at();

create table if not exists lp.journey_steps_log (
  id          bigint generated always as identity primary key,
  run_id      bigint not null references lp.journey_runs(id) on delete cascade,
  journey_id  bigint not null,
  version     integer not null,
  node_id     text not null,
  action      text not null check (length(action) between 1 and 64),
  result      jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  actor       text,
  at          timestamptz not null default now()
);

create index if not exists journey_steps_log_run_idx on lp.journey_steps_log (run_id, id);
create index if not exists journey_steps_log_journey_idx on lp.journey_steps_log (journey_id, at desc);

insert into lp.event_types (key, label, category, source) values
  ('journey_entered',  'Entered a journey',  'lifecycle', 'runner'),
  ('journey_finished', 'Left a journey',     'lifecycle', 'runner')
on conflict (key) do nothing;

-- The OVH runner calls run_journeys every minute (kind ops_call, like
-- trigger_scan). It only advances journeys that are live, testing or sunset.
insert into lp.jobs (name, kind, description, schedule_cron, timezone, enabled, timeout_s, payload, next_run_at)
values (
  'journey_tick',
  'ops_call',
  'Plan 3.1: enrol leads from trigger fires and advance due journey runs. Does not send email.',
  '* * * * *',
  'UTC',
  true,
  120,
  '{"op":"run_journeys","args":{}}'::jsonb,
  now()
)
on conflict (name) do nothing;
